/**
 * R2c.2a staging-only bootstrap, Area bootstrap and authorized change feed.
 *
 * SELECT-only. Call it ONLY on the pinned, preflighted, authenticated snapshot
 * (see readPreflightedChangeFeedPage); the actor comes from the verified session,
 * never from a request. Output is a raw page: the HTTP layer turns grant notices
 * into encrypted Area-bootstrap cursors and the position into the next cursor.
 *
 * Visibility of a change_log entry at seq s in Area A for actor U:
 *  - A is a private Area owned by U, or
 *  - U was a member of A at s (the latest membership row of (A, U) with seq < s is
 *    member_add / member_role), or
 *  - the entry is a membership row about U itself.
 * Membership rows about other users are never emitted. Activity in any other Area
 * is neither read nor able to change content or position of a page.
 */
import { DatabaseSync } from "node:sqlite";
import { isReadableStagingProjectId } from "./target-project-id";
import { MAX_SCOPED_READ_AREAS } from "./target-staging-read-limits";
import type { FeedClaims, FeedPosition } from "./target-staging-feed-cursor";
import type { TargetReadAreaAccess, TargetReadLinearization } from "./target-task-read-model";

export const FEED_PAGE_LIMIT = 100;
/** Candidate batches examined per request; bounds work when many entries are not emittable. */
const MAX_FEED_BATCHES = 20;
const FAR = Number.MAX_SAFE_INTEGER;
const ROLES = new Set(["viewer", "editor", "admin"]);

export type FeedItem =
  | { type: "upsert"; kind: "task"; id: string; revision: number; areaId: string;
      areaKind: "private" | "shared"; title: string; projectId: string | null;
      effectiveAreaId: string; assignedToMe?: boolean }
  | { type: "upsert"; kind: "project"; id: string; revision: number; areaId: string;
      areaKind: "private" | "shared"; title: string }
  | { type: "left_scope"; kind: "task" | "project"; id: string; areaId: string }
  | { type: "tombstone"; kind: "task" | "project"; id: string; areaId: string; revision: number }
  /** `grantSeq` is turned into `areaCursor` by the HTTP layer. */
  | { type: "access_granted"; areaId: string; role: string; grantSeq: number }
  | { type: "role_changed"; areaId: string; role: string }
  | { type: "access_lost"; areaId: string };

export type TargetChangeFeedPage = {
  ok: true;
  phase: "bootstrap" | "feed" | "area_bootstrap";
  items: FeedItem[];
  /** Another page exists (bootstrap) / the page was full (feed). */
  more: boolean;
  /** Area bootstrap finished: no cursor is returned. */
  done: boolean;
  next: FeedPosition | null;
  actorUserId: string;
  epoch: number;
  linearization: TargetReadLinearization;
};
export type TargetChangeFeedResult =
  | TargetChangeFeedPage
  | { ok: false; reason: "cursor_invalid" | "resync_required" | "unavailable" };

type ReadableArea = {
  areaId: string; areaKind: "private" | "shared"; policyRevision: number; access: TargetReadAreaAccess;
};
type MemberRow = { seq: number; op: "member_add" | "member_remove" | "member_role"; role: string | null };
type Candidate = {
  seq: number; kind: string; id: string; areaId: string; op: string;
  revision: number | null; role: string | null;
};
type ItemRow = {
  kind: "project" | "task"; id: string; title: string; projectId: string | null;
  revision: number; assignee: string | null;
};

const denied = (reason: "cursor_invalid" | "resync_required" | "unavailable"): TargetChangeFeedResult =>
  ({ ok: false, reason });
const isMember = (row: Pick<MemberRow, "op"> | undefined): boolean =>
  row !== undefined && row.op !== "member_remove";
