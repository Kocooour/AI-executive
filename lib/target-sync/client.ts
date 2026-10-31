import { namespaceName, parseNamespaceName, SYNC_USER_ID } from "./storage";
import type { StorageOp, TargetSyncNamespace, TargetSyncStorage } from "./storage";
import type { CommandRequest, FeedItem, FeedPage, TargetSyncTransport, TitleRequest, TransportResult } from "./transport";
import type {
  CommandState, EditResult, LockReason, NamespaceMeta, PendingCounts, PumpOutcome, Readable, SyncCommand, SyncDraft,
  SyncEvent, SyncItem, SyncOutcome, SyncReport, SyncTombstone,
} from "./types";

/**
 * R2c.5a client sync core (no UI, no DOM). Mechanism proposed for owner approval, see docs/ARCHITECTURE.md
 * "Klientské sync jádro (R2c.5a)" and the R2c.5 row of docs/ROADMAP.md.
 *
 * Invariants:
 *  - One identity per device: `activate` of another user first deletes every namespace of every other identity.
 *  - A command is sent with the CAS token of the state the user edited. An `uncertain` result is resolved by the
 *    status endpoint, never by a blind resend.
 *  - Nothing is ever dropped silently: conflicts keep the draft, 404 and 400 take a command out of sending and
 *    report it, access loss deletes with a reported count.
 *  - Nothing queued in an older restore generation is ever sent automatically in a newer one.
 */

export interface SyncScheduler {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}
export const systemScheduler: SyncScheduler = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: handle => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export type TargetSyncClientOptions = {
  storage: TargetSyncStorage;
  transport: TargetSyncTransport;
  scheduler?: SyncScheduler;
  /** UUID generator for command ids and report ids (default `crypto.randomUUID`). */
  newId?: () => string;
  /** Schedule retries and flushes on the scheduler (default true). Tests may disable it. */
  autoRun?: boolean;
};

const MAX_PAGES_PER_PASS = 10_000;
const MAX_STALE_RETRIES = 3;
const MAX_RESTARTS = 3;
const MAX_BACKOFF_MS = 60_000;
const MAX_TITLE_LENGTH = 4096;
const PAD = 10;

const K = {
  meta: "meta",
  item: (kind: string, id: string) => `item/${kind}/${id}`,
  tomb: (kind: string, id: string) => `tomb/${kind}/${id}`,
  area: (areaId: string) => `area/${areaId}`,
  areaBootstrap: (areaId: string) => `ab/${areaId}`,
  draft: (taskId: string) => `draft/${taskId}`,
  command: (seq: number) => `cmd/${String(seq).padStart(PAD, "0")}`,
  report: (n: number) => `report/${String(n).padStart(PAD, "0")}`,
};

class StaleSession extends Error {}
class StorageFailure extends Error {}

type Session = {
  userId: string;
  ns: TargetSyncNamespace | null;
  closed: boolean;
  chain: Promise<unknown>;
  /** Lock held before a namespace exists (first bootstrap got a 401). */
  memoryLock: "session_expired" | null;
  timer: unknown | null;
  timerAt: number;
  feedFailures: number;
  feedBackoffUntil: number;
};

type Pending = Omit<SyncReport, "id">;

/** Read-your-writes overlay over one namespace; `commit` is ONE atomic storage transaction. */
class Stage {
  private readonly overlay = new Map<string, unknown>();
  private readonly deleted = new Set<string>();
  private readonly touched: string[] = [];
  readonly reports: Pending[] = [];
  readonly ns: TargetSyncNamespace;
  constructor(ns: TargetSyncNamespace) { this.ns = ns; }

  async get<T>(key: string): Promise<T | undefined> {
    if (this.deleted.has(key)) return undefined;
    if (this.overlay.has(key)) return clone(this.overlay.get(key)) as T;
    return this.ns.get<T>(key);
  }
  put(key: string, value: unknown): void {
    this.deleted.delete(key);
    this.overlay.set(key, clone(value));
    this.touched.push(key);
  }
  del(key: string): void {
    this.overlay.delete(key);
    this.deleted.add(key);
    this.touched.push(key);
  }
  async list<T>(prefix: string): Promise<Array<{ key: string; value: T }>> {
    const merged = new Map<string, T>();
    for (const row of await this.ns.list<T>(prefix)) merged.set(row.key, row.value);
    for (const key of this.deleted) merged.delete(key);
    for (const [key, value] of this.overlay) if (key.startsWith(prefix)) merged.set(key, clone(value) as T);
    return [...merged.keys()].sort().map(key => ({ key, value: merged.get(key) as T }));
  }
  ops(): StorageOp[] {
    const seen = new Set<string>();
    const out: StorageOp[] = [];
    for (const key of this.touched) {
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(this.deleted.has(key) ? { kind: "delete", key } : { kind: "put", key, value: this.overlay.get(key) });
    }
    return out;
  }
}
const clone = <T>(value: T): T => (value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T));
const areaOf = (item: SyncItem): string => item.areaId;

const freshMeta = (userId: string, generation: string): NamespaceMeta => ({
  version: 1, userId, generation, lock: null, phase: "bootstrap", cursor: null, bootstrapId: 1,
  bootstrapSweep: false, resyncRequested: false, supersedes: [], migrated: true, nextSeq: 1, nextReportId: 1,
});

export class TargetSyncClient {
  private readonly storage: TargetSyncStorage;
  private readonly transport: TargetSyncTransport;
  private readonly sched: SyncScheduler;
  private readonly newId: () => string;
  private readonly autoRun: boolean;
  private session: Session | null = null;
  private readonly listeners = new Set<(event: SyncEvent) => void>();
  /** Serializes activate/logout (identity changes). */
  private identityChain: Promise<unknown> = Promise.resolve();
  /** Namespaces whose deletion failed: completed before any identity is activated again. */
  private pendingWipe: string[] = [];

  constructor(options: TargetSyncClientOptions) {
    this.storage = options.storage;
    this.transport = options.transport;
    this.sched = options.scheduler ?? systemScheduler;
    this.newId = options.newId ?? (() => globalThis.crypto.randomUUID());
    this.autoRun = options.autoRun ?? true;
  }

