import { assertCommandWorkspace, contextIdPattern, ContextCommandError, runContextCommand, type CommandHooks } from "./context-commands";
import { compensateClaim, type ClaimReviewStatus, type ContextClaim } from "./context-claims";
import { compensateSubject, type StandaloneSubject } from "./context-subjects";
import { compensateEvidence, summarizeClaim, type EvidenceStepPayload } from "./context-evidence";
import { compensateSource, sourceLabel, type ContextSource } from "./context-sources";
import { getDatabase } from "./server-store";

// Durable, workspace-scoped, multi-step Undo/Redo for the Context Graph (claims, people, organizations,
// sources and claim evidence). The history is the table of change events: nothing in it is ever rewritten, and an
// Undo or Redo is a new compensating command that appends one more event. The stacks are not stored
// anywhere else; they are derived from the events in order, so they are the same after a restart:
//   change  -> goes on the undo stack, and the redo stack is emptied (those steps stay in history)
//   undo    -> takes its target off the undo stack and puts itself on the redo stack
//   redo    -> takes the undone step off the redo stack and puts itself on the undo stack
// A step that was undone and redone is therefore represented by the redo event, which can be undone
// again like any other step.

export type HistoryObjectType = "claim" | "subject" | "source" | "evidence";
export type HistoryAction = "undo" | "redo";
/** "skip" removes a step that can never succeed from its stack, changing no object. */
export type HistoryCommandAction = HistoryAction | "skip";

export interface HistoryStep {
  eventId: string;
  /** What the underlying event is: an ordinary change, or an earlier undo/redo. */
  kind: "change" | "undo" | "redo" | "skip";
  /** The operation the step performs, e.g. "update", "review", "subject.rename". */
  operation: string;
  objectType: HistoryObjectType;
  objectId: string;
  /** Predicate (claims, evidence), name (people and organizations) or provider/identifier (sources) of the object. */
  label: string;
  subjectTitle: string | null;
  subjectType: string | null;
  /** Names before and after, for a rename: the name the object has now and the one the step leads to. */
  fromTitle: string | null;
  toTitle: string | null;
  /** The review state the described action leads to (claims). */
  reviewStatus: ClaimReviewStatus | null;
  /** Evidence steps: what the evidence cites. */
  sourceTitle: string | null;
  at: number;
}

export interface HistoryState {
  undo: HistoryStep | null;
  redo: HistoryStep | null;
  recent: HistoryStep[];
}

type EventRow = {
  id: string; kind: string; reverts_event_id: string | null; operation: string; object_type: string | null; object_id: string;
  before_revision: number | null; after_revision: number | null; before_payload: string | null; after_payload: string | null;
  created_at: number;
};

const recentLimit = 20;
const skippableConflicts = new Set(["undo_conflict", "duplicate_subject", "archived_subject"]);

/** The two stacks of a workspace, newest step first, as event ids. */
export function readHistoryStacks(workspaceId: string) {
  const rows = getDatabase().prepare(`SELECT id, kind, reverts_event_id FROM context_change_events
    WHERE workspace_id = ? ORDER BY sequence, rowid`).all(workspaceId) as Array<{ id: string; kind: string; reverts_event_id: string | null }>;
  let undo: string[] = [];
  let redo: string[] = [];
  for (const row of rows) {
    if (row.kind === "skip" && row.reverts_event_id) {
      // The step is dropped from whichever stack holds it; nothing is put anywhere and the redo stack stays.
      undo = undo.filter((id) => id !== row.reverts_event_id);
      redo = redo.filter((id) => id !== row.reverts_event_id);
    } else if (row.kind === "undo" && row.reverts_event_id) {
      undo = undo.filter((id) => id !== row.reverts_event_id);
      redo.push(row.id);
    } else if (row.kind === "redo" && row.reverts_event_id) {
      redo = redo.filter((id) => id !== row.reverts_event_id);
      undo.push(row.id);
    } else {
      undo.push(row.id);
      redo = [];
    }
  }
  return { undo: undo.reverse(), redo: redo.reverse() };
}

