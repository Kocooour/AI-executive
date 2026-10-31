import type { SyncScheduler } from "./client";
import type {
  CommandRequest, CommandStatus, ConflictCode, FeedItem, FeedPage, TargetSyncTransport, TitleRequest, TransportResult,
} from "./transport";

/** Deterministic clock and timers for tests: nothing runs unless `advance` is called. */
export class FakeScheduler implements SyncScheduler {
  private time = 1_700_000_000_000;
  private nextId = 1;
  private readonly timers = new Map<number, { at: number; callback: () => void }>();
  now(): number { return this.time; }
  setTimeout(callback: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.timers.set(id, { at: this.time + Math.max(0, ms), callback });
    return id;
  }
  clearTimeout(handle: unknown): void { this.timers.delete(handle as number); }
  pending(): number { return this.timers.size; }
  nextAt(): number | null {
    let at: number | null = null;
    for (const timer of this.timers.values()) at = at === null ? timer.at : Math.min(at, timer.at);
    return at;
  }
  /** Moves the clock, fires due timers in order and lets their async work settle. */
  async advance(ms: number): Promise<void> {
    const target = this.time + ms;
    for (;;) {
      let due: [number, { at: number; callback: () => void }] | null = null;
      for (const entry of this.timers) if (entry[1].at <= target && (!due || entry[1].at < due[1].at)) due = entry;
      if (!due) break;
      this.timers.delete(due[0]);
      this.time = Math.max(this.time, due[1].at);
      due[1].callback();
      await settle();
    }
    this.time = target;
  }
}
export async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise<void>(resolve => setImmediate(resolve));
}

type Role = "admin" | "editor" | "viewer";
type TaskRow = { id: string; title: string; areaId: string; revision: number };
type LogEntry =
  | { seq: number; kind: "task"; id: string; areaId: string; op: "upsert" | "leave" | "tombstone"; revision: number }
  | { seq: number; kind: "membership"; areaId: string; userId: string; op: "member_add" | "member_remove" | "member_role"; role: Role | null };
type SessionState = "live" | "expired" | "revoked" | "restored";
export type Injection = { result?: TransportResult<unknown>; commitThenReturn?: TransportResult<unknown> };

/**
 * In-memory model of the staging server contract used by the unit tests: ACL by role, CAS tokens, command
 * receipts (replay / idempotency conflict), restore generations, tombstones, a per-actor feed with bootstrap,
 * area bootstrap and the notices. It models the CONTRACT (verified against the route code), not the SQL.
 */
export class FakeTargetServer {
  generation: string;
  pageSize = 2;
  floor = 0;
  /** `restore_pending`: every call answers 503 with that code. */
  gate: "restore_pending" | "journal_invalid" | null = null;
  readonly tasks = new Map<string, TaskRow>();
  readonly tombstones = new Map<string, { id: string; areaId: string; revision: number }>();
  readonly areas = new Map<string, { kind: "private" | "shared"; owner: string | null; members: Map<string, Role> }>();
  readonly sessions = new Map<string, { userId: string; state: SessionState }>();
  readonly receipts = new Map<string, string>();
  readonly log: LogEntry[] = [];
  /** Every committed mutation (tests assert that nothing was written). */
  readonly writes: Array<{ userId: string; taskId: string; kind: "title" | "delete"; commandId: string; generation: string }> = [];
  /** Every call, for "no blind resend" style assertions. */
  readonly calls: Array<{ method: string; userId: string | null; commandId?: string; cursor?: string | null }> = [];
  private seq = 0;
  private tokenCounter = 0;
  private readonly scripts = new Map<string, Injection[]>();

  constructor(generation = "00000000-0000-4000-8000-000000000001") { this.generation = generation; }