  // ------------------------------------------------------------------ events
  /** Subscribes to events; events only concern the CURRENTLY active identity and carry its `userId`. */
  on(listener: (event: SyncEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  private emit(s: Session, event: SyncEvent): void {
    if (this.session !== s || s.closed) return;
    for (const listener of [...this.listeners]) {
      try { listener(event); } catch { /* a listener must not break the engine */ }
    }
  }

  // ------------------------------------------------------------------ identity
  /**
   * The identity is authenticated NOW. A different user deletes every namespace of every other identity
   * (atomically, before anything is opened) and tells the new identity nothing about it. The same user reopens
   * its (possibly locked) namespace, unlocks it and gets its pending reports again.
   */
  activate(input: { userId: string; restoreGeneration?: string }): Promise<{ userId: string; restoreGeneration: string | null }> {
    return this.serialIdentity(async () => {
      if (typeof input?.userId !== "string" || !SYNC_USER_ID.test(input.userId)) throw new Error("invalid_user_id");
      const userId = input.userId;
      await this.finishPendingWipe();
      const previous = this.session;
      // Retire even a same-user session before any asynchronous namespace work.
      // In-flight transport responses must never mutate the newly activated generation.
      if (previous) {
        previous.closed = true;
        if (previous.timer !== null) this.sched.clearTimeout(previous.timer);
        this.session = null;
        // Let already-running serialized operations settle before reopening storage.
        await previous.chain;
      }
      const names = await this.storage.listNamespaces();
      const foreign = names.filter(name => parseNamespaceName(name)?.userId !== userId);
      if (foreign.length > 0) await this.storage.deleteNamespaces(foreign);
      const own = names.filter(name => parseNamespaceName(name)?.userId === userId);
      let ns = await this.chooseNamespace(userId, own, input.restoreGeneration);
      const s: Session = {
        userId, ns: null, closed: false, chain: Promise.resolve(), memoryLock: null, timer: null, timerAt: 0,
        feedFailures: 0, feedBackoffUntil: 0,
      };
      if (ns) {
        const meta = await ns.get<NamespaceMeta>(K.meta);
        const stage = new Stage(ns);
        // A command caught in `sending` by a crash may have reached the server: it is uncertain now.
        for (const { key, value } of await ns.list<SyncCommand>("cmd/")) {
          if (value.state === "sending") stage.put(key, { ...value, state: "uncertain" });
        }
        if (meta) stage.put(K.meta, { ...meta, lock: null });
        if (stage.ops().length > 0) await ns.transaction(stage.ops());
        // Crash recovery: a finished restore migration leaves its sources behind.
        if (meta?.migrated && meta.supersedes.length > 0) {
          await this.storage.deleteNamespaces(meta.supersedes);
          await ns.transaction([{ kind: "put", key: K.meta, value: { ...meta, lock: null, supersedes: [] } }]);
        }
      }
      s.ns = ns;
      s.memoryLock = null;
      s.feedFailures = 0;
      s.feedBackoffUntil = 0;
      this.session = s;
      const meta = ns ? await ns.get<NamespaceMeta>(K.meta) : undefined;
      if (ns) {
        for (const { value } of await ns.list<SyncReport>("report/")) this.emit(s, { type: "report", userId, report: value });
      }
      return { userId, restoreGeneration: meta?.generation ?? null };
    });
  }

  private async chooseNamespace(userId: string, own: string[], generation?: string): Promise<TargetSyncNamespace | null> {
    if (generation !== undefined) {
      const name = namespaceName(userId, generation);
      const ns = await this.storage.openNamespace(name);
      if (!(await ns.get(K.meta))) {
        // An explicitly supplied generation is also a restore boundary: preserve
        // earlier drafts as migration sources instead of silently orphaning them.
        const sources = own.filter(source => source !== name);
        const meta = { ...freshMeta(userId, generation), supersedes: sources, migrated: sources.length === 0 };
        await ns.transaction([{ kind: "put", key: K.meta, value: meta }]);
      }
      return ns;
    }
    const candidates: Array<{ ns: TargetSyncNamespace; meta: NamespaceMeta }> = [];
    const broken: string[] = [];
    for (const name of own) {
      const ns = await this.storage.openNamespace(name);
      const meta = await ns.get<NamespaceMeta>(K.meta);
      if (meta && meta.userId === userId && meta.version === 1) candidates.push({ ns, meta });
      else broken.push(name);
    }
    if (broken.length > 0) await this.storage.deleteNamespaces(broken);
    if (candidates.length === 0) return null;
    // A namespace which a not yet migrated or migrated successor supersedes is a source, not a candidate.
    const sources = new Set(candidates.flatMap(candidate => candidate.meta.supersedes));
    const live = candidates.filter(candidate => !sources.has(candidate.ns.name));
    const pool = live.length > 0 ? live : candidates;
    pool.sort((a, b) => a.ns.name.localeCompare(b.ns.name));
    return pool[pool.length - 1].ns;
  }

  /** Explicit logout: the unsendable count is reported to THIS identity BEFORE the namespaces are deleted. */
  logout(): Promise<{ unsendable: number; wiped: boolean }> {
    return this.serialIdentity(async () => {
      await this.finishPendingWipe().catch(() => undefined);
      const s = this.session;
      if (!s) {
        const names = await this.storage.listNamespaces();
        this.pendingWipe = names;
        await this.finishPendingWipe().catch(() => undefined);
        return { unsendable: 0, wiped: this.pendingWipe.length === 0 };
      }
      const count = await this.countUnsent(s);
      if (count > 0) this.emit(s, { type: "report", userId: s.userId, report: { id: this.newId(), kind: "logout", count } });
      return { unsendable: count, wiped: await this.closeAndWipe(s) };
    });
  }

  private async finishPendingWipe(): Promise<void> {
    if (this.pendingWipe.length === 0) return;
    await this.storage.deleteNamespaces(this.pendingWipe);
    this.pendingWipe = [];
  }

  /** Closes the session first (nothing is exposed any more), then deletes every namespace of the identity. */
  private async closeAndWipe(s: Session): Promise<boolean> {
    s.closed = true;
    if (s.timer !== null) this.sched.clearTimeout(s.timer);
    if (this.session === s) this.session = null;
    let names: string[] = [];
    try {
      names = (await this.storage.listNamespaces()).filter(name => parseNamespaceName(name)?.userId === s.userId);
      await this.storage.deleteNamespaces(names);
      return true;
    } catch {
      this.pendingWipe = [...new Set([...this.pendingWipe, ...names])];
      return false;
    }
  }

  private serialIdentity<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.identityChain.then(fn, fn);
    this.identityChain = next.then(() => undefined, () => undefined);
    return next;
  }

  // ------------------------------------------------------------------ session plumbing
  private exclusive<T>(s: Session, fn: () => Promise<T>): Promise<T> {
    const next = s.chain.then(fn, fn);
    s.chain = next.then(() => undefined, () => undefined);
    return next;
  }
  private live(s: Session): void {
    if (s.closed || this.session !== s) throw new StaleSession();
  }
  private async guarded<T>(s: Session | null, stale: T, fn: (s: Session) => Promise<T>): Promise<T> {
    if (!s) return stale;
    try {
      return await this.exclusive(s, () => fn(s));
    } catch (error) {
      if (error instanceof StaleSession) return stale;
      throw error;
    }
  }
  private async readMeta(s: Session): Promise<NamespaceMeta | null> {
    return s.ns ? (await s.ns.get<NamespaceMeta>(K.meta)) ?? null : null;
  }
  private async lockReason(s: Session, forSync = false): Promise<LockReason | null> {
    if (s.memoryLock) return s.memoryLock;
    const meta = await this.readMeta(s);
    if (!meta) return null;
    if (meta.lock) return meta.lock;
    if (!forSync && meta.supersedes.length > 0 && !meta.migrated) return "resyncing";
    return null;
  }
  private async commit(s: Session, stage: Stage): Promise<void> {
    const ops = stage.ops();
    if (ops.length === 0) { this.live(s); return; }
    await this.rawCommit(s, stage.ns, ops);
  }
  /** One atomic storage transaction; a failure is a StorageFailure, a closed session a StaleSession. */
  private async rawCommit(s: Session, ns: TargetSyncNamespace, ops: StorageOp[]): Promise<void> {
    this.live(s);
    try {
      await ns.transaction(ops);
    } catch (error) {
      if (s.closed || this.session !== s) throw new StaleSession();
      throw new StorageFailure(error instanceof Error ? error.message : "storage");
    }
    this.live(s);
  }

  // ------------------------------------------------------------------ reads (locked => nothing)
  private async read<T>(fn: (ns: TargetSyncNamespace, meta: NamespaceMeta | null) => Promise<T>, empty: T): Promise<Readable<T>> {
    const s = this.session;
    if (!s) return { locked: false, value: empty };
    return this.guarded<Readable<T>>(s, { locked: false, value: empty }, async () => {
      const reason = await this.lockReason(s);
      this.live(s);
      if (reason) return { locked: true, reason };
      if (!s.ns) return { locked: false, value: empty };
      const ns = s.ns;
      const value = await fn(ns, await this.readMeta(s));
      this.live(s);
      if (s.ns !== ns) throw new StaleSession();
      return { locked: false, value };
    });
  }
  listItems(): Promise<Readable<SyncItem[]>> {
    return this.read(async ns => (await ns.list<SyncItem>("item/")).map(row => row.value), []);
  }
  getItem(id: string): Promise<Readable<SyncItem | null>> {
    return this.read(async ns => (await ns.get<SyncItem>(K.item("task", id))) ?? (await ns.get<SyncItem>(K.item("project", id))) ?? null, null);
  }
  listDrafts(): Promise<Readable<SyncDraft[]>> {
    return this.read(async ns => (await ns.list<SyncDraft>("draft/")).map(row => row.value), []);
  }
  listReports(): Promise<Readable<SyncReport[]>> {
    return this.read(async ns => (await ns.list<SyncReport>("report/")).map(row => row.value), []);
  }
  isTombstoned(taskId: string): Promise<Readable<boolean>> {
    return this.read(async ns => (await ns.get(K.tomb("task", taskId))) !== undefined, false);
  }
  pendingCounts(): Promise<Readable<PendingCounts>> {
    return this.read(async ns => {
      const drafts = (await ns.list<SyncDraft>("draft/")).map(row => row.value);
      const commands = (await ns.list<SyncCommand>("cmd/")).map(row => row.value);
      return {
        drafts: drafts.length,
        queued: commands.filter(c => c.state === "queued").length,
        uncertain: commands.filter(c => c.state === "uncertain" || c.state === "sending").length,
        conflict: drafts.filter(d => d.status === "conflict").length,
        unsendable: drafts.filter(d => d.status === "unsendable").length,
        local: drafts.filter(d => d.status === "local").length,
      };
    }, { drafts: 0, queued: 0, uncertain: 0, conflict: 0, unsendable: 0, local: 0 });
  }
  /** Explicit acknowledgement of a persisted report (it is re-delivered on every activation until then). */
  async acknowledgeReport(id: string): Promise<void> {
    await this.guarded<void>(this.session, undefined, async s => {
      this.live(s);
      if (!s.ns) return;
      const rows = await s.ns.list<SyncReport>("report/");
      const hit = rows.find(row => row.value.id === id);
      if (hit) await s.ns.transaction([{ kind: "delete", key: hit.key }]);
    });
  }
  private async countUnsent(s: Session): Promise<number> {
    if (!s.ns) return 0;
    try {
      const meta = await this.readMeta(s);
      let count = (await s.ns.list("draft/")).length;
      for (const name of meta?.supersedes ?? []) {
        if (!(await this.storage.listNamespaces()).includes(name)) continue;
        count += (await (await this.storage.openNamespace(name)).list("draft/")).length;
      }
      return count;
    } catch {
      return 0;
    }
  }

  // ------------------------------------------------------------------ public engine entry points
  sync(): Promise<SyncOutcome> {
    return this.guarded<SyncOutcome>(this.session, { status: "signed_out" }, s => this.syncSafe(s));
  }
  pump(): Promise<PumpOutcome> {
    return this.guarded<PumpOutcome>(this.session, { status: "signed_out" }, s => this.pumpSafe(s));
  }
  /** Feed catch-up, then the queue (one more round when a write demanded a resync). */
  async tick(): Promise<{ sync: SyncOutcome; pump: PumpOutcome }> {
    let sync = await this.sync();
    let pump = await this.pump();
    if (pump.status === "resync_requested") {
      sync = await this.sync();
      pump = await this.pump();
    }
    return { sync, pump };
  }
  private async syncSafe(s: Session): Promise<SyncOutcome> {
    try { return await this.syncLoop(s); } catch (error) {
      if (error instanceof StorageFailure) return { status: "error", reason: "storage_error" };
      throw error;
    }
  }
  private async pumpSafe(s: Session): Promise<PumpOutcome> {
    try { return await this.pumpLoop(s); } catch (error) {
      if (error instanceof StorageFailure) return { status: "error", reason: "storage_error" };
      throw error;
    }
  }

  private scheduleAt(s: Session, at: number): void {
    if (!this.autoRun || s.closed) return;
    if (s.timer !== null) {
      if (s.timerAt <= at) return;
      this.sched.clearTimeout(s.timer);
    }
    s.timerAt = at;
    s.timer = this.sched.setTimeout(() => {
      s.timer = null;
      if (this.session === s && !s.closed) void this.tick().catch(() => undefined);
    }, Math.max(0, at - this.sched.now()));
  }
  private backoffDelay(failures: number, retryAfterSeconds: number | null = null): number {
    if (retryAfterSeconds !== null) return Math.min(retryAfterSeconds * 1000, 10 * MAX_BACKOFF_MS);
    return Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(Math.max(failures - 1, 0), 6));
  }
  private feedBackoff(s: Session, retryAfterSeconds: number | null = null): SyncOutcome {
    s.feedFailures += 1;
    s.feedBackoffUntil = this.sched.now() + this.backoffDelay(s.feedFailures, retryAfterSeconds);
    this.scheduleAt(s, s.feedBackoffUntil);
    return { status: "backoff", retryAt: s.feedBackoffUntil };
  }

