/**
 * R2 staging-only authenticated boundary for the isolated task read model.
 *
 * This does NOT issue sessions, expose a route, or activate target storage.
 * A future server-only session issuer must sign these purpose-scoped claims
 * with a dedicated key; legacy owner cookies and passkeys are NOT R2 identities.
 * Callers must preflight the isolated database path with
 * inspectIsolatedTargetStore({ mode: "r2-model" }) before opening a read-only DB.
 *
 * Do not wire to startup, UI, sync, integrations, or AI until R2 also provides
 * issuance/revocation, revision-stable reads, sync barriers, and cache isolation.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  listIsolatedTargetTasks, readIsolatedTargetTask,
} from "./target-task-read-model";
import type {
  TargetTaskDetailResult, TargetTaskListResult, TargetTaskScope,
} from "./target-task-read-model";

export const TARGET_STAGING_TASK_READ_AUDIENCE = "lumi-target-task-read-staging-v1";
const TOKEN_DOMAIN = "lumi:r2:target-task-read:staging:v1\0";
const MAX_LIFETIME_SECONDS = 15 * 60;
const ID_PATTERN = /^[A-Za-z0-9_.:@-]{1,120}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/** Only the server may provide this key; never accept it from a request. */
export interface TargetStagingReadCredential {
  sessionToken: string;
  signingKey: Uint8Array;
}
export interface TargetStagingTaskListRequest {
  scope: TargetTaskScope;
  limit?: number;
  afterTaskId?: string | null;
}
export interface TargetStagingTaskDetailRequest { taskId: string }

export type AuthenticatedTargetTaskListResult =
  | TargetTaskListResult
  | { ok: false; reason: "unauthorized"; tasks: []; nextCursor: null };
export type AuthenticatedTargetTaskDetailResult =
  | TargetTaskDetailResult
  | { ok: false; reason: "unauthorized"; task: null };

const unauthList = (): AuthenticatedTargetTaskListResult =>
  ({ ok: false, reason: "unauthorized", tasks: [], nextCursor: null });
const unauthDetail = (): AuthenticatedTargetTaskDetailResult =>
  ({ ok: false, reason: "unauthorized", task: null });

type ReadClaims = { v: 1; aud: string; sub: string; gen: string; iat: number; exp: number };

/**
 * Verify first, then bind the actor to an existing identity and the current
 * SQLite restore generation. Never use actor IDs or generations sent in a task
 * query. Every failure is indistinguishable and returns no task content.
 *
 * The metadata/identity lookup is not a substitute for staging path preflight.
 * No read is allowed from an activated or unknown-schema target store.
 */
function verifiedActor(db: DatabaseSync, access: TargetStagingReadCredential): string | null {
  if (!access || typeof access.sessionToken !== "string" ||
      !(access.signingKey instanceof Uint8Array) ||
      access.signingKey.byteLength < 32 || access.sessionToken.length > 4096 ||
      !TOKEN_PATTERN.test(access.sessionToken)) return null;
  try {
    const [encoded, signature] = access.sessionToken.split(".");
    const bytes = Buffer.from(encoded, "base64url");
    const actual = Buffer.from(signature, "base64url");
    if (encoded !== bytes.toString("base64url") ||
        signature !== actual.toString("base64url")) return null;
    const expected = createHmac("sha256", access.signingKey)
      .update(TOKEN_DOMAIN).update(encoded).digest();
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;

    const claims: ReadClaims = JSON.parse(bytes.toString("utf8"));
    if (!claims || typeof claims !== "object" || Array.isArray(claims) ||
        Object.keys(claims).sort().join(",") !== "aud,exp,gen,iat,sub,v" ||
        claims.v !== 1 || claims.aud !== TARGET_STAGING_TASK_READ_AUDIENCE ||
        typeof claims.sub !== "string" || !ID_PATTERN.test(claims.sub) ||
        typeof claims.gen !== "string" || !UUID_PATTERN.test(claims.gen) ||
        !Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp)) return null;
    const now = Math.floor(Date.now() / 1000);
    if (claims.iat > now || claims.iat < now - MAX_LIFETIME_SECONDS ||
        claims.exp <= now || claims.exp <= claims.iat ||
        claims.exp - claims.iat > MAX_LIFETIME_SECONDS) return null;

    const metadata = db.prepare(
      "SELECT key, value FROM metadata WHERE key IN ('schema_version','write_protocol','activated','restore_generation')",
    ).all() as { key: string; value: string }[];
    const values = new Map(metadata.map(row => [row.key, row.value]));
    if (metadata.length !== 4 || values.size !== 4 ||
        values.get("schema_version") !== "1" ||
        values.get("write_protocol") !== "per-item-only" ||
        values.get("activated") !== "false" ||
        values.get("restore_generation") !== claims.gen) return null;
    const identity = db.prepare("SELECT 1 FROM identities WHERE id = ?").get(claims.sub);
    return identity === undefined ? null : claims.sub;
  } catch {
    return null;
  }
}

function invalidActorOverride(request: unknown): boolean {
  return !!request && typeof request === "object" && "actorUserId" in request;
}

/**
 * The generation check and ACL query must observe the same SQLite snapshot.
 * BEGIN/ROLLBACK on a preflighted, read-only handle never writes store data.
 * If another operation owns a transaction, fail closed without rolling it back.
 */
function inReadSnapshot<T>(db: DatabaseSync, read: () => T, denied: () => T): T {
  let started = false;
  try {
    db.exec("BEGIN");
    started = true;
    const result = read();
    db.exec("ROLLBACK");
    started = false;
    return result;
  } catch {
    if (started) {
      try { db.exec("ROLLBACK"); } catch { /* fail closed */ }
    }
    return denied();
  }
}

/** Authenticate independently for each list page, then use current Area ACLs. */
export function listAuthenticatedIsolatedTargetTasks(
  db: DatabaseSync,
  access: TargetStagingReadCredential,
  request: TargetStagingTaskListRequest,
): AuthenticatedTargetTaskListResult {
  if (!request || typeof request !== "object" || invalidActorOverride(request)) {
    return { ok: false, reason: "invalid_request", tasks: [], nextCursor: null };
  }
  return inReadSnapshot(db, () => {
    const actorUserId = verifiedActor(db, access);
    if (!actorUserId) return unauthList();
    return listIsolatedTargetTasks(db, {
      actorUserId, scope: request.scope, limit: request.limit, afterTaskId: request.afterTaskId,
    });
  }, unauthList);
}

/** Direct task reads have the same actor and Area boundary as lists. */
export function readAuthenticatedIsolatedTargetTask(
  db: DatabaseSync,
  access: TargetStagingReadCredential,
  request: TargetStagingTaskDetailRequest,
): AuthenticatedTargetTaskDetailResult {
  if (!request || typeof request !== "object" || invalidActorOverride(request)) {
    return { ok: false, reason: "invalid_request", task: null };
  }
  return inReadSnapshot(db, () => {
    const actorUserId = verifiedActor(db, access);
    if (!actorUserId) return unauthDetail();
    return readIsolatedTargetTask(db, { actorUserId, taskId: request.taskId });
  }, unauthDetail);
}