  // ---- fixture mutation (what other actors do)
  addUser(userId: string): void {
    this.areas.set(`${userId}-private`, { kind: "private", owner: userId, members: new Map([[userId, "admin"]]) });
  }
  addArea(areaId: string, members: Record<string, Role>): void {
    this.areas.set(areaId, { kind: "shared", owner: null, members: new Map(Object.entries(members)) });
    for (const [userId, role] of Object.entries(members)) this.log.push({ seq: ++this.seq, kind: "membership", areaId, userId, op: "member_add", role });
  }
  addTask(id: string, areaId: string, title: string): void {
    this.tasks.set(id, { id, title, areaId, revision: 1 });
    this.log.push({ seq: ++this.seq, kind: "task", id, areaId, op: "upsert", revision: 1 });
  }
  setTitle(id: string, title: string): void {
    const task = this.tasks.get(id) as TaskRow;
    task.title = title;
    task.revision += 1;
    this.log.push({ seq: ++this.seq, kind: "task", id, areaId: task.areaId, op: "upsert", revision: task.revision });
  }
  removeTask(id: string): void {
    const task = this.tasks.get(id) as TaskRow;
    this.tasks.delete(id);
    this.tombstones.set(id, { id, areaId: task.areaId, revision: task.revision + 1 });
    this.log.push({ seq: ++this.seq, kind: "task", id, areaId: task.areaId, op: "tombstone", revision: task.revision + 1 });
  }
  moveTask(id: string, areaId: string): void {
    const task = this.tasks.get(id) as TaskRow;
    this.log.push({ seq: ++this.seq, kind: "task", id, areaId: task.areaId, op: "leave", revision: task.revision + 1 });
    task.areaId = areaId;
    task.revision += 1;
    this.log.push({ seq: ++this.seq, kind: "task", id, areaId, op: "upsert", revision: task.revision });
  }
  setRole(areaId: string, userId: string, role: Role): void {
    (this.areas.get(areaId) as { members: Map<string, Role> }).members.set(userId, role);
    this.log.push({ seq: ++this.seq, kind: "membership", areaId, userId, op: "member_role", role });
  }
  addMember(areaId: string, userId: string, role: Role): void {
    (this.areas.get(areaId) as { members: Map<string, Role> }).members.set(userId, role);
    this.log.push({ seq: ++this.seq, kind: "membership", areaId, userId, op: "member_add", role });
  }
  removeMember(areaId: string, userId: string): void {
    (this.areas.get(areaId) as { members: Map<string, Role> }).members.delete(userId);
    this.log.push({ seq: ++this.seq, kind: "membership", areaId, userId, op: "member_remove", role: null });
  }
  /** Log compaction: older cursors get `resync_required` (same generation). */
  compact(): void { this.floor = this.seq; }
  /** Backup restore: new generation, a log which restarts, sessions of `restoredFor` get `session_restored`. */
  restore(options: { generation: string; tasks?: Array<[string, string, string]>; restoredSessions?: string[]; revokedSessions?: string[] }): void {
    this.generation = options.generation;
    this.tasks.clear();
    this.tombstones.clear();
    this.log.length = 0;
    this.seq = 0;
    this.floor = 0;
    this.receipts.clear();
    for (const [id, areaId, title] of options.tasks ?? []) this.tasks.set(id, { id, title, areaId, revision: 1 });
    for (const token of options.restoredSessions ?? []) (this.sessions.get(token) as { state: SessionState }).state = "restored";
    for (const token of options.revokedSessions ?? []) (this.sessions.get(token) as { state: SessionState }).state = "revoked";
  }
  login(userId: string): string {
    const token = `session-${userId}-${this.sessions.size + 1}`;
    this.sessions.set(token, { userId, state: "live" });
    return token;
  }
  setSession(token: string, state: SessionState): void { (this.sessions.get(token) as { state: SessionState }).state = state; }
  /** Queue behaviour for the next call(s) of one transport method. */
  script(method: keyof TargetSyncTransport, ...injections: Injection[]): void {
    this.scripts.set(method, [...(this.scripts.get(method) ?? []), ...injections]);
  }
  titleOf(id: string): string | undefined { return this.tasks.get(id)?.title; }
  head(): number { return this.seq; }
  /** A valid feed cursor at position `p` (for scripted custom pages). */
  feedCursor(userId: string, p = this.seq): string { return this.cursor({ t: "f", u: userId, p }); }