  // ------------------------------------------------------------------ bootstrap and feed
  private async syncLoop(s: Session): Promise<SyncOutcome> {
    this.live(s);
    const lock = await this.lockReason(s, true);
    if (lock) return { status: "locked", reason: lock };
    if (s.feedBackoffUntil > this.sched.now()) return { status: "backoff", retryAt: s.feedBackoffUntil };
    let staleRetries = 0;
    let restarts = 0;
    for (let page = 0; page < MAX_PAGES_PER_PASS; page += 1) {
      this.live(s);
      let meta = await this.readMeta(s);
      if (meta && meta.resyncRequested) meta = await this.beginBootstrap(s, meta);
      const cursor = meta ? meta.cursor : null;
      const result = await this.transport.fetchChanges(cursor);
      this.live(s);
      if (result.kind !== "ok") {
        const action = await this.fetchFailure(s, result, cursor, "main");
        if (action === "retry") {
          staleRetries += 1;
          if (staleRetries > MAX_STALE_RETRIES) return this.feedBackoff(s);
          continue;
        }
        if (action === "restart") {
          restarts += 1;
          if (restarts > MAX_RESTARTS || !s.ns) return this.feedBackoff(s);
          const current = await this.readMeta(s);
          if (current) await this.persistMeta(s, { ...current, resyncRequested: true });
          continue;
        }
        return action;
      }
      staleRetries = 0;
      const applied = await this.applyMainPage(s, meta, cursor, result.value);
      if (applied === "malformed") return this.feedBackoff(s);
      if (applied === "restart") {
        restarts += 1;
        if (restarts > MAX_RESTARTS) return this.feedBackoff(s);
        continue;
      }
      s.feedFailures = 0;
      if (applied === "more") continue;
      const area = await this.areaBootstraps(s);
      if (area !== "done") {
        if (area === "restart") {
          restarts += 1;
          const current = await this.readMeta(s);
          if (current && restarts <= MAX_RESTARTS) { await this.persistMeta(s, { ...current, resyncRequested: true }); continue; }
          return this.feedBackoff(s);
        }
        return area;
      }
      return { status: "idle" };
    }
    return { status: "error", reason: "page_limit" };
  }

  private async persistMeta(s: Session, meta: NamespaceMeta): Promise<void> {
    if (!s.ns) return;
    const stage = new Stage(s.ns);
    stage.put(K.meta, meta);
    await this.commit(s, stage);
  }