function loadEvents(workspaceId: string, ids: string[]) {
  if (!ids.length) return new Map<string, EventRow>();
  const rows = getDatabase().prepare(`SELECT id, kind, reverts_event_id, operation, object_type, object_id, before_revision,
    after_revision, before_payload, after_payload, created_at FROM context_change_events
    WHERE workspace_id = ? AND id IN (${ids.map(() => "?").join(",")})`).all(workspaceId, ...ids) as unknown as EventRow[];
  return new Map(rows.map((row) => [row.id, row]));
}

function objectTypeOf(event: EventRow): HistoryObjectType {
  if (event.object_type === "subject" || event.object_type === "source" || event.object_type === "evidence") return event.object_type;
  return !event.object_type && event.operation.startsWith("subject.") ? "subject" : "claim";
}

function parse<T>(payload: string | null) {
  return payload ? JSON.parse(payload) as T : null;
}

/**
 * Describes the step an event stands for. `after` is what the event left behind (the state an Undo or
 * Redo of it starts from) and `before` the state it leads back to; `reviewStatus` is the result of the
 * action itself, which is what a person recognises ("Confirmation of the claim").
 */
function describe(event: EventRow, direction: HistoryAction): HistoryStep {
  const objectType = objectTypeOf(event);
  const after = parse<ContextClaim & StandaloneSubject>(event.after_payload);
  const before = parse<ContextClaim & StandaloneSubject>(event.before_payload);
  const step: HistoryStep = { eventId: event.id, kind: event.kind as HistoryStep["kind"], operation: event.operation, objectType,
    objectId: event.object_id, label: "", subjectTitle: null, subjectType: null, fromTitle: null, toTitle: null, reviewStatus: null,
    sourceTitle: null, at: Number(event.created_at) };
  if (objectType === "source") {
    step.label = sourceLabel(parse<ContextSource>(event.after_payload) ?? { provider: null, externalId: null, locator: null, author: null });
  } else if (objectType === "evidence") {
    const payload = parse<EvidenceStepPayload>(event.after_payload);
    step.label = payload?.claim.predicate || "";
    step.subjectTitle = payload?.claim.subjectTitle ?? null;
    step.subjectType = payload?.claim.subjectType ?? null;
    step.sourceTitle = payload?.evidence ? sourceLabel(payload.evidence.source) : null;
  } else if (objectType === "claim") {
    step.label = after?.predicate || "";
    step.subjectTitle = after?.subject?.title ?? null;
    step.subjectType = after?.subject?.type ?? null;
    const result = direction === "undo" ? after : before;
    step.reviewStatus = (result?.reviewStatus as ClaimReviewStatus | undefined) ?? null;
  } else {
    step.label = after?.title || "";
    step.subjectType = after?.type ?? null;
    // Named as the step was done: "Jana → Jan" is the rename from Jana to Jan, whichever way it is applied now.
    step.fromTitle = (direction === "undo" ? before?.title : after?.title) ?? null;
    step.toTitle = (direction === "undo" ? after?.title : before?.title) ?? null;
  }
  return step;
}

export function getContextHistory(workspaceId: string): HistoryState {
  assertCommandWorkspace(workspaceId);
  const stacks = readHistoryStacks(workspaceId);
  const wanted = [...new Set([stacks.undo[0], stacks.redo[0], ...stacks.undo.slice(0, recentLimit)].filter(Boolean))] as string[];
  const events = loadEvents(workspaceId, wanted);
  const step = (id: string | undefined, direction: HistoryAction) => {
    const event = id ? events.get(id) : undefined;
    return event ? describe(event, direction) : null;
  };
  return { undo: step(stacks.undo[0], "undo"), redo: step(stacks.redo[0], "redo"),
    recent: stacks.undo.slice(0, recentLimit).map((id) => step(id, "undo")).filter((item): item is HistoryStep => Boolean(item)) };
}