  // ---- contract
  token(task: TaskRow): string { return `cas:${this.generation}:${task.id}:${task.revision}:${task.areaId}`; }
  roleIn(userId: string, areaId: string): Role | null {
    const area = this.areas.get(areaId);
    return area?.members.get(userId) ?? null;
  }
  canWrite(userId: string, areaId: string): boolean {
    const role = this.roleIn(userId, areaId);
    return role === "admin" || role === "editor";
  }
  private readable(userId: string): TaskRow[] {
    return [...this.tasks.values()].filter(task => this.roleIn(userId, task.areaId) !== null)
      .sort((a, b) => (a.areaId + "\0" + a.id).localeCompare(b.areaId + "\0" + b.id));
  }
  private itemOf(task: TaskRow): FeedItem {
    const area = this.areas.get(task.areaId);
    return { type: "upsert", kind: "task", id: task.id, revision: task.revision, areaId: task.areaId, areaKind: area?.kind,
      title: task.title, projectId: null, effectiveAreaId: task.areaId };
  }
  private cursor(value: object): string { return Buffer.from(JSON.stringify({ ...value, gen: this.generation })).toString("base64url"); }
  private open(raw: string, userId: string): { claims: Record<string, unknown> } | "cursor_invalid" | "resync_required" {
    let claims: Record<string, unknown>;
    try { claims = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")); } catch { return "cursor_invalid"; }
    if (!claims || typeof claims !== "object" || claims.u !== userId) return "cursor_invalid";
    if (claims.gen !== this.generation) return "resync_required";
    return { claims };
  }

  private page(userId: string, cursor: string | null): TransportResult<FeedPage> {
    const gen = this.generation;
    if (cursor === null) return this.bootstrapPage(userId, 0, this.seq);
    const opened = this.open(cursor, userId);
    if (opened === "cursor_invalid") return { kind: "cursor_invalid" };
    if (opened === "resync_required") return { kind: "resync_required" };
    const c = opened.claims as { t: string; i?: number; w?: number; p?: number; area?: string };
    if (c.t === "b") {
      if ((c.w as number) < this.floor) return { kind: "resync_required" };
      return this.bootstrapPage(userId, c.i as number, c.w as number);
    }
    if (c.t === "a") {
      const tasks = this.readable(userId).filter(task => task.areaId === c.area);
      const start = (c.i as number) ?? 0;
      const slice = tasks.slice(start, start + this.pageSize);
      const done = start + this.pageSize >= tasks.length;
      return { kind: "ok", value: { phase: "area_bootstrap", items: slice.map(task => this.itemOf(task)), more: false, done,
        cursor: done ? null : this.cursor({ t: "a", u: userId, i: start + this.pageSize, area: c.area }), restoreGeneration: gen } };
    }
    if ((c.p as number) < this.floor) return { kind: "resync_required" };
    const entries = this.log.filter(entry => entry.seq > (c.p as number));
    const slice = entries.slice(0, this.pageSize);
    const items: FeedItem[] = [];
    for (const entry of slice) {
      if (entry.kind === "membership") {
        if (entry.userId !== userId) continue;
        if (entry.op === "member_add") items.push({ type: "access_granted", areaId: entry.areaId, role: entry.role as string, areaCursor: this.cursor({ t: "a", u: userId, i: 0, area: entry.areaId }) });
        else if (entry.op === "member_role") items.push({ type: "role_changed", areaId: entry.areaId, role: entry.role as string });
        else items.push({ type: "access_lost", areaId: entry.areaId });
        continue;
      }
      if (!this.memberAt(userId, entry.areaId, entry.seq)) continue;
      if (entry.op === "tombstone") items.push({ type: "tombstone", kind: "task", id: entry.id, areaId: entry.areaId, revision: entry.revision });
      else if (entry.op === "leave") items.push({ type: "left_scope", kind: "task", id: entry.id, areaId: entry.areaId });
      else {
        const task = this.tasks.get(entry.id);
        if (task && this.roleIn(userId, task.areaId) !== null) items.push(this.itemOf(task));
      }
    }
    const p = slice.length > 0 ? slice[slice.length - 1].seq : (c.p as number);
    return { kind: "ok", value: { phase: "feed", items, more: entries.length > slice.length, done: false,
      cursor: this.cursor({ t: "f", u: userId, p }), restoreGeneration: gen } };
  }
  private bootstrapPage(userId: string, index: number, watermark: number): TransportResult<FeedPage> {
    const tasks = this.readable(userId);
    const slice = tasks.slice(index, index + this.pageSize);
    const more = index + this.pageSize < tasks.length;
    return { kind: "ok", value: { phase: "bootstrap", items: slice.map(task => this.itemOf(task)), more, done: false,
      cursor: more ? this.cursor({ t: "b", u: userId, i: index + this.pageSize, w: watermark }) : this.cursor({ t: "f", u: userId, p: watermark }),
      restoreGeneration: this.generation } };
  }

  private gateOrAuth(token: string): { userId: string } | TransportResult<never> {
    if (this.gate) return { kind: "store_unavailable", code: this.gate };
    const session = this.sessions.get(token);
    if (!session) return { kind: "unauthorized", code: null };
    if (session.state !== "live") return { kind: "unauthorized", code: session.state === "expired" ? "session_expired" : session.state === "revoked" ? "session_revoked" : "session_restored" };
    return { userId: session.userId };
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async scripted<T>(method: keyof TargetSyncTransport, run: () => TransportResult<any>): Promise<TransportResult<T>> {
    const queue = this.scripts.get(method);
    const injection = queue?.shift();
    if (injection?.result) return injection.result as TransportResult<T>;
    const real = run();
    return injection?.commitThenReturn ? (injection.commitThenReturn as TransportResult<T>) : real;
  }
  private receiptKey(userId: string, taskId: string, commandId: string): string { return `${userId}|${taskId}|${commandId}`; }

  private write(userId: string, kind: "title" | "delete", request: CommandRequest & { title?: string }): TransportResult<unknown> | { ok: true; replayed: boolean } {
    if (request.restoreGeneration !== this.generation) return { kind: "resync_required" };
    const task = this.tasks.get(request.taskId);
    const digest = kind === "title" ? `${request.taskId}|${request.title}|${request.expectedRevision}` : `${request.taskId}|${request.expectedRevision}`;
    const key = this.receiptKey(userId, request.taskId, request.commandId);
    if (!task) {
      const tomb = this.tombstones.get(request.taskId);
      if (kind === "delete" && tomb && this.receipts.get(key) !== undefined) {
        if (request.writeAreaId !== tomb.areaId) return { kind: "conflict", code: "write_area_mismatch" };
        return this.receipts.get(key) === digest ? { ok: true, replayed: true } : { kind: "conflict", code: "idempotency_conflict" };
      }
      return { kind: "unavailable" };
    }
    if (!this.canWrite(userId, task.areaId) || !this.canWrite(userId, request.writeAreaId)) return { kind: "unavailable" };
    if (request.writeAreaId !== task.areaId) return { kind: "conflict", code: "write_area_mismatch" };
    const known = this.receipts.get(key);
    if (known !== undefined) return known === digest ? { ok: true, replayed: true } : { kind: "conflict", code: "idempotency_conflict" };
    if (request.expectedRevision !== this.token(task)) return { kind: "conflict", code: "stale_revision" };
    this.receipts.set(key, digest);
    this.writes.push({ userId, taskId: task.id, kind, commandId: request.commandId, generation: this.generation });
    if (kind === "title") this.setTitle(task.id, request.title as string); else this.removeTask(task.id);
    return { ok: true, replayed: false };
  }
  private statusOf(userId: string, kind: "title" | "delete", request: CommandRequest & { title?: string }): TransportResult<{ status: CommandStatus }> {
    if (request.restoreGeneration !== this.generation) return { kind: "resync_required" };
    const task = this.tasks.get(request.taskId);
    const key = this.receiptKey(userId, request.taskId, request.commandId);
    const digest = kind === "title" ? `${request.taskId}|${request.title}|${request.expectedRevision}` : `${request.taskId}|${request.expectedRevision}`;
    if (!task) {
      const tomb = this.tombstones.get(request.taskId);
      if (kind === "delete" && tomb && this.receipts.has(key)) {
        if (request.writeAreaId !== tomb.areaId) return { kind: "conflict", code: "write_area_mismatch" };
        return { kind: "ok", value: { status: "committed" } };
      }
      return { kind: "unavailable" };
    }
    if (!this.canWrite(userId, task.areaId) || !this.canWrite(userId, request.writeAreaId)) return { kind: "unavailable" };
    if (request.writeAreaId !== task.areaId) return { kind: "conflict", code: "write_area_mismatch" };
    const known = this.receipts.get(key);
    if (known === undefined) return { kind: "ok", value: { status: "not_recorded" } };
    return known === digest ? { kind: "ok", value: { status: "committed" } } : { kind: "conflict", code: "idempotency_conflict" as ConflictCode };
  }

  /** Was `userId` a member of `areaId` when log entry `seq` was written (private Areas: the owner always)? */
  private memberAt(userId: string, areaId: string, seq: number): boolean {
    const area = this.areas.get(areaId);
    if (area?.kind === "private") return area.owner === userId;
    let latest: LogEntry | undefined;
    for (const entry of this.log) {
      if (entry.seq >= seq) break;
      if (entry.kind === "membership" && entry.areaId === areaId && entry.userId === userId) latest = entry;
    }
    return latest !== undefined && latest.op !== "member_remove";
  }

  /** The transport of one logged-in session (the cookie). Every call is recorded, also when a script answers it. */
  transport(token: string): TargetSyncTransport {
    const self = this;
    const rec = (method: string, extra: { commandId?: string; cursor?: string | null } = {}) => {
      self.calls.push({ method, userId: self.sessions.get(token)?.userId ?? null, ...extra });
    };
    const auth = () => self.gateOrAuth(token);
    return {
      fetchChanges: cursor => { rec("fetchChanges", { cursor }); return self.scripted("fetchChanges", () => {
        const who = auth();
        return "userId" in who ? self.page(who.userId, cursor) : who;
      }); },
      readTitleToken: taskId => { rec("readTitleToken"); return self.scripted("readTitleToken", () => {
        const who = auth();
        if (!("userId" in who)) return who;
        const task = self.tasks.get(taskId);
        if (!task || !self.canWrite(who.userId, task.areaId)) return { kind: "unavailable" };
        return { kind: "ok", value: { snapshotRevision: self.token(task) } };
      }); },
      sendTitle: (request: TitleRequest) => { rec("sendTitle", { commandId: request.commandId }); return self.scripted("sendTitle", () => {
        const who = auth();
        if (!("userId" in who)) return who;
        const out = self.write(who.userId, "title", request);
        return "ok" in out ? { kind: "ok", value: {}, ...(out.replayed ? { replayed: true } : {}) } : out;
      }); },
      sendDelete: (request: CommandRequest) => { rec("sendDelete", { commandId: request.commandId }); return self.scripted("sendDelete", () => {
        const who = auth();
        if (!("userId" in who)) return who;
        const out = self.write(who.userId, "delete", request);
        return "ok" in out ? { kind: "ok", value: {}, ...(out.replayed ? { replayed: true } : {}) } : out;
      }); },
      titleStatus: (request: TitleRequest) => { rec("titleStatus", { commandId: request.commandId }); return self.scripted("titleStatus", () => {
        const who = auth();
        return "userId" in who ? self.statusOf(who.userId, "title", request) : who;
      }); },
      deleteStatus: (request: CommandRequest) => { rec("deleteStatus", { commandId: request.commandId }); return self.scripted("deleteStatus", () => {
        const who = auth();
        return "userId" in who ? self.statusOf(who.userId, "delete", request) : who;
      }); },
    };
  }
}
