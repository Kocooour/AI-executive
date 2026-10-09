import type { Entity, Relation } from "./db";

// Several tabs of one browser share the local database (IndexedDB) but each keeps its own state in
// memory. This file holds what they need to work together:
// - one synchronization at a time across tabs (Web Locks), so tabs do not race each other's saves;
// - a check, inside the database transaction that replaces the local copy with the server's, that
//   no tab has written a change the server does not have yet;
// - a channel on which a tab tells the others that the local copy changed, or asks them to save
//   what is being typed before it signs out.

export const tabChannelName = "ai-executive-tabs";
const syncLockName = "ai-executive-sync";

type Locks = { request<T>(name: string, callback: () => Promise<T>): Promise<T> };

// Runs `work` while no other tab of this browser synchronizes. Browsers without Web Locks run it
// directly (as before; the server's revision check still prevents lost updates).
export function withSyncLock<T>(work: () => Promise<T>): Promise<T> {
  const locks = typeof navigator !== "undefined" ? (navigator as Navigator & { locks?: Locks }).locks : undefined;
  return locks ? (locks.request(syncLockName, work) as Promise<T>) : work();
}

// True when the local copy holds something that `known` (what this device knows the server has)
// does not: a record or relation added, changed or removed here. Records are compared by
// updatedAt: every local write sets a new one (all write paths in use-lumi-app.tsx, lib/tools.ts);
// a write that did not would not be seen here. Relations are compared by their identity.
export function hasChangesBeyond(entities: Entity[], relations: Relation[], known: { entities: Entity[]; relations: Relation[] }) {
  if (entities.length !== known.entities.length || relations.length !== known.relations.length) return true;
  const knownEntities = new Map(known.entities.map((entity) => [entity.id, entity.updatedAt]));
  for (const entity of entities) if (knownEntities.get(entity.id) !== entity.updatedAt) return true;
  const relationKey = (relation: Relation) => `${relation.id}|${relation.sourceEntityId}|${relation.targetEntityId}|${relation.relationType}|${relation.workspaceId}`;
  const knownRelations = new Set(known.relations.map(relationKey));
  return relations.some((relation) => !knownRelations.has(relationKey(relation)));
}

export type TabMessage =
  // The local copy changed (saved to or taken from the server); other tabs reload it.
  | { type: "changed"; from: string }
  // A tab is about to sign out: the others save what is being typed and stop editing.
  | { type: "save-for-sign-out"; from: string; request: string }
  | { type: "saving"; from: string; request: string }
  // `unsaved`: texts being typed there that are not records and so cannot be saved (a new task
  // in the capture dialog, a checklist item not added yet, text pasted for processing).
  | { type: "saved"; from: string; request: string; unsaved?: number }
  // Sent while a tab is still signing out (for example while it asks the user), so the others
  // keep waiting.
  | { type: "signing-out"; from: string }
  // The sign-out did not happen; the others may edit again.
  | { type: "sign-out-cancelled"; from: string };

export function postToTabs(message: TabMessage) {
  if (typeof BroadcastChannel === "undefined") return;
  try {
    const channel = new BroadcastChannel(tabChannelName);
    channel.postMessage(message);
    channel.close();
  } catch {
    // Not supported or closing: nothing to tell.
  }
}

// Asks the other open tabs to save what is being typed and waits until each that answered has
// done so. Tabs answer "saving" at once; a tab that does not answer within `answerMs` is taken as
// not open. Resolves with the number of tabs that saved and of texts they could not save.
export function askOtherTabsToSave(from: string, options: { answerMs?: number; saveMs?: number } = {}) {
  const { answerMs = 300, saveMs = 4_000 } = options;
  return new Promise<{ saved: number; unsaved: number }>((resolve) => {
    if (typeof BroadcastChannel === "undefined") { resolve({ saved: 0, unsaved: 0 }); return; }
    const request = `${from}-${Date.now()}`;
    const saving = new Set<string>();
    const saved = new Set<string>();
    let unsaved = 0;
    const channel = new BroadcastChannel(tabChannelName);
    let answering = true;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      window.clearTimeout(answerTimer);
      window.clearTimeout(saveTimer);
      channel.close();
      resolve({ saved: saved.size, unsaved });
    };
    const check = () => { if (!answering && [...saving].every((tab) => saved.has(tab))) finish(); };
    channel.onmessage = (event: MessageEvent<TabMessage>) => {
      const message = event.data;
      if (!message || !("request" in message) || message.request !== request) return;
      if (message.type === "saving") saving.add(message.from);
      if (message.type === "saved" && !saved.has(message.from)) {
        saving.add(message.from);
        saved.add(message.from);
        unsaved += message.unsaved || 0;
        check();
      }
    };
    const answerTimer = window.setTimeout(() => { answering = false; check(); }, answerMs);
    const saveTimer = window.setTimeout(finish, answerMs + saveMs);
    channel.postMessage({ type: "save-for-sign-out", from, request } satisfies TabMessage);
  });
}

// A request to the server that does not answer in time is given up, so that the synchronization
// lock is not held for ever (every tab waits for it).
export function requestTimeout(ms = 20_000): AbortSignal | undefined {
  return typeof AbortSignal !== "undefined" && "timeout" in AbortSignal ? AbortSignal.timeout(ms) : undefined;
}
