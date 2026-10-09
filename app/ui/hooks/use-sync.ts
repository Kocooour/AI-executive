"use client";
import { useEffect, useRef, useState } from "react";
import { db, readLocalWithBase, readSyncBase, replaceSyncBase, type Entity, type Relation } from "../../../lib/db";
import { mergeSnapshots, type ServerSnapshot } from "../../../lib/server-sync";
import { captureMarkers as captureMarkersIn, clearSentMarkers as clearSentMarkersIn, markPending as markPendingIn, pendingDeletedIds as pendingDeletedIdsIn, pendingRevivedIds as pendingRevivedIdsIn, type SentMarkers } from "../../../lib/pending-markers";
import { forServer, unsentIds, type HeldBackReason } from "../../../lib/sendable";
import { mergeEntity, mergeRelations, sameValue, withConflicts } from "../../../lib/field-merge";
import { writeTime } from "../../../lib/clock";
import { hasChangesBeyond, postToTabs, requestTimeout, tabChannelName, withSyncLock, type TabMessage } from "../../../lib/tab-coordination";

// The local copy of the data and its synchronization with the server: the records on screen,
// the sync status, the revision of the server copy this device knows, the counter of local writes
// (odd while a write is in progress), the bookkeeping of changes waiting to be sent, and saving to
// and loading from the server. Moved verbatim from use-lumi-app.tsx.
// Invariant (see the data-loss fix in PR #21): `serverRevision` may advance only when the local
// copy holds that content, or the server holds exactly what was sent.
// Start-up synchronization, sign-out and the refresh on focus still live in use-lumi-app.tsx and
// use these.
export function useSync() {
  const [items, setItems] = useState<Entity[]>([]),
    // Records changed here and not yet on the server, and records the server would refuse (held
    // back on this device until they are fixed; lib/sendable.ts).
    [unsent, setUnsent] = useState<Set<string>>(() => new Set()),
    [heldBack, setHeldBack] = useState<Entity[]>([]),
    [heldReasons, setHeldReasons] = useState<Map<string, HeldBackReason>>(() => new Map()),
    [relations, setRelations] = useState<any[]>([]),
    [syncStatus, setSyncStatus] = useState<
      "connecting" | "synced" | "syncing" | "offline"
    >("connecting");
  const serverRevision = useRef(0);
  const syncQueue = useRef<Promise<void>>(Promise.resolve());
  const localDataVersion = useRef(0);
  const signedOut = useRef(false);
  // Saves asked for in a row by applySnapshot for held records that became sendable.
  const requeueStreak = useRef(0);
  // This tab, for messages to the other tabs of the browser (lib/tab-coordination.ts).
  const tabId = useRef(`${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const pendingKey = "ai-executive-pending-sync";
  const deletedKey = "ai-executive-pending-deletions";
  const revivedKey = "ai-executive-pending-revivals";
  const pendingDeletedIds = () => pendingDeletedIdsIn(localStorage);
  const pendingRevivedIds = () => pendingRevivedIdsIn(localStorage);
  // The bookkeeping of what waits to be sent is shared by all tabs (lib/pending-markers.ts).
  const markPending = () => markPendingIn(localStorage);
  const captureMarkers = () => captureMarkersIn(localStorage);
  const clearSentMarkers = (sent: SentMarkers) => clearSentMarkersIn(localStorage, sent);
  async function load() {
    const [entities, localRelations, base] = await readLocalWithBase();
    setItems([...entities]);
    setRelations([...localRelations]);
    const nextUnsent = unsentIds([...entities], base);
    const { heldBack: nextHeld, reasons } = forServer([...entities], [], null);
    // Only a real change of these sets updates the screen (load() runs after every save).
    setUnsent((previous) => (previous.size === nextUnsent.size && [...nextUnsent].every((id) => previous.has(id)) ? previous : nextUnsent));
    setHeldBack((previous) => (previous.length === nextHeld.length && nextHeld.every((entity, index) => previous[index] === entity || (previous[index]?.id === entity.id && previous[index]?.updatedAt === entity.updatedAt)) ? previous : nextHeld));
    setHeldReasons(reasons);
  }
  // Replaces the local copy with the server's. `known` is what this device knows the server
  // already has: what it has just sent, or ("base") the common version kept for merging. If the
  // local copy holds anything beyond it, a change has not been sent yet, possibly written by
  // another tab, and the copy is not replaced. This is checked inside the same database
  // transaction, so a write from any tab is either seen here or comes after the replacement.
  async function applySnapshot(snapshot: ServerSnapshot, expectedVersion?: number, known?: "base" | { entities: Entity[]; relations: Relation[] }) {
    if (signedOut.current) return false;
    if (expectedVersion !== undefined && localDataVersion.current !== expectedVersion) return false;
    // A held record that became sendable through the merge below still holds changes of this
    // device; it is sent by one more save.
    let requeue = false;
    await db.transaction("rw", [db.entities, db.relations, db.baseEntities, db.baseRelations], async () => {
      if (signedOut.current) throw new Error("LOCAL_DATA_CHANGED");
      if (expectedVersion !== undefined && localDataVersion.current !== expectedVersion) {
        throw new Error("LOCAL_DATA_CHANGED");
      }
      const reference = known === "base" ? await readSyncBase() : known;
      const currentEntities = await db.entities.toArray();
      const currentRelations = await db.relations.toArray();
      // Records the server would refuse stay on this device as they are (lib/sendable.ts); they
      // are neither compared nor replaced.
      const held = forServer(currentEntities, [], null).heldBack;
      const heldIds = new Set(held.map((entity) => entity.id));
      const oldBase = new Map((await db.baseEntities.toArray()).map((entity) => [entity.id, entity]));
      const oldBaseRelations = await db.baseRelations.toArray();
      const withoutHeld = <T extends { id: string }>(list: T[]) => list.filter((entity) => !heldIds.has(entity.id));
      const relationsWithoutHeld = (list: Relation[]) => list.filter((relation) => !heldIds.has(relation.sourceEntityId) && !heldIds.has(relation.targetEntityId));
      if (reference && hasChangesBeyond(withoutHeld(currentEntities), relationsWithoutHeld(currentRelations), { entities: withoutHeld(reference.entities), relations: relationsWithoutHeld(reference.relations) })) {
        throw new Error("LOCAL_DATA_CHANGED");
      }
      await db.entities.clear();
      await db.relations.clear();
      if (snapshot.entities.length) await db.entities.bulkAdd(snapshot.entities);
      if (snapshot.relations.length)
        await db.relations.bulkAdd(snapshot.relations);
      // The local copy is now exactly the server's: it is the common version from here on.
      await db.baseEntities.clear();
      await db.baseRelations.clear();
      if (snapshot.entities.length) await db.baseEntities.bulkAdd(snapshot.entities);
      if (snapshot.relations.length) await db.baseRelations.bulkAdd(snapshot.relations);
      if (held.length) {
        // A held record keeps this device's change, merged with what the server has meanwhile
        // (lib/field-merge.ts), so fixing it later does not undo another device's change. One the
        // server has deleted stays deleted.
        const deleted = new Set((snapshot.tombstones || []).map((item) => item.id));
        const fromServer = new Map(snapshot.entities.map((entity) => [entity.id, entity]));
        const merged = held.filter((entity) => !deleted.has(entity.id)).map((entity) => {
          const server = fromServer.get(entity.id);
          const common = oldBase.get(entity.id);
          return server && common ? mergeEntity(common, entity, server) : entity;
        });
        // The links of held records are merged the same way (per record and kind of link, like a
        // field), so a link another device removed is not brought back when the record is fixed.
        const touchesHeld = (relation: Relation) => heldIds.has(relation.sourceEntityId) || heldIds.has(relation.targetEntityId);
        const group = (relation: Relation) => `${relation.sourceEntityId}|${relation.relationType}`;
        const groups = new Set([...oldBaseRelations, ...currentRelations, ...snapshot.relations].filter(touchesHeld).map(group));
        const inGroups = (relation: Relation) => groups.has(group(relation));
        const localById = new Map(currentEntities.map((entity) => [entity.id, entity]));
        const serverInGroups = snapshot.relations.filter(inGroups);
        const linkMerge = mergeRelations(oldBaseRelations.filter(inGroups), currentRelations.filter(inGroups), serverInGroups, (sourceId) => {
          const local = localById.get(sourceId), server = fromServer.get(sourceId);
          return !server || Boolean(local && local.updatedAt > server.updatedAt);
        });
        const withLinkConflicts = merged.map((entity) => {
          const linkConflicts = linkMerge.conflicts.get(entity.id);
          return linkConflicts?.length ? withConflicts(entity, linkConflicts) : entity;
        });
        if (withLinkConflicts.length) await db.entities.bulkPut(withLinkConflicts);
        const present = new Map((await db.entities.toArray()).map((entity) => [entity.id, entity]));
        // Whether a record is still held is decided as for saving (lib/sendable.ts), with all
        // records as they are now: a valid record in a workspace that cannot be saved stays held.
        const stillHeld = forServer([...present.values()], [], null).reasons;
        // Changes of this device kept by the merge, in a record that is no longer held, get a new
        // time: with the server's time they would look sent, and nothing would send them.
        const released = withLinkConflicts.flatMap((entity) => {
          const server = fromServer.get(entity.id);
          if (stillHeld.has(entity.id)) return [];
          // A record the server does not have yet (held because its workspace was unknown until
          // another device created it) is sent as it is.
          if (!server) { requeue = true; return []; }
          if (sameValue(entity, server)) return [];
          return [{ ...entity, updatedAt: Math.max(writeTime(), server.updatedAt + 1) }];
        });
        // A conflict of a link whose source is not held (the held record is its target) is kept
        // on that source, so the replaced link can be seen and restored; the source is sent again
        // with it.
        const heldMergedIds = new Set(merged.map((entity) => entity.id));
        for (const [sourceId, conflicts] of linkMerge.conflicts) {
          const source = present.get(sourceId);
          if (heldMergedIds.has(sourceId) || !source || !conflicts.length || stillHeld.has(sourceId)) continue;
          const server = fromServer.get(sourceId);
          released.push({ ...withConflicts(source, conflicts), updatedAt: Math.max(writeTime(), (server?.updatedAt ?? 0) + 1) });
        }
        if (released.length) {
          await db.entities.bulkPut(released);
          requeue = true;
        }
        const heldRelations = linkMerge.relations.filter((relation) => present.has(relation.sourceEntityId) && present.has(relation.targetEntityId));
        if (serverInGroups.length) await db.relations.bulkDelete(serverInGroups.map((relation) => relation.id));
        if (heldRelations.length) await db.relations.bulkPut(heldRelations);
        // Links that differ from the server's and can be sent now need that save too (only then:
        // a link of a record still held would otherwise ask for a save after every save).
        const linkKey = (relation: Relation) => `${relation.id}|${relation.sourceEntityId}|${relation.targetEntityId}|${relation.relationType}|${relation.workspaceId}`;
        const serverKeys = new Set(serverInGroups.map(linkKey));
        const sendableEnds = (relation: Relation) => [relation.sourceEntityId, relation.targetEntityId].every((id) => present.has(id) && !stillHeld.has(id));
        const linksDiffer = heldRelations.length !== serverInGroups.length || heldRelations.some((relation) => !serverKeys.has(linkKey(relation)));
        const serverLinksPresent = serverInGroups.filter((relation) => present.has(relation.sourceEntityId) && present.has(relation.targetEntityId));
        if (linksDiffer && heldRelations.every(sendableEnds) && serverLinksPresent.every(sendableEnds)) requeue = true;
      }
    });
    serverRevision.current = snapshot.revision;
    await load();
    postToTabs({ type: "changed", from: tabId.current });
    // At most two such saves in a row: if the server keeps answering with something else than was
    // sent (it normalised a value), asking again would not end.
    requeueStreak.current = requeue ? requeueStreak.current + 1 : 0;
    if (requeue && requeueStreak.current <= 2 && !signedOut.current) void syncToServer();
    return true;
  }
  // Another tab changed the shared local copy: show it here too.
  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel(tabChannelName);
    channel.onmessage = (event: MessageEvent<TabMessage>) => {
      if (event.data?.type === "changed" && event.data.from !== tabId.current && !signedOut.current) void load().catch(() => undefined);
    };
    return () => channel.close();
  }, []);
  async function putSnapshot(
    entities: Entity[],
    snapshotRelations: any[],
    baseRevision: number,
    deletedIds: string[] = [],
    revivedIds: string[] = [],
  ) {
    return fetch("/api/store", {
      signal: requestTimeout(),
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseRevision,
        entities,
        relations: snapshotRelations,
        deletedIds,
        revivedIds,
      }),
    });
  }
  // Saves that were asked for and have not started yet.
  const queuedSaves = useRef(0);
  // After a save that could not settle, one more is needed. A change that is being written or
  // already has its own save queued brings it anyway; only otherwise is one added here.
  function settleLater() {
    if (queuedSaves.current > 0 || localDataVersion.current % 2 === 1 || signedOut.current) return;
    void syncToServer();
  }
  async function syncToServer() {
    // Marked at once, before waiting for an earlier save or another tab's synchronization, so
    // that no tab takes the server copy over this change in the meantime.
    markPending();
    // Every local write is followed by a save; the other tabs show the change at once, so that
    // nothing there is edited on top of an older copy.
    postToTabs({ type: "changed", from: tabId.current });
    // The change is shown at once, marked as waiting, not only after the server has answered.
    void load().catch(() => undefined);
    queuedSaves.current += 1;
    const operation = syncQueue.current.then(() => withSyncLock(async () => {
      queuedSaves.current -= 1;
      setSyncStatus("syncing");
      localStorage.setItem(pendingKey, "1");
      const localVersion = localDataVersion.current;
      // The local copy and its common version with the server are read together: another tab
      // replacing both in between would otherwise pair this copy with a newer common version.
      const [localEntities, localRelations, base] = await readLocalWithBase();
      // What this save sends of the shared bookkeeping; only that is removed when it succeeds.
      const sentMarkers = captureMarkers();
      // A record the server would refuse is held back, so that it does not stop everything else.
      const outgoing = forServer([...localEntities], [...localRelations], base);
      let response = await putSnapshot(
        outgoing.entities,
        outgoing.relations,
        serverRevision.current,
        sentMarkers.deleted,
        sentMarkers.revived,
      );
      let mergedWithServer = false;
      // The server may change again between the conflict and the merged save; try a few times
      // before giving up until the next trigger.
      for (let attempt = 0; attempt < 3 && response.status === 409; attempt += 1) {
        mergedWithServer = true;
        const current = (await response.json()) as ServerSnapshot;
        const deletedIds = new Set(sentMarkers.deleted);
        const revivedIds = new Set(sentMarkers.revived);
        const filteredCurrent = {
          ...current,
          tombstones: (current.tombstones || []).filter((item) => !revivedIds.has(item.id)),
          entities: current.entities.filter((entity) => !deletedIds.has(entity.id)),
          relations: current.relations.filter(
            (relation) =>
              !deletedIds.has(relation.sourceEntityId) &&
              !deletedIds.has(relation.targetEntityId),
          ),
        };
        const merged = mergeSnapshots(
          filteredCurrent,
          outgoing.entities,
          outgoing.relations,
          base,
        );
        response = await putSnapshot(
          merged.entities,
          merged.relations,
          current.revision,
          sentMarkers.deleted,
          sentMarkers.revived,
        );
      }
      if (!response.ok) throw new Error("Server synchronization failed");
      const saved = (await response.json()) as ServerSnapshot;
      let applied = false;
      try {
        applied = await applySnapshot(saved, localVersion, { entities: localEntities, relations: localRelations });
      } catch (error) {
        if (!(error instanceof Error) || error.message !== "LOCAL_DATA_CHANGED") throw error;
      }
      if (!applied) {
        // The local copy changed during the save, so the saved state was not taken over. The
        // known revision may advance only when the server holds exactly what was sent. After a
        // merge it also holds records this device does not have; claiming its revision would
        // make the next save replace them. Keeping the old revision makes that save merge again.
        if (!mergedWithServer) serverRevision.current = saved.revision;
        // What this device sent is now part of the server copy (merged or not), so it is the
        // common version of what the device had then; later local edits are changes against it.
        if (!signedOut.current) {
          await replaceSyncBase(outgoing.entities, outgoing.relations).catch(() => undefined);
          await load().catch(() => undefined);
        }
        settleLater();
        return;
      }
      // Something was changed while the saved state was being loaded. That change has its own
      // save queued, which still needs the lists of deleted and restored records.
      if (localDataVersion.current !== localVersion) {
        settleLater();
        return;
      }
      localStorage.setItem("ai-executive-server-synced", "1");
      clearSentMarkers(sentMarkers);
      setSyncStatus("synced");
    }));
    syncQueue.current = operation.catch(() => {
      setSyncStatus("offline");
    });
    return syncQueue.current;
  }
  // `afterSignIn`: the browser has just signed in, so nothing local predates the server copy and,
  // once that copy is taken over, the local copy counts as synchronized (see below).
  async function pullFromServer(afterSignIn = false) {
    await syncQueue.current;
    if (localStorage.getItem(pendingKey) === "1") {
      await syncToServer();
      return;
    }
    try {
      // The server copy is fetched and taken over while no other tab synchronizes: a copy fetched
      // earlier could be older than a save another tab made meanwhile, and would undo it.
      const outcome = await withSyncLock(async () => {
        if (localStorage.getItem(pendingKey) === "1") return "save" as const;
        const pullVersion = localDataVersion.current;
        const response = await fetch("/api/store", { cache: "no-store", signal: requestTimeout() });
        if (!response.ok) throw new Error("Server synchronization failed");
        const snapshot = (await response.json()) as ServerSnapshot;
        // A change waiting to be sent (from any tab) is saved instead, outside the lock.
        if (localStorage.getItem(pendingKey) === "1") return "save" as const;
        if (snapshot.revision <= serverRevision.current) return "synced" as const;
        // "Synced" means the local copy holds the server's state. If a local change got in the
        // way, the copy was not taken over; that change's own save sets the status when it is done.
        try {
          if (!(await applySnapshot(snapshot, pullVersion, "base"))) return "changed" as const;
        } catch (error) {
          if (!(error instanceof Error) || error.message !== "LOCAL_DATA_CHANGED") throw error;
          return "changed" as const;
        }
        // A browser signing in for the first time could not synchronize when it started. Once it
        // holds exactly the server copy it is synchronized; without the mark every later start
        // would send that copy back to the server as if it were the browser's own data.
        if (afterSignIn) localStorage.setItem("ai-executive-server-synced", "1");
        return "synced" as const;
      });
      if (outcome === "save") { await syncToServer(); return; }
      if (outcome === "synced") setSyncStatus("synced");
      // The local copy holds something the server does not have yet: send it. (Usually the change
      // that got in the way brings its own save; one more is harmless.)
      if (outcome === "changed" && !signedOut.current) void syncToServer();
    } catch {
      setSyncStatus("offline");
    }
  }

  return {
    items,
    relations,
    unsent,
    heldBack,
    heldReasons,
    syncStatus,
    setSyncStatus,
    serverRevision,
    syncQueue,
    localDataVersion,
    signedOut,
    pendingKey,
    deletedKey,
    revivedKey,
    pendingDeletedIds,
    pendingRevivedIds,
    captureMarkers,
    clearSentMarkers,
    load,
    applySnapshot,
    putSnapshot,
    syncToServer,
    pullFromServer,
    tabId,
  };
}