  /** Starts a fresh bootstrap over the existing cache; queue and drafts stay untouched. */
  private async beginBootstrap(s: Session, meta: NamespaceMeta): Promise<NamespaceMeta> {
    const next: NamespaceMeta = {
      ...meta, phase: "bootstrap", cursor: null, bootstrapId: meta.bootstrapId + 1, bootstrapSweep: true, resyncRequested: false,
    };
    const stage = new Stage(s.ns as TargetSyncNamespace);
    stage.put(K.meta, next);
    for (const row of await stage.list("ab/")) stage.del(row.key);
    await this.commit(s, stage);
    return next;
  }

  /** What to do with a non-ok feed result. */
  private async fetchFailure(s: Session, result: Exclude<TransportResult<FeedPage>, { kind: "ok" }>, cursor: string | null,
    where: "main" | "area"): Promise<"retry" | "restart" | SyncOutcome> {
    switch (result.kind) {
      case "read_stale_reload": return "retry";
      case "cursor_invalid":
      case "resync_required":
        return cursor === null ? this.feedBackoff(s) : "restart";
      case "unauthorized": return this.onUnauthorized(s, result.code);
      case "rate_limited": return this.feedBackoff(s, result.retryAfterSeconds);
      default: return this.feedBackoff(s);
    }
  }

  /** Applies one main (bootstrap or feed) page atomically. */
  private async applyMainPage(s: Session, current: NamespaceMeta | null, cursor: string | null, page: FeedPage):
    Promise<"more" | "done" | "restart" | "malformed"> {
    if (cursor === null ? page.phase !== "bootstrap" : page.phase !== current?.phase) return "malformed";
    let meta = current;
    if (!meta) {
      const ns = await this.storage.openNamespace(namespaceName(s.userId, page.restoreGeneration));
      const existing = await ns.get<NamespaceMeta>(K.meta);
      meta = existing ?? freshMeta(s.userId, page.restoreGeneration);
      s.ns = ns;
      if (!existing) await this.rawCommit(s, ns, [{ kind: "put", key: K.meta, value: meta }]);
    } else if (page.restoreGeneration !== meta.generation) {
      if (cursor !== null) {
        await this.persistMeta(s, { ...meta, resyncRequested: true });
        return "restart";
      }
      meta = await this.switchGeneration(s, meta, page.restoreGeneration);
    } else if (cursor === null) {
      // Same generation again: frozen commands are valid again (a write once demanded a resync in error).
      const stage = new Stage(s.ns as TargetSyncNamespace);
      for (const row of await stage.list<SyncCommand>("cmd/")) if (row.value.state === "frozen") stage.put(row.key, { ...row.value, state: "queued" });
      await this.commit(s, stage);
    }
    const ns = s.ns as TargetSyncNamespace;
    const stage = new Stage(ns);
    await this.applyItems(stage, meta, page.items, meta.bootstrapId);
    let result: "more" | "done" = "done";
    let migration: { sources: string[]; report: Pending | null } | null = null;
    if (meta.phase === "bootstrap") {
      if (page.more) {
        if (page.cursor === null) return "malformed";
        meta = { ...meta, cursor: page.cursor };
        result = "more";
      } else {
        if (page.cursor === null) return "malformed";
        await this.sweep(stage, meta);
        if (meta.supersedes.length > 0 && !meta.migrated) migration = await this.migrateDrafts(stage, meta);
        meta = { ...meta, phase: "feed", cursor: page.cursor, bootstrapSweep: false, migrated: true };
      }
    } else {
      meta = { ...meta, cursor: page.cursor ?? meta.cursor };
      result = page.more ? "more" : "done";
    }
    if (migration?.report) stage.reports.push(migration.report);
    const emitted = this.persistReports(stage, meta);
    meta = emitted.meta;
    stage.put(K.meta, meta);
    await this.commit(s, stage);
    for (const report of emitted.reports) this.emit(s, { type: "report", userId: s.userId, report });
    if (migration) {
      try { await this.storage.deleteNamespaces(migration.sources); await this.persistMeta(s, { ...meta, supersedes: [] }); } catch { /* retried by the next activation */ }
    }
    return result;
  }

  private persistReports(stage: Stage, meta: NamespaceMeta): { meta: NamespaceMeta; reports: SyncReport[] } {
    let next = meta;
    const reports: SyncReport[] = [];
    for (const pending of stage.reports.splice(0)) {
      const report: SyncReport = { id: `r${next.nextReportId}`, ...pending };
      stage.put(K.report(next.nextReportId), report);
      next = { ...next, nextReportId: next.nextReportId + 1 };
      reports.push(report);
    }
    return { meta: next, reports };
  }

  /** Server restore detected: freeze + clear the old generation, open the new namespace which will take over the drafts. */
  private async switchGeneration(s: Session, old: NamespaceMeta, generation: string): Promise<NamespaceMeta> {
    const oldNs = s.ns as TargetSyncNamespace;
    const stage = new Stage(oldNs);
    for (const row of await stage.list<SyncCommand>("cmd/")) stage.put(row.key, { ...row.value, state: "frozen" });
    for (const prefix of ["item/", "tomb/", "area/", "ab/"]) for (const row of await stage.list(prefix)) stage.del(row.key);
    stage.put(K.meta, { ...old, phase: "bootstrap", cursor: null, resyncRequested: true });
    await this.commit(s, stage);
    const next = await this.storage.openNamespace(namespaceName(s.userId, generation));
    const existing = await next.get<NamespaceMeta>(K.meta);
    const base = existing ?? freshMeta(s.userId, generation);
    const sources = [...new Set([...base.supersedes, ...(old.migrated ? [] : old.supersedes), oldNs.name])].filter(name => name !== next.name);
    const meta: NamespaceMeta = {
      ...base, lock: null, phase: "bootstrap", cursor: null, bootstrapSweep: false, resyncRequested: false,
      bootstrapId: base.bootstrapId + (existing ? 1 : 0), supersedes: sources, migrated: false,
    };
    await this.rawCommit(s, next, [{ kind: "put", key: K.meta, value: meta }]);
    s.ns = next;
    return meta;
  }

  /** Turns the frozen drafts of the old generation into LOCAL drafts for tasks present in the new bootstrap. */
  private async migrateDrafts(stage: Stage, meta: NamespaceMeta): Promise<{ sources: string[]; report: Pending | null }> {
    let kept = 0;
    let removed = 0;
    const existing = new Set((await stage.list("draft/")).map(row => row.key));
    const known = new Set(await this.storage.listNamespaces());
    const sources = meta.supersedes.filter(name => known.has(name));
    for (const name of sources) {
      const source = await this.storage.openNamespace(name);
      for (const { value } of await source.list<SyncDraft>("draft/")) {
        const item = await stage.get<SyncItem>(K.item("task", value.taskId));
        const tombstoned = (await stage.get(K.tomb("task", value.taskId))) !== undefined;
        if (!item || tombstoned || existing.has(K.draft(value.taskId))) { removed += 1; continue; }
        stage.put(K.draft(value.taskId), {
          ...value, status: "local", reason: "restored", reloadOffered: false, commandId: null,
          areaId: areaOf(item), baseItemRevision: item.revision,
        } satisfies SyncDraft);
        existing.add(K.draft(value.taskId));
        kept += 1;
      }
      for (const { value } of await source.list<SyncReport>("report/")) {
        stage.reports.push({ kind: value.kind, count: value.count, areaId: value.areaId, taskId: value.taskId, reason: value.reason,
          keptAsDrafts: value.keptAsDrafts, removed: value.removed });
      }
    }
    return { sources, report: kept + removed > 0 ? { kind: "restore", count: kept + removed, keptAsDrafts: kept, removed } : null };
  }

