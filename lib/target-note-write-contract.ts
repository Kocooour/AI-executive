/**
 * R2d.2c.1 — staging-only NOTE write preflight, NOT a write endpoint.
 *
 * Call ONLY after the existing signed writable credential has been verified
 * server-side, against the canonical preflighted store. For a future mutation,
 * call checkTargetNoteWriteContract again inside the pinned BEGIN IMMEDIATE
 * transaction; the preview is NOT authority to mutate. No HTTP, sync, mutation,
 * receipts, audit events, delete or production activation is introduced here.
 *
 * A direct project note inherits the project's current Area. References,
 * backlinks and client-provided Area IDs never confer permissions.
 */
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { readAuthorizedTargetNote, type TargetAuthorizedNote } from "./target-note-access";
import {
  canWriteIsolatedTargetArea, targetStoreRestoreGeneration,
} from "./target-task-write-preflight";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEX64 = /^[0-9a-f]{64}$/;

export interface TargetNoteWriteContractRequest {
  readonly noteId: string;
  /** Preview digest of exact note, parent, policy, actor and restore generation. */
  readonly expectedRevision: string;
  /** Expected effective Area, not an authority to select a different Area. */
  readonly writeAreaId: string;
  readonly restoreGeneration: string;
}

export type TargetNoteWriteContractResult =
  | { ok: true; noteRevision: number; parentRevision: number | null; areaId: string }
  | { ok: false; reason:
      "invalid_request" | "resync_required" | "unavailable" |
      "write_area_mismatch" | "stale_revision" };

export type TargetNoteWritePreview =
  | { ok: true; expectedRevision: string; writeAreaId: string; restoreGeneration: string }
  | { ok: false; reason: "unavailable" };

function validNoteId(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value &&
    value !== "" && value !== "." && value !== ".." &&
    Buffer.byteLength(value, "utf8") <= 512 &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

export function validTargetNoteWriteContractRequest(value: unknown): value is TargetNoteWriteContractRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  return Object.keys(r).sort().join(",") ===
      "expectedRevision,noteId,restoreGeneration,writeAreaId" &&
    // Effective Area IDs come from the canonical note reader, which accepts
    // non-ASCII, whitespace-containing and longer (<512-byte) SQLite IDs.
    // Match that reader rather than imposing the unrelated actor-ID pattern.
    validNoteId(r.noteId) && typeof r.expectedRevision === "string" &&
    HEX64.test(r.expectedRevision) && typeof r.writeAreaId === "string" &&
    validNoteId(r.writeAreaId) && typeof r.restoreGeneration === "string" &&
    UUID.test(r.restoreGeneration);
}

function editableNote(note: TargetAuthorizedNote): boolean {
  const access = note.linearization.areas[0]?.access;
  return access === "private-owner" || access === "editor" || access === "admin";
}

/** Content-free, deterministic optimistic marker. Never serialize note text. */
export function noteWriteRevision(note: TargetAuthorizedNote, actor: string, generation: string): string {
  const a = note.linearization.areas[0];
  return createHash("sha256").update(JSON.stringify([
    "r2d.2c.1", actor, generation.toLowerCase(), note.guard.noteId,
    note.guard.projectId, note.guard.areaId, note.guard.noteRevision,
    note.guard.parentRevision, a.areaKind, a.policyRevision, a.access,
  ])).digest("hex");
}

/**
 * Only a trusted internal caller holding a verified write credential may
 * request a preview. This primitive intentionally accepts no user token and
 * performs no session verification itself. Return no note title/body.
 */
export function previewTargetNoteWrite(
  db: DatabaseSync, actorUserId: string, noteId: string,
): TargetNoteWritePreview {
  const denied = (): TargetNoteWritePreview => ({ ok: false, reason: "unavailable" });
  try {
    if (!validNoteId(noteId)) return denied();
    const generation = targetStoreRestoreGeneration(db);
    if (!generation || !UUID.test(generation)) return denied();
    const note = readAuthorizedTargetNote(db, { actorUserId, noteId });
    if (!note || !editableNote(note) ||
        !canWriteIsolatedTargetArea(db, actorUserId, note.note.areaId)) return denied();
    return {
      ok: true, expectedRevision: noteWriteRevision(note, actorUserId, generation),
      writeAreaId: note.note.areaId, restoreGeneration: generation,
    };
  } catch { return denied(); }
}

/**
 * Validate at mutation time inside the SAME pinned write transaction (before
 * receipt lookup and before any UPDATE). A viewer, absent note, revoked member,
 * foreign/private note, malformed/oversized row or broken parent fail equally.
 * A wrong Area only becomes distinguishable if the actor can edit BOTH Areas.
 * All returned fields are non-content authorization guards, not a write receipt.
 */
export function checkTargetNoteWriteContract(
  db: DatabaseSync, actorUserId: string, request: TargetNoteWriteContractRequest,
): TargetNoteWriteContractResult {
  if (!validTargetNoteWriteContractRequest(request)) {
    return { ok: false, reason: "invalid_request" };
  }
  try {
    const generation = targetStoreRestoreGeneration(db);
    if (!generation || generation.toLowerCase() !== request.restoreGeneration.toLowerCase()) {
      return { ok: false, reason: "resync_required" };
    }
    const note = readAuthorizedTargetNote(db, { actorUserId, noteId: request.noteId });
    if (!note || !editableNote(note) ||
        !canWriteIsolatedTargetArea(db, actorUserId, note.note.areaId) ||
        !canWriteIsolatedTargetArea(db, actorUserId, request.writeAreaId)) {
      return { ok: false, reason: "unavailable" };
    }
    if (note.note.areaId !== request.writeAreaId) {
      return { ok: false, reason: "write_area_mismatch" };
    }
    if (noteWriteRevision(note, actorUserId, generation) !== request.expectedRevision) {
      return { ok: false, reason: "stale_revision" };
    }
    return {
      ok: true, noteRevision: note.guard.noteRevision,
      parentRevision: note.guard.parentRevision, areaId: note.guard.areaId,
    };
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}