const byBinary = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The actor's current readable Areas: private owned + shared where member. Index-driven. */
function readableAreas(db: DatabaseSync, actor: string): ReadableArea[] | null {
  const rows = db.prepare(`SELECT * FROM (
      SELECT a.id AS areaId, a.kind AS areaKind, a.policy_revision AS policyRevision, NULL AS role
        FROM areas a INDEXED BY areas_by_owner_kind
        JOIN workspaces w ON w.id = a.workspace_id
        JOIN identities actor ON actor.id = a.owner_user_id
       WHERE a.owner_user_id = ? AND a.kind = 'private' AND w.kind = 'personal'
         AND w.owner_user_id = a.owner_user_id
      UNION ALL
      SELECT a.id, a.kind, a.policy_revision, member.role
        FROM area_members member INDEXED BY area_members_by_user_area
        JOIN identities actor ON actor.id = member.user_id
        JOIN areas a ON a.id = member.area_id
        JOIN workspaces w ON w.id = a.workspace_id
       WHERE member.user_id = ? AND a.kind = 'shared' AND w.kind = 'shared'
         AND w.owner_user_id = a.owner_user_id AND member.role IN ('viewer', 'editor', 'admin')
    ) ORDER BY areaId COLLATE BINARY ASC LIMIT ?`)
    .all(actor, actor, MAX_SCOPED_READ_AREAS + 1) as
    { areaId: string; areaKind: "private" | "shared"; policyRevision: number; role: string | null }[];
  if (rows.length > MAX_SCOPED_READ_AREAS) return null;
  const out: ReadableArea[] = [];
  for (const row of rows) {
    if (!isReadableStagingProjectId(row.areaId)) continue;
    const access = row.areaKind === "private" ? "private-owner" : row.role;
    if (access !== "private-owner" && !ROLES.has(access ?? "")) return null;
    out.push({
      areaId: row.areaId, areaKind: row.areaKind, policyRevision: row.policyRevision,
      access: access as TargetReadAreaAccess,
    });
  }
  return out;
}

/**
 * All membership rows about THIS actor, per Area, in sequence order. The entity index
 * is Area-keyed and has no member column, so this scans the membership rows of the
 * log (task/project rows are never touched). A member_user_id index would make it a
 * seek; that is a possible schema follow-up, not needed for correctness.
 */
function ownMembershipRows(db: DatabaseSync, actor: string): Map<string, MemberRow[]> {
  const rows = db.prepare(`SELECT area_id AS areaId, seq, op, member_role AS role
      FROM change_log INDEXED BY change_log_by_entity
     WHERE entity_kind = 'membership' AND member_user_id = ?
     ORDER BY entity_id COLLATE BINARY ASC, seq ASC`).all(actor) as
    { areaId: string; seq: number; op: MemberRow["op"]; role: string | null }[];
  const byArea = new Map<string, MemberRow[]>();
  for (const row of rows) {
    const list = byArea.get(row.areaId) ?? [];
    list.push({ seq: row.seq, op: row.op, role: row.role });
    byArea.set(row.areaId, list);
  }
  return byArea;
}

/** Membership state at `seq` (rows with row.seq <= seq): the latest row decides. */
function memberAt(rows: MemberRow[] | undefined, seq: number): boolean {
  let latest: MemberRow | undefined;
  for (const row of rows ?? []) if (row.seq <= seq) latest = row;
  return isMember(latest);
}

function itemFromRow(row: ItemRow, area: ReadableArea, actor: string): FeedItem {
  if (row.kind === "project") {
    return {
      type: "upsert", kind: "project", id: row.id, revision: row.revision,
      areaId: area.areaId, areaKind: area.areaKind, title: row.title,
    };
  }
  return {
    type: "upsert", kind: "task", id: row.id, revision: row.revision, areaId: area.areaId,
    areaKind: area.areaKind, title: row.title, projectId: row.projectId,
    effectiveAreaId: area.areaId,
    ...(area.areaKind === "shared" ? { assignedToMe: row.assignee === actor } : {}),
  };
}

/** Current state of one Area, keyset-ordered by (kind, id); never an offset. */
function areaRowsAfter(
  db: DatabaseSync, areaId: string, after: [string, string] | null, limit: number,
): ItemRow[] {
  const [kind, id] = after ?? ["", ""];
  return db.prepare(`SELECT kind, id, title, projectId, revision, assignee FROM (
      SELECT 'project' AS kind, p.id AS id, p.title AS title, NULL AS projectId,
             p.revision AS revision, NULL AS assignee
        FROM projects p INDEXED BY projects_by_area WHERE p.area_id = ?
      UNION ALL
      SELECT 'task', t.id, t.title, t.project_id, t.revision, t.assignee_user_id
        FROM tasks t INDEXED BY tasks_by_area WHERE t.area_id = ?
      UNION ALL
      SELECT 'task', t.id, t.title, t.project_id, t.revision, t.assignee_user_id
        FROM projects p INDEXED BY projects_by_area
        CROSS JOIN tasks t INDEXED BY tasks_by_project
       WHERE p.area_id = ? AND t.project_id = p.id AND t.area_id IS NULL
    ) WHERE kind > ? OR (kind = ? AND id COLLATE BINARY > ?)
    ORDER BY kind COLLATE BINARY ASC, id COLLATE BINARY ASC LIMIT ?`)
    .all(areaId, areaId, areaId, kind, kind, id, limit) as ItemRow[];
}