  /** Removes what a finished re-bootstrap did not confirm (access lost while the client was not looking). */
  private async sweep(stage: Stage, meta: NamespaceMeta): Promise<void> {
    let count = 0;
    for (const { key, value } of await stage.list<SyncItem>("item/")) {
      if (value.bootstrapId >= meta.bootstrapId) continue;
      stage.del(key);
      if (value.kind === "task") count += await this.dropTaskData(stage, value.id);
    }
    for (const { value } of await stage.list<SyncDraft>("draft/")) {
      if (meta.supersedes.length > 0 && !meta.migrated) break;
      const present = (await stage.get(K.item("task", value.taskId))) !== undefined ||
        (await stage.get(K.tomb("task", value.taskId))) !== undefined;
      if (!present) count += await this.dropTaskData(stage, value.taskId);
    }
    if (count > 0) stage.reports.push({ kind: "not_in_bootstrap", count });
  }

  /** Deletes the draft and the queued commands of one task; returns the number of drafts (unsent changes) removed. */
  private async dropTaskData(stage: Stage, taskId: string): Promise<number> {
    let count = 0;
    if ((await stage.get(K.draft(taskId))) !== undefined) { stage.del(K.draft(taskId)); count = 1; }
    for (const { key, value } of await stage.list<SyncCommand>("cmd/")) if (value.taskId === taskId) stage.del(key);
    return count;
  }

  private async applyItems(stage: Stage, meta: NamespaceMeta, items: FeedItem[], bootstrapId: number): Promise<void> {
    for (const item of items) {
      switch (item.type) {
        case "upsert": await this.applyUpsert(stage, item, bootstrapId); break;
        case "left_scope": await this.applyLeftScope(stage, item); break;
        case "tombstone": await this.applyTombstone(stage, item); break;
        case "access_granted":
          stage.put(K.area(item.areaId), { areaId: item.areaId, role: item.role });
          if (typeof item.areaCursor === "string" && item.areaCursor) stage.put(K.areaBootstrap(item.areaId), { areaId: item.areaId, cursor: item.areaCursor });
          break;
        case "role_changed": await this.applyRoleChanged(stage, item); break;
        case "access_lost": await this.applyAccessLost(stage, item.areaId); break;
        default: break; // unknown notice types are ignored (forward compatible)
      }
    }
  }

  private async applyUpsert(stage: Stage, item: Extract<FeedItem, { type: "upsert" }>, bootstrapId: number): Promise<void> {
    if ((await stage.get(K.tomb(item.kind, item.id))) !== undefined) return; // a tombstone beats every revision
    const areaId = item.kind === "task" ? (item.effectiveAreaId ?? item.areaId) : item.areaId;
    const incoming: SyncItem = {
      kind: item.kind, id: item.id, areaId, revision: item.revision, title: item.title, bootstrapId,
      ...(item.areaKind ? { areaKind: item.areaKind } : {}),
      ...(item.kind === "task" ? { projectId: item.projectId ?? null, ...(item.assignedToMe !== undefined ? { assignedToMe: item.assignedToMe } : {}) } : {}),
    };
    const existing = await stage.get<SyncItem>(K.item(item.kind, item.id));
    // Newer revision wins. The same revision with another effective Area is a move (a project move changes the
    // Area of its tasks without a revision change).
    const newer = !existing || incoming.revision > existing.revision ||
      (incoming.revision === existing.revision && incoming.areaId !== existing.areaId);
    if (newer) stage.put(K.item(item.kind, item.id), incoming);
    else if (existing.bootstrapId !== bootstrapId) stage.put(K.item(item.kind, item.id), { ...existing, bootstrapId });
  }

  private async applyLeftScope(stage: Stage, notice: { kind: "task" | "project"; id: string; areaId: string }): Promise<void> {
    const existing = await stage.get<SyncItem>(K.item(notice.kind, notice.id));
    // A stale notice about the old Area must not delete an item already seen in its new Area.
    if (!existing || existing.areaId !== notice.areaId) return;
    stage.del(K.item(notice.kind, notice.id));
    const count = notice.kind === "task" ? await this.dropTaskData(stage, notice.id) : 0;
    if (count > 0) stage.reports.push({ kind: "left_scope", count, areaId: notice.areaId, taskId: notice.id });
  }

  private async applyTombstone(stage: Stage, notice: { kind: "task" | "project"; id: string; areaId: string; revision: number }): Promise<void> {
    if ((await stage.get(K.tomb(notice.kind, notice.id))) !== undefined) return; // idempotent
    const tomb: SyncTombstone = { kind: notice.kind, id: notice.id, areaId: notice.areaId, revision: notice.revision };
    stage.put(K.tomb(notice.kind, notice.id), tomb);
    stage.del(K.item(notice.kind, notice.id));
    if (notice.kind !== "task") return;
    const draft = await stage.get<SyncDraft>(K.draft(notice.id));
    for (const { key, value } of await stage.list<SyncCommand>("cmd/")) if (value.taskId === notice.id) stage.del(key);
    if (!draft) return;
    if (draft.kind === "delete") { stage.del(K.draft(notice.id)); return; } // the intent is fulfilled
    stage.put(K.draft(notice.id), { ...draft, status: "unsendable", reason: "item_deleted", reloadOffered: false } satisfies SyncDraft);
    stage.reports.push({ kind: "item_deleted", count: 1, areaId: notice.areaId, taskId: notice.id });
  }

  private async applyRoleChanged(stage: Stage, notice: { areaId: string; role: string }): Promise<void> {
    stage.put(K.area(notice.areaId), { areaId: notice.areaId, role: notice.role });
    // Re-authorization of the queue of that Area: the next send first reads the CAS token (the server decides).
    for (const { key, value } of await stage.list<SyncCommand>("cmd/")) {
      if (value.writeAreaId === notice.areaId && value.state !== "frozen") stage.put(key, { ...value, recheck: true, notBefore: 0 });
    }
  }

  private async applyAccessLost(stage: Stage, areaId: string): Promise<void> {
    let count = 0;
    const lostTasks = new Set<string>();
    for (const { key, value } of await stage.list<SyncItem>("item/")) {
      if (value.areaId !== areaId) continue;
      stage.del(key);
      if (value.kind === "task") lostTasks.add(value.id);
    }
    for (const { key, value } of await stage.list<SyncTombstone>("tomb/")) if (value.areaId === areaId) stage.del(key);
    for (const { value } of await stage.list<SyncDraft>("draft/")) {
      if (lostTasks.has(value.taskId) || value.areaId === areaId) count += await this.dropTaskData(stage, value.taskId);
    }
    for (const { key, value } of await stage.list<SyncCommand>("cmd/")) if (value.writeAreaId === areaId) stage.del(key);
    stage.del(K.area(areaId));
    stage.del(K.areaBootstrap(areaId));
    if (count > 0) stage.reports.push({ kind: "access_lost", count, areaId });
  }

  /** Pending Area bootstraps (from `access_granted`), after the main feed is caught up. */
  private async areaBootstraps(s: Session): Promise<"done" | "restart" | SyncOutcome> {
    let stale = 0;
    for (let guard = 0; guard < MAX_PAGES_PER_PASS; guard += 1) {
      this.live(s);
      const ns = s.ns as TargetSyncNamespace;
      const rows = await ns.list<{ areaId: string; cursor: string }>("ab/");
      if (rows.length === 0) return "done";
      const { key, value } = rows[0];
      const result = await this.transport.fetchChanges(value.cursor);
      this.live(s);
      if (result.kind !== "ok") {
        const action = await this.fetchFailure(s, result, value.cursor, "area");
        if (action === "retry") { stale += 1; if (stale > MAX_STALE_RETRIES) return this.feedBackoff(s); continue; }
        return action;
      }
      stale = 0;
      const page = result.value;
      const meta = (await this.readMeta(s)) as NamespaceMeta;
      if (page.phase !== "area_bootstrap" || page.restoreGeneration !== meta.generation) {
        if (page.restoreGeneration !== meta.generation) return "restart";
        return this.feedBackoff(s);
      }
      if (!page.done && page.cursor === null) return this.feedBackoff(s);
      const stage = new Stage(ns);
      await this.applyItems(stage, meta, page.items, meta.bootstrapId);
      if (page.done) stage.del(key); else stage.put(key, { ...value, cursor: page.cursor });
      const persisted = this.persistReports(stage, meta);
      stage.put(K.meta, persisted.meta);
      await this.commit(s, stage);
      for (const report of persisted.reports) this.emit(s, { type: "report", userId: s.userId, report });
    }
    return { status: "error", reason: "page_limit" };
  }

