"use client";
import { useEffect, useRef, useState } from "react";
import { db, readLocalWithBase, readSyncBase, replaceSyncBase, type Entity, type Relation } from "../../../lib/db";
import { mergeSnapshots, type ServerSnapshot } from "../../../lib/server-sync";
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
    [relations, setRelations] = useState<any[]>([]),
    [syncStatus, setSyncStatus] = useState<
      "connecting" | "synced" | "syncing" | "offline"
    >("connecting");
  const serverRevision = useRef(0);
  const syncQueue = useRef<Promise<void>>(Promise.resolve());
  const localDataVersion = useRef(0);
  const signedOut = useRef(false);
  // This tab, for messages to the other tabs of the browser (lib/tab-coordination.ts).
  const tabId = useRef(`${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const pendingKey = "ai-executive-pending-sync";
  const deletedKey = "ai-executive-pending-deletions";
  const revivedKey = "ai-executive-pending-revivals";
  const pendingDeletedIds = () => {
    try {
      return JSON.parse(localStorage.getItem(deletedKey) || "[]") as string[];
    } catch {
      return [];
    }
  };
  const pendingRevivedIds = () => {
    try {
      return JSON.parse(localStorage.getItem(revivedKey) || "[]") as string[];
    } catch {
      return [];
    }
  };
  async function load() {
    setItems(await db.entities.toArray());
    setRelations(await db.relations.toArray());
  }
  // Replaces the local copy with the server's. `known` is what this device knows the server
  // already has: what it has just sent, or ("base") the common version kept for merging. If the
  // local copy holds anything beyond it, a change has not been sent yet, possibly written by
  // another tab, and the copy is not replaced. This is checked inside the same database
  // transaction, so a write from any tab is either seen here or comes after the replacement.
  async function applySnapshot(snapshot: ServerSnapshot, expectedVersion?: number, known?: "base" | { entities: Entity[]; relations: Relation[] }) {
    if (signedOut.current) return false;
    if (expectedVersion !== undefined && localDataVersion.current !== expectedVersion) return false;
    await db.transaction("rw", [db.entities, db.relations, db.baseEntities, db.baseRelations], async () => {
      if (signedOut.current) throw new Error("LOCAL_DATA_CHANGED");
      if (expectedVersion !== undefined && localDataVersion.current !== expectedVersion) {
        throw new Error("LOCAL_DATA_CHANGED");
      }
      const reference = known === "base" ? await readSyncBase() : known;
      if (reference && hasChangesBeyond(await db.entities.toArray(), await db.relations.toArray(), reference)) {
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
    });
    serverRevision.current = snapshot.revision;
    await load();
    postToTabs({ type: "changed", from: tabId.current });
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
    localStorage.setItem(pendingKey, "1");
    // Every local write is followed by a save; the other tabs show the change at once, so that
    // nothing there is edited on top of an older copy.
    postToTabs({ type: "changed", from: tabId.current });
    queuedSaves.current += 1;
    const operation = syncQueue.current.then(() => withSyncLock(async () => {
      queuedSaves.current -= 1;
      setSyncStatus("syncing");
      localStorage.setItem(pendingKey, "1");
      const localVersion = localDataVersion.current;
      // The local copy and its common version with the server are read together: another tab
      // replacing both in between would otherwise pair this copy with a newer common version.
      const [localEntities, localRelations, base] = await readLocalWithBase();
      let response = await putSnapshot(
        localEntities,
        localRelations,
        serverRevision.current,
        pendingDeletedIds(),
        pendingRevivedIds(),
      );
      let mergedWithServer = false;
      // The server may change again between the conflict and the merged save; try a few times
      // before giving up until the next trigger.
      for (let attempt = 0; attempt < 3 && response.status === 409; attempt += 1) {
        mergedWithServer = true;
        const current = (await response.json()) as ServerSnapshot;
        const deletedIds = new Set(pendingDeletedIds());
        const revivedIds = new Set(pendingRevivedIds());
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
          localEntities,
          localRelations,
          base,
        );
        response = await putSnapshot(
          merged.entities,
          merged.relations,
          current.revision,
          pendingDeletedIds(),
          pendingRevivedIds(),
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
        if (!signedOut.current) await replaceSyncBase(localEntities, localRelations).catch(() => undefined);
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
      localStorage.removeItem(pendingKey);
      localStorage.removeItem(deletedKey);
      localStorage.removeItem(revivedKey);
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
    load,
    applySnapshot,
    putSnapshot,
    syncToServer,
    pullFromServer,
    tabId,
  };
}