type Collected = { items: FeedItem[]; contributing: Map<string, ReadableArea> };

/**
 * Serve items of `areas` (ascending) after the keyset position until `FEED_PAGE_LIMIT`.
 * Returns the last consumed key and whether more may follow.
 */
function collectItems(
  db: DatabaseSync, actor: string, areas: ReadableArea[], start: [string, string, string] | null,
  into: Collected,
): { full: boolean; last: [string, string, string] | null } {
  let last: [string, string, string] | null = start;
  for (const area of areas) {
    if (start && area.areaId < start[0]) continue;
    let after: [string, string] | null = start && area.areaId === start[0] ? [start[1], start[2]] : null;
    for (;;) {
      const want = FEED_PAGE_LIMIT - into.items.length;
      if (want <= 0) return { full: true, last };
      const rows = areaRowsAfter(db, area.areaId, after, want + 1);
      for (let i = 0; i < rows.length; i++) {
        if (into.items.length >= FEED_PAGE_LIMIT) return { full: true, last };
        const row = rows[i];
        last = [area.areaId, row.kind, row.id];
        after = [row.kind, row.id];
        if (!isReadableStagingProjectId(row.id)) continue;
        into.items.push(itemFromRow(row, area, actor));
        into.contributing.set(area.areaId, area);
      }
      if (rows.length < want + 1) break;
    }
  }
  return { full: false, last };
}

const linearizationOf = (actor: string, areas: Map<string, ReadableArea>): TargetReadLinearization => ({
  actorUserId: actor,
  areas: [...areas.values()].sort((a, b) => byBinary(a.areaId, b.areaId)).map(area => ({
    areaId: area.areaId, areaKind: area.areaKind, policyRevision: area.policyRevision, access: area.access,
  })),
});

function bootstrapPage(
  db: DatabaseSync, actor: string, epoch: number, pos: Extract<FeedPosition, { ph: "b" }> | null,
): TargetChangeFeedResult {
  const readable = readableAreas(db, actor);
  if (!readable) return denied("unavailable");
  // The watermark is captured with the FIRST page in its snapshot, then carried.
  const watermark = pos ? pos.w : (db.prepare("SELECT COALESCE(MAX(seq), 0) AS w FROM change_log")
    .get() as { w: number }).w;
  const into: Collected = { items: [], contributing: new Map() };
  const { full, last } = collectItems(db, actor, readable, pos ? pos.k : null, into);

  // Areas the actor could read at bootstrap start (seq <= W) but cannot now, within the
  // part of the list this page passed: skipped, announced exactly once as access_lost.
  const own = ownMembershipRows(db, actor);
  const startArea = pos?.k ? pos.k[0] : null;
  const endArea = full && last ? last[0] : null;
  const current = new Set(readable.map(area => area.areaId));
  const lost: string[] = [];
  for (const [areaId, rows] of own) {
    if (current.has(areaId) || !isReadableStagingProjectId(areaId) || !memberAt(rows, watermark)) continue;
    if ((startArea === null || areaId >= startArea) && (endArea === null || areaId <= endArea)) lost.push(areaId);
  }
  lost.sort(byBinary);
  const items: FeedItem[] = [...into.items, ...lost.map((areaId): FeedItem => ({ type: "access_lost", areaId }))];
  return {
    ok: true, phase: "bootstrap", items, more: full, done: false, actorUserId: actor, epoch,
    next: full && last ? { ph: "b", w: watermark, k: last } : { ph: "f", p: watermark },
    linearization: linearizationOf(actor, into.contributing),
  };
}