  // ------------------------------------------------------------------ 401 handling
  private async onUnauthorized(s: Session, code: "session_expired" | "session_revoked" | "session_restored" | null): Promise<SyncOutcome> {
    if (code === "session_revoked") {
      const count = await this.countUnsent(s);
      if (count > 0) this.emit(s, { type: "report", userId: s.userId, report: { id: this.newId(), kind: "session_revoked", count } });
      await this.closeAndWipe(s);
      return { status: "signed_out" };
    }
    if (code === "session_restored") {
      if (s.ns) {
        const stage = new Stage(s.ns);
        // The queue is FROZEN (never sent in the new generation), the cache is cleared, drafts stay.
        for (const row of await stage.list<SyncCommand>("cmd/")) stage.put(row.key, { ...row.value, state: "frozen" });
        for (const prefix of ["item/", "tomb/", "area/", "ab/"]) for (const row of await stage.list(prefix)) stage.del(row.key);
        const meta = (await stage.get<NamespaceMeta>(K.meta)) as NamespaceMeta;
        stage.put(K.meta, { ...meta, lock: "restore_pending_reauth", phase: "bootstrap", cursor: null, resyncRequested: true });
        await this.commit(s, stage);
      } else s.memoryLock = "session_expired";
      this.emit(s, { type: "locked", userId: s.userId, reason: "restore_pending_reauth" });
      this.emit(s, { type: "reauth_required", userId: s.userId, reason: "session_restored" });
      return { status: "locked", reason: "restore_pending_reauth" };
    }
    // session_expired and a 401 without a code (owner cookie): the conservative choice, data is kept but locked.
    if (s.ns) {
      const meta = (await this.readMeta(s)) as NamespaceMeta;
      await this.persistMeta(s, { ...meta, lock: meta.lock ?? "session_expired" });
    } else s.memoryLock = "session_expired";
    this.emit(s, { type: "locked", userId: s.userId, reason: "session_expired" });
    this.emit(s, { type: "reauth_required", userId: s.userId, reason: "session_expired" });
    return { status: "locked", reason: "session_expired" };
  }

  // ------------------------------------------------------------------ queue
  private async pumpLoop(s: Session): Promise<PumpOutcome> {
    this.live(s);
    const lock = await this.lockReason(s);
    if (lock) return { status: "locked", reason: lock };
    const tally = { done: 0, conflicts: 0, unsendable: 0, resync: false, retryAt: 0 };
    if (s.ns) {
      const seen = new Set<string>();
      for (const row of await s.ns.list<SyncCommand>("cmd/")) {
        const cmd = row.value;
        // Single flight, FIFO per task: only the head command of a task is considered.
        if (seen.has(cmd.taskId)) continue;
        seen.add(cmd.taskId);
        if (cmd.state === "frozen") continue;
        if (cmd.notBefore > this.sched.now()) { tally.retryAt = tally.retryAt === 0 ? cmd.notBefore : Math.min(tally.retryAt, cmd.notBefore); continue; }
        const next = await this.processCommand(s, cmd.seq, tally);
        if (next === "stop") break;
      }
      this.live(s);
      await this.reportUnsendable(s, tally.unsendable);
    }
    this.live(s);
    const after = await this.lockReason(s);
    if (after) return { status: "locked", reason: after };
    if (tally.resync) return { status: "resync_requested" };
    if (tally.retryAt > 0) {
      this.scheduleAt(s, tally.retryAt);
      return { status: "backoff", retryAt: tally.retryAt, done: tally.done, conflicts: tally.conflicts, unsendable: tally.unsendable };
    }
    return { status: "idle", done: tally.done, conflicts: tally.conflicts, unsendable: tally.unsendable };
  }

  private async reportUnsendable(s: Session, count: number): Promise<void> {
    if (count <= 0 || !s.ns) return;
    const stage = new Stage(s.ns);
    stage.reports.push({ kind: "unsendable", count });
    const meta = (await stage.get<NamespaceMeta>(K.meta)) as NamespaceMeta;
    const persisted = this.persistReports(stage, meta);
    stage.put(K.meta, persisted.meta);
    await this.commit(s, stage);
    for (const report of persisted.reports) this.emit(s, { type: "report", userId: s.userId, report });
  }

  private reqOf(cmd: SyncCommand, areaId: string): CommandRequest {
    return {
      taskId: cmd.taskId, commandId: cmd.commandId, expectedRevision: cmd.expectedRevision as string,
      writeAreaId: areaId, restoreGeneration: cmd.restoreGeneration,
    };
  }

  private async patchCommand(s: Session, cmd: SyncCommand, patch: Partial<SyncCommand>): Promise<SyncCommand> {
    const next = { ...cmd, ...patch };
    const stage = new Stage(s.ns as TargetSyncNamespace);
    stage.put(K.command(cmd.seq), next);
    await this.commit(s, stage);
    return next;
  }

  /** The command is done (committed, replayed): command and draft go; the next feed delivers the new state. */
  private async completeCommand(s: Session, cmd: SyncCommand, tally: { done: number }): Promise<void> {
    const stage = new Stage(s.ns as TargetSyncNamespace);
    stage.del(K.command(cmd.seq));
    const draft = await stage.get<SyncDraft>(K.draft(cmd.taskId));
    if (draft && draft.commandId === cmd.commandId) stage.del(K.draft(cmd.taskId));
    await this.commit(s, stage);
    tally.done += 1;
  }

  /** The server refused with a conflict: the draft stays, a reload is offered, nothing is discarded. */
  private async conflictCommand(s: Session, cmd: SyncCommand, code: string, tally: { conflicts: number }): Promise<void> {
    const stage = new Stage(s.ns as TargetSyncNamespace);
    stage.del(K.command(cmd.seq));
    const draft = await stage.get<SyncDraft>(K.draft(cmd.taskId));
    if (draft) stage.put(K.draft(cmd.taskId), { ...draft, status: "conflict", reason: code, reloadOffered: true } satisfies SyncDraft);
    await this.commit(s, stage);
    tally.conflicts += 1;
    this.emit(s, { type: "conflict", userId: s.userId, taskId: cmd.taskId, commandId: cmd.commandId, code });
  }

  /** Out of sending for good (404, 400, deleted item); the draft stays, the count is reported. */
  private async unsendableCommand(s: Session, cmd: SyncCommand, reason: string, tally: { unsendable: number }): Promise<void> {
    const stage = new Stage(s.ns as TargetSyncNamespace);
    stage.del(K.command(cmd.seq));
    const draft = await stage.get<SyncDraft>(K.draft(cmd.taskId));
    if (draft) stage.put(K.draft(cmd.taskId), { ...draft, status: "unsendable", reason, reloadOffered: false } satisfies SyncDraft);
    await this.commit(s, stage);
    tally.unsendable += 1;
    this.emit(s, { type: "unsendable", userId: s.userId, taskId: cmd.taskId, commandId: cmd.commandId, reason });
  }