type HistoryResult = { step: HistoryStep; objectType: HistoryObjectType; object: unknown };

export interface HistoryCommandInput {
  commandId: string;
  workspaceId: string;
  action: HistoryCommandAction;
  /** For "skip": which stack the step is on. */
  stack?: HistoryAction;
  /** The step the client saw on top of the stack; anything else means the history moved on. */
  expectedEventId: string;
}

/** Undo or redo the top step of the workspace's stack, as one command (idempotent, one transaction). */
export function runHistoryCommand(input: HistoryCommandInput, hooks?: CommandHooks) {
  if (input.action !== "undo" && input.action !== "redo" && input.action !== "skip") throw new ContextCommandError("Unknown history action");
  if (input.action === "skip" && input.stack !== "undo" && input.stack !== "redo") throw new ContextCommandError("Skip needs the undo or redo stack");
  const side: HistoryAction = input.action === "skip" ? input.stack! : input.action;
  if (!contextIdPattern.test(String(input.expectedEventId || ""))) throw new ContextCommandError("Expected history step is invalid");
  const result = runContextCommand<HistoryResult>({
    operation: `history.${input.action}`, commandId: input.commandId, workspaceId: input.workspaceId, hooks,
    request: { action: input.action, stack: input.action === "skip" ? input.stack : undefined, workspaceId: input.workspaceId, expectedEventId: input.expectedEventId },
    mutate: () => {
      const stacks = readHistoryStacks(input.workspaceId);
      const top = (side === "undo" ? stacks.undo : stacks.redo)[0];
      if (!top || top !== input.expectedEventId) {
        throw new ContextCommandError(top
          ? "The history changed in the meantime. Nothing was changed."
          : side === "undo" ? "There is nothing to undo" : "There is nothing to redo", 409, "history_changed");
      }
      const event = loadEvents(input.workspaceId, [top]).get(top)!;
      const objectType = objectTypeOf(event);
      // The newest event for this object tells which revision it must still be at: anything else
      // (an edit that is not in the history) is a later change that Undo must not overwrite. For a claim, an
      // evidence event counts too (it changes the claim's revision); sources and evidence compare their content instead.
      const latest = getDatabase().prepare(objectType === "claim" || objectType === "evidence"
        ? `SELECT CASE WHEN object_type = 'evidence' THEN claim_revision ELSE after_revision END AS after_revision FROM context_change_events
          WHERE workspace_id = ? AND (claim_id = ? OR (object_id = ? AND COALESCE(object_type, 'claim') = 'claim')) ORDER BY sequence DESC, rowid DESC LIMIT 1`
        : `SELECT after_revision FROM context_change_events WHERE workspace_id = ? AND object_id = ? AND ? IS NOT NULL ORDER BY sequence DESC, rowid DESC LIMIT 1`)
        .get(input.workspaceId, objectType === "evidence" ? (parse<EvidenceStepPayload>(event.after_payload)?.claim.id ?? "") : event.object_id, event.object_id) as { after_revision: number } | undefined;
      const expectedRevision = Number(latest?.after_revision ?? event.after_revision);
      const step = describe(event, side);
      if (input.action === "skip") {
        // Try the very same compensation as Undo/Redo under the command's write lock. The savepoint
        // rolls back even a successful attempt (including claim review events), so this check never
        // changes an object. Only a known, user-resolvable conflict permits dropping the step.
        const database = getDatabase();
        let failure: unknown;
        database.exec("SAVEPOINT context_skip_preflight");
        try {
          if (objectType === "claim") {
            compensateClaim({ workspaceId: input.workspaceId, id: event.object_id, mode: side, expectedRevision,
              before: parse<ContextClaim>(event.before_payload), after: parse<ContextClaim>(event.after_payload)! });
          } else if (objectType === "evidence") {
            compensateEvidence({ workspaceId: input.workspaceId, id: event.object_id, mode: side, expectedClaimRevision: expectedRevision,
              before: parse<EvidenceStepPayload>(event.before_payload)!, after: parse<EvidenceStepPayload>(event.after_payload)! });
          } else if (objectType === "source") {
            compensateSource({ workspaceId: input.workspaceId, id: event.object_id,
              before: parse<ContextSource>(event.before_payload), after: parse<ContextSource>(event.after_payload)! });
          } else {
            compensateSubject({ workspaceId: input.workspaceId, id: event.object_id, expectedRevision,
              before: parse<StandaloneSubject>(event.before_payload), after: parse<StandaloneSubject>(event.after_payload)! });
          }
        } catch (error) {
          failure = error;
        } finally {
          database.exec("ROLLBACK TO SAVEPOINT context_skip_preflight");
          database.exec("RELEASE SAVEPOINT context_skip_preflight");
        }
        if (!failure) throw new ContextCommandError("This step can still be undone or redone", 409, "skip_not_needed");
        if (!(failure instanceof ContextCommandError && failure.status === 409 && skippableConflicts.has(failure.code))) throw failure;
        // A marker only: no object is touched, and the revision it records is the one the object already has.
        const claimLink = objectType === "evidence" ? { claimId: parse<EvidenceStepPayload>(event.after_payload)!.claim.id, claimRevision: expectedRevision } : {};
        return { objectId: event.object_id, operation: event.operation, objectType, kind: "skip" as const, revertsEventId: event.id, changed: true, ...claimLink,
          result: { step, objectType, object: null }, before: null, after: { revision: expectedRevision, payload: {} } };
      }
      const common = { objectId: event.object_id, operation: event.operation, objectType, kind: side,
        revertsEventId: event.id, changed: true };
      if (objectType === "claim") {
        const { claim, before } = compensateClaim({ workspaceId: input.workspaceId, id: event.object_id, mode: side, expectedRevision,
          before: parse<ContextClaim>(event.before_payload), after: parse<ContextClaim>(event.after_payload)! });
        return { ...common, result: { step, objectType, object: claim }, before: { revision: before.revision, payload: before },
          after: { revision: claim.revision, payload: claim } };
      }
      if (objectType === "evidence") {
        const { evidence, claim, before } = compensateEvidence({ workspaceId: input.workspaceId, id: event.object_id, mode: side, expectedClaimRevision: expectedRevision,
          before: parse<EvidenceStepPayload>(event.before_payload)!, after: parse<EvidenceStepPayload>(event.after_payload)! });
        return { ...common, claimId: claim.id, claimRevision: claim.revision, result: { step, objectType, object: { evidence, claim } },
          before: { revision: before.evidence!.revision, payload: before },
          after: { revision: evidence.revision, payload: { evidence, claim: summarizeClaim(claim) } } };
      }
      if (objectType === "source") {
        const { source, before } = compensateSource({ workspaceId: input.workspaceId, id: event.object_id,
          before: parse<ContextSource>(event.before_payload), after: parse<ContextSource>(event.after_payload)! });
        return { ...common, result: { step, objectType, object: source }, before: { revision: before.revision, payload: before },
          after: { revision: source.revision, payload: source } };
      }
      const { subject, before } = compensateSubject({ workspaceId: input.workspaceId, id: event.object_id, expectedRevision,
        before: parse<StandaloneSubject>(event.before_payload), after: parse<StandaloneSubject>(event.after_payload)! });
      return { ...common, result: { step, objectType, object: subject }, before: { revision: before.revision, payload: before },
        after: { revision: subject.revision, payload: subject } };
    },
  });
  // The stacks as they are now (also for a retry that is answered from the stored result).
  return { ...result, ...getContextHistory(input.workspaceId) };
}