function areaBootstrapPage(
  db: DatabaseSync, actor: string, epoch: number, pos: Extract<FeedPosition, { ph: "a" }>,
): TargetChangeFeedResult {
  const readable = readableAreas(db, actor);
  if (!readable) return denied("unavailable");
  // Not readable (any more): nothing to serve and nothing revealed; the main feed carries access_lost.
  const area = readable.find(candidate => candidate.areaId === pos.a);
  const into: Collected = { items: [], contributing: new Map() };
  let full = false;
  let last: [string, string, string] | null = null;
  if (area) {
    ({ full, last } = collectItems(db, actor, [area], pos.k ? [area.areaId, pos.k[0], pos.k[1]] : null, into));
  }
  return {
    ok: true, phase: "area_bootstrap", items: into.items, more: full, done: !full, actorUserId: actor, epoch,
    next: full && last ? { ph: "a", a: pos.a, w: pos.w, k: [last[1], last[2]] } : null,
    linearization: linearizationOf(actor, into.contributing),
  };
}

/** One entry of an interval the actor was a member of (exclusive bounds), by Area index. */
function intervalEntries(
  db: DatabaseSync, areaId: string, fromSeq: number, toSeq: number, limit: number,
): Candidate[] {
  return (db.prepare(`SELECT seq, entity_kind AS kind, entity_id AS id, area_id AS areaId, op,
        revision, NULL AS role
      FROM change_log INDEXED BY change_log_by_area
     WHERE area_id = ? AND seq > ? AND seq < ? AND entity_kind <> 'membership'
     ORDER BY seq ASC LIMIT ?`).all(areaId, fromSeq, toSeq, limit) as Candidate[]);
}

/** Smallest `limit` visible entries with seq > after, across the actor's relevant Areas only. */
function nextCandidates(
  db: DatabaseSync, after: number, limit: number,
  relevant: { areaId: string; spans: Array<[number, number]>; own: MemberRow[] }[],
): Candidate[] {
  const out: Candidate[] = [];
  for (const area of relevant) {
    for (const [lo, hi] of area.spans) {
      if (hi <= after + 1) continue;
      out.push(...intervalEntries(db, area.areaId, Math.max(after, lo), hi, limit));
    }
    for (const row of area.own) {
      if (row.seq > after) {
        out.push({ seq: row.seq, kind: "membership", id: area.areaId, areaId: area.areaId, op: row.op,
          revision: null, role: row.role });
      }
    }
  }
  return out.sort((a, b) => a.seq - b.seq).slice(0, limit);
}

type CurrentRow = {
  kind: "project" | "task"; id: string; title: string; projectId: string | null;
  revision: number; assignee: string | null; areaId: string;
};

function currentItem(db: DatabaseSync, kind: "task" | "project", id: string): CurrentRow | undefined {
  return (kind === "task"
    ? db.prepare(`SELECT 'task' AS kind, t.id AS id, t.title AS title, t.project_id AS projectId,
          t.revision AS revision, t.assignee_user_id AS assignee, COALESCE(t.area_id, p.area_id) AS areaId
        FROM tasks t LEFT JOIN projects p ON p.id = t.project_id WHERE t.id = ?`).get(id)
    : db.prepare(`SELECT 'project' AS kind, p.id AS id, p.title AS title, NULL AS projectId,
          p.revision AS revision, NULL AS assignee, p.area_id AS areaId
        FROM projects p WHERE p.id = ?`).get(id)) as CurrentRow | undefined;
}