  private async processCommand(s: Session, seq: number,
    tally: { done: number; conflicts: number; unsendable: number; resync: boolean; retryAt: number }): Promise<"continue" | "stop"> {
    const ns = s.ns as TargetSyncNamespace;
    let cmd = await ns.get<SyncCommand>(K.command(seq));
    if (!cmd) return "continue";
    const draft = await ns.get<SyncDraft>(K.draft(cmd.taskId));
    if (!draft) { // a command without its draft cannot be explained to the user: drop the orphan only
      const stage = new Stage(ns);
      stage.del(K.command(seq));
      await this.commit(s, stage);
      return "continue";
    }
    if (cmd.state === "sending") cmd = await this.patchCommand(s, cmd, { state: "uncertain" });
    for (let round = 0; round < 3; round += 1) {
      this.live(s);
      if (cmd.state === "uncertain") {
        // Never a blind resend: ask the status endpoint with the same commandId and the CURRENT Area of the item.
        const item = await ns.get<SyncItem>(K.item("task", cmd.taskId));
        const request = this.reqOf(cmd, item ? areaOf(item) : cmd.writeAreaId);
        const res = cmd.kind === "title"
          ? await this.transport.titleStatus({ ...request, title: cmd.title as string })
          : await this.transport.deleteStatus(request);
        this.live(s);
        if (res.kind !== "ok") return this.commandFailure(s, cmd, res, "status", tally);
        if (res.value.status === "committed") { await this.completeCommand(s, cmd, tally); return "continue"; }
        cmd = await this.patchCommand(s, cmd, { state: "queued", failures: 0, notBefore: 0 }); // not_recorded: the same command may be sent again
        continue;
      }
      if (cmd.expectedRevision === null) {
        const acquired = await this.acquireToken(s, cmd.taskId, cmd.baseItemRevision);
        this.live(s);
        if (s.ns !== ns) return "stop"; // a restore switched the namespace under us: the next pass starts clean
        const again = await ns.get<SyncCommand>(K.command(seq)); // the feed pass may have removed the command
        if (!again) return "continue";
        if (acquired.kind === "ok") cmd = await this.patchCommand(s, again, { expectedRevision: acquired.token });
        else if (acquired.kind === "conflict") { await this.conflictCommand(s, again, acquired.reason, tally); return "continue"; }
        else if (acquired.kind === "gone") { await this.unsendableCommand(s, again, "item_deleted", tally); return "continue"; }
        else if (acquired.kind === "unavailable") { await this.unsendableCommand(s, again, "unavailable", tally); return "continue"; }
        else if (acquired.kind === "blocked") {
          if (acquired.outcome.status === "signed_out" || acquired.outcome.status === "locked") return "stop";
          return this.defer(s, again, tally, null);
        } else return this.commandFailure(s, again, acquired.res, "token", tally);
      } else if (cmd.recheck) {
        const probe = await this.transport.readTitleToken(cmd.taskId);
        this.live(s);
        if (probe.kind !== "ok") return this.commandFailure(s, cmd, probe, "token", tally);
        cmd = await this.patchCommand(s, cmd, { recheck: false });
      }
      cmd = await this.patchCommand(s, cmd, { state: "sending", attempts: cmd.attempts + 1 });
      const res = cmd.kind === "title"
        ? await this.transport.sendTitle({ ...this.reqOf(cmd, cmd.writeAreaId), title: cmd.title as string })
        : await this.transport.sendDelete(this.reqOf(cmd, cmd.writeAreaId));
      this.live(s);
      if (res.kind === "ok") { await this.completeCommand(s, cmd, tally); return "continue"; }
      return this.commandFailure(s, cmd, res, "send", tally);
    }
    return "continue";
  }

  private async defer(s: Session, cmd: SyncCommand, tally: { retryAt: number }, retryAfterSeconds: number | null,
    patch: Partial<SyncCommand> = {}): Promise<"continue"> {
    const failures = cmd.failures + 1;
    const notBefore = this.sched.now() + this.backoffDelay(failures, retryAfterSeconds);
    await this.patchCommand(s, cmd, { ...patch, failures, notBefore });
    tally.retryAt = tally.retryAt === 0 ? notBefore : Math.min(tally.retryAt, notBefore);
    return "continue";
  }

  private async commandFailure(s: Session, cmd: SyncCommand, res: Exclude<TransportResult<unknown>, { kind: "ok" }>,
    phase: "send" | "status" | "token",
    tally: { done: number; conflicts: number; unsendable: number; resync: boolean; retryAt: number }): Promise<"continue" | "stop"> {
    // A command which was on the wire stays uncertain unless the server proved it was not recorded.
    const onWire: Partial<SyncCommand> = phase === "send" ? { state: "uncertain" } : {};
    switch (res.kind) {
      case "unauthorized": {
        // The owner-cookie post-commit check may refuse a COMMITTED write: never assume "not written".
        await this.patchCommand(s, cmd, onWire);
        await this.onUnauthorized(s, res.code);
        return "stop";
      }
      case "resync_required": {
        await this.patchCommand(s, cmd, { state: "frozen" });
        const meta = (await this.readMeta(s)) as NamespaceMeta;
        await this.persistMeta(s, { ...meta, resyncRequested: true });
        tally.resync = true;
        return "stop";
      }
      case "unavailable": await this.unsendableCommand(s, cmd, "unavailable", tally); return "continue";
      case "conflict": await this.conflictCommand(s, cmd, res.code, tally); return "continue";
      case "invalid": await this.unsendableCommand(s, cmd, `invalid${res.code ? `:${res.code}` : ""}`, tally); return "continue";
      case "rate_limited": // answered before any write: the command was not recorded
        await this.defer(s, cmd, tally, res.retryAfterSeconds, phase === "send" ? { state: "queued" } : {});
        return "stop";
      case "store_unavailable": {
        // restore_pending and journal_invalid are gate refusals before any work; a plain 503 may follow a commit.
        const gate = res.code !== null;
        await this.defer(s, cmd, tally, null, phase === "send" ? { state: gate ? "queued" : "uncertain" } : {});
        return "stop";
      }
      default:
        await this.defer(s, cmd, tally, null, onWire);
        return "continue";
    }
  }

  /**
   * The CAS token is read AFTER the edit and validated against the feed: it is only adopted when, after a feed
   * catch-up that began after the token was read, the item still has the revision the user edited. Otherwise the
   * token would silently carry somebody else's newer content over.
   */
  private async acquireToken(s: Session, taskId: string, baseItemRevision: number): Promise<
    | { kind: "ok"; token: string } | { kind: "conflict"; reason: string } | { kind: "gone" } | { kind: "unavailable" }
    | { kind: "blocked"; outcome: SyncOutcome } | { kind: "failure"; res: Exclude<TransportResult<unknown>, { kind: "ok" }> }> {
    const res = await this.transport.readTitleToken(taskId);
    this.live(s);
    if (res.kind === "unavailable") return { kind: "unavailable" };
    if (res.kind !== "ok") return { kind: "failure", res };
    const outcome = await this.syncLoop(s);
    if (outcome.status !== "idle") return { kind: "blocked", outcome };
    const ns = s.ns as TargetSyncNamespace;
    if ((await ns.get(K.tomb("task", taskId))) !== undefined) return { kind: "gone" };
    const item = await ns.get<SyncItem>(K.item("task", taskId));
    if (!item) return { kind: "gone" };
    if (item.revision !== baseItemRevision) return { kind: "conflict", reason: "base_changed" };
    return { kind: "ok", token: res.value.snapshotRevision };
  }

  // ------------------------------------------------------------------ drafts (no UI)
  editTitle(taskId: string, title: string): Promise<EditResult> {
    return this.guarded<EditResult>(this.session, { ok: false, reason: "inactive" }, s => this.editSafe(s, "title", taskId, title, false));
  }
  deleteTask(taskId: string): Promise<EditResult> {
    return this.guarded<EditResult>(this.session, { ok: false, reason: "inactive" }, s => this.editSafe(s, "delete", taskId, undefined, false));
  }
  /** Explicit: a conflicting, unsendable or restored (local) draft is based on the current item again and queued. */
  resubmitDraft(taskId: string): Promise<EditResult> {
    return this.guarded<EditResult>(this.session, { ok: false, reason: "inactive" }, async s => {
      this.live(s);
      if (await this.lockReason(s)) return { ok: false, reason: "locked" };
      const ns = s.ns;
      const draft = ns ? await ns.get<SyncDraft>(K.draft(taskId)) : undefined;
      this.live(s);
      if (s.ns !== ns) return { ok: false, reason: "inactive" };
      if (!draft) return { ok: false, reason: "unknown_task" };
      if (draft.status === "queued") return { ok: true, status: "queued", commandId: draft.commandId };
      return this.editSafe(s, draft.kind, taskId, draft.title, true);
    });
  }
  /** The only way a draft disappears (besides access loss): an explicit caller decision. */
  discardDraft(taskId: string): Promise<boolean> {
    return this.guarded<boolean>(this.session, false, async s => {
      this.live(s);
      if (!s.ns || (await this.lockReason(s))) return false;
      const stage = new Stage(s.ns);
      const had = await this.dropTaskData(stage, taskId);
      await this.commit(s, stage);
      return had > 0;
    });
  }
  /** Fresh snapshot: the feed is caught up, then the caller sees the item and may rebase (`resubmitDraft`) or discard. */
  reloadTask(taskId: string): Promise<Readable<{ item: SyncItem | null; tombstoned: boolean; draft: SyncDraft | null; sync: SyncOutcome }>> {
    const empty = { item: null, tombstoned: false, draft: null, sync: { status: "signed_out" } as SyncOutcome };
    return this.guarded(this.session, { locked: false, value: empty } as Readable<typeof empty>, async s => {
      const reason = await this.lockReason(s);
      if (reason) return { locked: true, reason };
      const sync = await this.syncSafe(s);
      const after = await this.lockReason(s);
      if (after) return { locked: true, reason: after };
      const ns = s.ns;
      if (!ns) return { locked: false, value: { ...empty, sync } };
      const value = {
        item: (await ns.get<SyncItem>(K.item("task", taskId))) ?? null,
        tombstoned: (await ns.get(K.tomb("task", taskId))) !== undefined,
        draft: (await ns.get<SyncDraft>(K.draft(taskId))) ?? null, sync,
      };
      this.live(s);
      if (s.ns !== ns) throw new StaleSession();
      return { locked: false, value };
    });
  }

  private async editSafe(s: Session, kind: "title" | "delete", taskId: string, title: string | undefined, rebase: boolean): Promise<EditResult> {
    try { return await this.editCore(s, kind, taskId, title, rebase); } catch (error) {
      if (error instanceof StorageFailure) return { ok: false, reason: "storage_error" };
      throw error;
    }
  }

  private async editCore(s: Session, kind: "title" | "delete", taskId: string, title: string | undefined, rebase: boolean): Promise<EditResult> {
    this.live(s);
    const lock = await this.lockReason(s);
    if (lock) return { ok: false, reason: lock === "resyncing" ? "resyncing" : "locked" };
    if (kind === "title" && (typeof title !== "string" || title.length === 0 || title.length > MAX_TITLE_LENGTH ||
        title.trim() !== title || title.includes("\0"))) return { ok: false, reason: "invalid_title" };
    const ns = s.ns;
    if (!ns) return { ok: false, reason: "unknown_task" };
    if ((await ns.get(K.tomb("task", taskId))) !== undefined) return { ok: false, reason: "deleted" };
    const item = await ns.get<SyncItem>(K.item("task", taskId));
    if (!item) return { ok: false, reason: "unknown_task" };
    const draft = await ns.get<SyncDraft>(K.draft(taskId));
    if (draft && !rebase) {
      if (draft.kind !== kind) return { ok: false, reason: "draft_exists" };
      const cmd = (await ns.list<SyncCommand>("cmd/")).find(row => row.value.taskId === taskId)?.value;
      const stage = new Stage(ns);
      if (draft.status === "queued") {
        if (kind === "delete") return { ok: true, status: "queued", commandId: draft.commandId };
        // Only a command which never left the device may change its payload (the commandId stays valid).
        if (!cmd || cmd.state !== "queued" || cmd.attempts > 0) return { ok: false, reason: "busy" };
        stage.put(K.draft(taskId), { ...draft, title });
        stage.put(K.command(cmd.seq), { ...cmd, title });
        await this.commit(s, stage);
        this.scheduleAt(s, this.sched.now());
        return { ok: true, status: "queued", commandId: draft.commandId };
      }
      // conflict / unsendable / local: only the text changes; sending is an explicit `resubmitDraft`.
      stage.put(K.draft(taskId), { ...draft, title });
      await this.commit(s, stage);
      return { ok: true, status: draft.status, commandId: draft.commandId };
    }
    const baseItemRevision = item.revision;
    const acquired = await this.acquireToken(s, taskId, baseItemRevision);
    this.live(s);
    if (s.ns !== ns) return { ok: false, reason: "stale_base" };
    let token: string | null = null;
    if (acquired.kind === "ok") token = acquired.token;
    else if (acquired.kind === "unavailable") return { ok: false, reason: "unavailable" };
    else if (acquired.kind === "gone") return { ok: false, reason: "deleted" };
    else if (acquired.kind === "conflict") return { ok: false, reason: "stale_base" };
    else if (acquired.kind === "blocked" && (acquired.outcome.status === "locked" || acquired.outcome.status === "signed_out")) return { ok: false, reason: "locked" };
    // else offline / throttled / 401: queued WITHOUT a token, acquired (with the same validation) at send time.
    const meta = await this.readMeta(s);
    if (!meta || (await this.lockReason(s))) return { ok: false, reason: "locked" };
    const stage = new Stage(ns);
    const current = await stage.get<SyncItem>(K.item("task", taskId));
    if (!current || current.revision !== baseItemRevision) return { ok: false, reason: "stale_base" };
    const commandId = this.newId();
    const seq = meta.nextSeq;
    stage.put(K.meta, { ...meta, nextSeq: seq + 1 });
    for (const row of await stage.list<SyncCommand>("cmd/")) if (row.value.taskId === taskId) stage.del(row.key);
    stage.put(K.command(seq), {
      seq, commandId, kind, taskId, ...(kind === "title" ? { title } : {}), expectedRevision: token, baseItemRevision,
      writeAreaId: areaOf(current), restoreGeneration: meta.generation, state: "queued", attempts: 0, failures: 0, notBefore: 0, recheck: false,
    } satisfies SyncCommand);
    stage.put(K.draft(taskId), {
      taskId, kind, ...(kind === "title" ? { title } : {}), areaId: areaOf(current), baseItemRevision,
      status: "queued", reason: null, reloadOffered: false, commandId,
    } satisfies SyncDraft);
    await this.commit(s, stage);
    if (acquired.kind === "failure" && acquired.res.kind === "unauthorized") {
      // The edit is saved first (counted if the identity is wiped), then the 401 is handled like any other.
      const outcome = await this.onUnauthorized(s, acquired.res.code);
      if (outcome.status === "signed_out") return { ok: false, reason: "inactive" };
      return { ok: true, status: "queued", commandId };
    }
    this.scheduleAt(s, this.sched.now());
    return { ok: true, status: "queued", commandId };
  }
}