function feedPage(
  db: DatabaseSync, actor: string, epoch: number, position: number,
): TargetChangeFeedResult {
  const readable = readableAreas(db, actor);
  if (!readable) return denied("unavailable");
  const readableById = new Map(readable.map(area => [area.areaId, area] as const));
  const own = ownMembershipRows(db, actor);
  // Relevant Areas: private owned + current membership (readable) + any Area with an own
  // membership row after the position. Nothing else is ever queried.
  const relevant: { areaId: string; spans: Array<[number, number]>; own: MemberRow[] }[] = [];
  const ids = new Set<string>(readable.map(area => area.areaId));
  for (const [areaId, rows] of own) if (rows.some(row => row.seq > position)) ids.add(areaId);
  if (ids.size > MAX_SCOPED_READ_AREAS) return denied("unavailable");
  for (const areaId of [...ids].sort(byBinary)) {
    if (!isReadableStagingProjectId(areaId)) continue;
    const rows = own.get(areaId) ?? [];
    const isPrivate = readableById.get(areaId)?.areaKind === "private";
    const spans: Array<[number, number]> = [];
    if (isPrivate) spans.push([0, FAR]);
    else rows.forEach((row, index) => {
      if (isMember(row)) spans.push([row.seq, rows[index + 1]?.seq ?? FAR]);
    });
    relevant.push({ areaId, spans, own: rows.filter(row => row.seq > position) });
  }

  const items: FeedItem[] = [];
  const contributing = new Map<string, ReadableArea>();
  let examined = position;
  let more = false;
  batches: for (let batch = 0; batch < MAX_FEED_BATCHES; batch++) {
    const candidates = nextCandidates(db, examined, FEED_PAGE_LIMIT + 1, relevant);
    for (const entry of candidates) {
      examined = entry.seq;
      const item = feedItem(db, actor, entry, readableById, contributing);
      if (item) items.push(item);
      if (items.length >= FEED_PAGE_LIMIT) { more = true; break batches; }
    }
    if (candidates.length <= FEED_PAGE_LIMIT) break;
    if (batch === MAX_FEED_BATCHES - 1) more = true;
  }
  return {
    ok: true, phase: "feed", items, more, done: false, actorUserId: actor, epoch,
    next: { ph: "f", p: examined }, linearization: linearizationOf(actor, contributing),
  };
}

/** Map one VISIBLE entry to its content-free notice, or to current state for an upsert. */
function feedItem(
  db: DatabaseSync, actor: string, entry: Candidate,
  readableById: Map<string, ReadableArea>, contributing: Map<string, ReadableArea>,
): FeedItem | null {
  if (entry.kind === "membership") {
    if (entry.op === "member_add") {
      return { type: "access_granted", areaId: entry.areaId, role: entry.role ?? "viewer", grantSeq: entry.seq };
    }
    if (entry.op === "member_role") return { type: "role_changed", areaId: entry.areaId, role: entry.role ?? "viewer" };
    return { type: "access_lost", areaId: entry.areaId };
  }
  if ((entry.kind !== "task" && entry.kind !== "project") || !isReadableStagingProjectId(entry.id)) return null;
  const kind = entry.kind;
  if (entry.op === "leave") return { type: "left_scope", kind, id: entry.id, areaId: entry.areaId };
  if (entry.op === "tombstone") {
    return { type: "tombstone", kind, id: entry.id, areaId: entry.areaId, revision: entry.revision ?? 0 };
  }
  if (entry.op !== "upsert") return null;
  // Content only for what the actor can read RIGHT NOW; otherwise a later leave /
  // tombstone / access_lost explains the disappearance.
  const row = currentItem(db, kind, entry.id);
  const area = row ? readableById.get(row.areaId) : undefined;
  if (!row || !area) return null;
  contributing.set(area.areaId, area);
  return itemFromRow(row, area, actor);
}

/** Verify the claims against the authenticated snapshot; uid first, then generation, then epoch. */
export function readChangeFeedPage(
  db: DatabaseSync,
  request: { actorUserId: string; restoreGeneration: string; claims: FeedClaims | null },
): TargetChangeFeedResult {
  try {
    const { actorUserId: actor, claims } = request;
    const identity = db.prepare("SELECT revocation_epoch AS epoch FROM identities WHERE id = ?")
      .get(actor) as { epoch: number } | undefined;
    if (!identity) return denied("unavailable");
    if (claims) {
      if (claims.uid !== actor) return denied("cursor_invalid");
      if (claims.gen !== request.restoreGeneration) return denied("resync_required");
      if (claims.epoch !== identity.epoch) return denied("cursor_invalid");
    }
    const pos = claims?.pos ?? null;
    if (pos === null) return bootstrapPage(db, actor, identity.epoch, null);
    if (pos.ph === "b") return bootstrapPage(db, actor, identity.epoch, pos);
    if (pos.ph === "a") return areaBootstrapPage(db, actor, identity.epoch, pos);
    return feedPage(db, actor, identity.epoch, pos.p);
  } catch {
    return denied("unavailable");
  }
}
