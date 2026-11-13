"use client";
import { useEffect, useRef, useState } from "react";
import { adoptionTransaction, db, readLocalWithBase, readSyncBase, replaceSyncBase, type Entity, type Relation } from "../../../lib/db";
import { mergeSnapshots, type ServerSnapshot } from "../../../lib/server-sync";
import { captureMarkers as captureMarkersIn, clearAllMarkers, clearSentMarkers as clearSentMarkersIn, markPending as markPendingIn, pendingDeletedIds as pendingDeletedIdsIn, pendingRevivedIds as pendingRevivedIdsIn, type SentMarkers } from "../../../lib/pending-markers";
import { forServer, unsentIds, type HeldBackReason } from "../../../lib/sendable";
import { mergeEntity, mergeRelations, sameValue, withConflicts } from "../../../lib/field-merge";
import { writeTime } from "../../../lib/clock";
import { settleSyncOperation } from "../../../lib/sync-result";
import { hasChangesBeyond, postToTabs, requestTimeout, tabChannelName, withSyncLock, type TabMessage } from "../../../lib/tab-coordination";
import { markSignedIn } from "../../../lib/local-data";
import { beginAdoption, isAdopting, isAdoptingInThisTab, setAfterRestoreFlag } from "../../../lib/adoption";
import { advanceAdoptionGeneration, assertOwnerAdoptionCleanup, finishOwnerAdoptionFence, initializeAdoptionGeneration, ownerAdoptionFencePresent, startOwnerAdoptionFence } from "../../../lib/owner-adoption-barrier";
import { restoredSinceKnownGeneration, restoreGenerationDecision } from "../../../lib/restore-generation-origin";
import { clearNotesDrafts } from "../../../lib/notes-drafts";
import { clearProjectContextDrafts } from "../../../lib/project-context-drafts";
import { installRestoreFence } from "../../../lib/restore-fence-client";
import { beginOfflineRecoveryHoldSafely, offlineRecoveryIsHeld, offlineRecoveryHoldKey, offlineRecoveryIntentKey, readOfflineRecoveryHold, recoveryExportPlan, recoveryPullDecision, withOfflineRecoveryDataLock } from "../../../lib/d2b-recovery-hold";
import { prepareOfflineRecovery } from "../../../lib/d2b-offline-reconciliation";
import { encodeOfflineRecoveryFile, offlineRecoveryFile } from "../../../lib/d2b-offline-recovery-file";
import { readRawRecoveryDrafts, readRawRecoveryMarkers } from "../../../lib/d2b-recovery-local";
import { inspectOfflineRecoveryBytes, type OfflineRecoveryReviewSummary } from "../../../lib/d2b-recovery-review";
import { runLatestRecoveryInspection, type RecoveryInspectionState } from "../../../lib/d2b-recovery-review-request";

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
  // An in-memory serverRevision of 0 after reload is not evidence of the
  // original base revision. Only record a value after this tab verified it.
  const recoveryBaseRevision = useRef<number | null>(null);
  // The restore generation of the server data this device last held (lib/server-store.ts), kept across reloads. Sent with
  // every save; a save from before a restore is refused by the server, and then this device replaces its copy.
  const generationKey = "ai-executive-restore-generation";
  const restoreGeneration = useRef<number | undefined>(undefined);
  if (restoreGeneration.current === undefined && typeof localStorage !== "undefined") {
    const stored = Number(localStorage.getItem(generationKey));
    if (localStorage.getItem(generationKey) !== null && Number.isSafeInteger(stored)) restoreGeneration.current = stored;
  }
  initializeAdoptionGeneration(restoreGeneration.current);
  function rememberGeneration(value: number | undefined, strictly = false) {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return;
    if (strictly) {
      localStorage.setItem(generationKey, String(value));
      if (localStorage.getItem(generationKey) !== String(value))
        throw new Error("OWNER_ADOPTION_GENERATION_NOT_PERSISTED");
    } else {
      try { localStorage.setItem(generationKey, String(value)); } catch { /* kept in memory */ }
    }
    restoreGeneration.current = value;
    advanceAdoptionGeneration(value);
  }
  // Shown after the data was restored from a backup elsewhere and this device's unsent changes were discarded.
  const [restoredNotice, setRestoredNotice] = useState(false);
  // D2b: restoration must never erase offline work before an explicit recovery.
  // A storage-backed hold also survives tab crashes, reloads and other open tabs.
  const [recoveryHeld, setRecoveryHeld] = useState(false);
  const [recoveryPreparing, setRecoveryPreparing] = useState(false);
  const [recoveryReady, setRecoveryReady] = useState(false);
  const [recoveryError, setRecoveryError] = useState(false);
  // A local-only rescue does not claim fresh verification of the current server.
  const [recoveryOffline, setRecoveryOffline] = useState(false);
  const [recoveryDownloadRequested, setRecoveryDownloadRequested] = useState(false);
  const [recoveryReview, setRecoveryReview] = useState<RecoveryInspectionState<OfflineRecoveryReviewSummary>>({
    busy: false, result: null, failure: null,
  });
  const recoveryInspectRequest = useRef(0);
  const recoveryFileBytes = useRef<Uint8Array | null>(null);
  // A prepared download is valid only for the exact captured localStorage state.
  // A late old-tab cleanup or out-of-band edit must invalidate it, never silently omit work.
  const recoveryStorageSnapshot = useRef<string | null>(null);
  useEffect(() => { if (offlineRecoveryIsHeld()) setRecoveryHeld(true); }, []);
  // Whether the server's data was restored since this browser last held it, so that what it holds (or waits to send) was made
  // against data that no longer exists. A browser that never stored a generation but has synchronized before (last used
  // before generations were tracked, or dormant) is treated the same once the server's generation is above 0: there is no way
  // to tell whether it predates a restore, so it adopts. One that never synchronized holds nothing to protect.
  function restoredSinceKnown(serverGeneration: number | undefined) {
    return restoredSinceKnownGeneration(
      restoreGeneration.current, serverGeneration, localStorage.getItem("ai-executive-server-synced") === "1",
    );
  }
  // The generation this page started with: another tab's adoption matters only if it is newer.
  const loadedGeneration = useRef<number | undefined>(restoreGeneration.current);
  // A fenced mutating API has already stopped in-tab writes synchronously;
  // its authenticated GET must finish that same adoption, not return early.
  const fencedRestore = useRef(false);
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
    // Computed as for saving, with the common version: a record the server knows in a valid form
    // (and the records of a workspace it knows) is still sent, so it is not shown as held.
    const { heldBack: nextHeld, reasons } = forServer([...entities], [], base);
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
      const oldBase = new Map((await db.baseEntities.toArray()).map((entity) => [entity.id, entity]));
      const held = forServer(currentEntities, [], { entities: [...oldBase.values()] }).heldBack;
      const heldIds = new Set(held.map((entity) => entity.id));
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
        const stillHeld = forServer([...present.values()], [], { entities: snapshot.entities }).reasons;
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
        const heldRelations = linkMerge.relations.filter((relation) => !deleted.has(relation.id) && present.has(relation.sourceEntityId) && present.has(relation.targetEntityId));
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
    recoveryBaseRevision.current = snapshot.revision;
    rememberGeneration(snapshot.restoreGeneration);
    await load();
    postToTabs({ type: "changed", from: tabId.current });
    // At most two such saves in a row: if the server keeps answering with something else than was
    // sent (it normalised a value), asking again would not end.
    requeueStreak.current = requeue ? requeueStreak.current + 1 : 0;
    if (requeue && requeueStreak.current <= 2 && !signedOut.current) void syncToServer();
    return true;
  }
  // After a restore or an import the server holds the only truth: the local copy, the common version used for merging,
  // the records held back on this device and everything waiting to be sent (changes, deletions, revivals) belong to the
  // data that was replaced and must not survive or be sent. Unlike applySnapshot nothing is kept or merged. The records
  // and the bookkeeping are shared by all tabs of the browser, so one replacement serves them all; the others only show it.
  // THE one way restored server data is adopted, for an explicit restore or import, the message of another tab, a save
  // refused with code "restored" (start-up saves included) and a pull that sees a new generation. It ends in a page reload,
  // so no state of the replaced data (titles, drafts, Context, history, work sessions, note versions) can survive in memory:
  // from its first step the save paths do nothing (lib/adoption.ts); the local copy, held-back records, markers, merge base,
  // pending flags and every persisted note draft (all pages) are dropped, the snapshot and its generation adopted, the
  // other tabs told to reload, and this one reloads and starts from the restored state. `notice`: the restore happened
  // elsewhere, say so after the reload. The caller holds the sync lock (or is in the queue); replaceLocalWithServer takes them.
  // This is called *directly* on a generation-bearing 409 refusal, before
  // another GET, the sync queue or a cross-tab sync lock. The hold helper
  // engages the in-tab write fence synchronously, then serializes the durable
  // cross-tab marker with any already-authorized local wipe.
  async function engageRecoveryForGeneration(observedGeneration: number | undefined) {
    setRecoveryHeld(true);
    setSyncStatus("offline");
    try {
      await beginOfflineRecoveryHoldSafely(restoreGeneration.current, observedGeneration);
    } catch (error) {
      if (error instanceof Error && (error.message === "OFFLINE_RECOVERY_WIPE_PRECEDED_HOLD" ||
          error.message === "OFFLINE_RECOVERY_ADOPTION_PRECEDED_HOLD")) {
        signedOut.current = true;
        window.location.replace("/");
        return false;
      }
      setRecoveryError(true); // No writable fallback on missing/corrupt metadata.
    }
    return false;
  }
  async function adoptServerCopy(source: ServerSnapshot, notice = false) {
    // Only a server-certified owner restore authorizes discarding old local
    // data. A D2b hold always overrides that permission.
    if (restoreGenerationDecision(
      restoredSinceKnown(source.restoreGeneration), source.restoreKind, offlineRecoveryIsHeld(),
    ) === "hold") return engageRecoveryForGeneration(source.restoreGeneration);
    if (isAdoptingInThisTab() && !fencedRestore.current) return true;
    fencedRestore.current = false;
    if (!isAdoptingInThisTab()) beginAdoption();

    let needsRecoveryHold = false;
    let adoptionCompleted = false;
    try {
      // A cross-tab hold must not be inserted halfway through either the
      // IndexedDB replacement OR its localStorage marker/generation cleanup.
      // The lock is also used by D2b holds and owner-authorized sign-out.
      await withOfflineRecoveryDataLock(async () => {
        if (offlineRecoveryIsHeld() || ownerAdoptionFencePresent()) { needsRecoveryHold = true; return; }
        if (signedOut.current || localStorage.getItem("ai-executive-signed-out") === "1" ||
            localStorage.getItem("ai-executive-wipe-pending") === "1") return;
        // Another tab can complete adoption while this one waits for the lock.
        // Never let an obsolete snapshot overwrite the already adopted copy.
        const persisted = localStorage.getItem(generationKey);
        const latest = persisted === null ? undefined : Number(persisted);
        if (typeof source.restoreGeneration === "number" && Number.isSafeInteger(source.restoreGeneration) &&
            typeof latest === "number" && Number.isSafeInteger(latest) &&
            (latest > source.restoreGeneration ||
              (latest === source.restoreGeneration && restoreGeneration.current !== latest))) {
          adoptionCompleted = true; // A sibling already completed the replacement.
          return;
        }

        // Synchronously fence ALL sibling writes before creating the
        // overlapping IndexedDB readwrite transaction. Existing transactions
        // run before ours; later ones see this marker and are refused.
        startOwnerAdoptionFence(localStorage, source.restoreGeneration);
        localDataVersion.current += 2;
        try {
          await adoptionTransaction(async () => {
            await db.entities.clear();
            await db.relations.clear();
            await db.baseEntities.clear();
            await db.baseRelations.clear();
            if (source.entities.length) { await db.entities.bulkAdd(source.entities); await db.baseEntities.bulkAdd(source.entities); }
            if (source.relations.length) { await db.relations.bulkAdd(source.relations); await db.baseRelations.bulkAdd(source.relations); }
          });
        } catch (error) {
          // A failed replace can be recovered by an empty local store or by
          // deleting the DB, but only while the SAME recovery lock is held.
          // Never attempt these fallbacks after a hold was observed.
          if (offlineRecoveryIsHeld()) { needsRecoveryHold = true; return; }
          console.error("Replacing the local copy failed; it is emptied instead:",
            error instanceof Error ? error.message : error);
          try {
            await adoptionTransaction(async () => {
              await db.entities.clear(); await db.relations.clear();
              await db.baseEntities.clear(); await db.baseRelations.clear();
            });
          } catch (clearError) {
            try {
              await db.delete();
            } catch (deleteError) {
              console.error("Could not replace, clear or delete the pre-restore local copy:", clearError, deleteError);
              // Do NOT acquire the same lock recursively: it would deadlock.
              // The hold is installed immediately after releasing this lock.
              needsRecoveryHold = true;
              return;
            }
          }
        }

        // Selective removeItem errors must never be certified as a complete
        // purge. Keep the durable write fence on any failure and install D2b
        // hold after releasing the shared Web Lock.
        clearAllMarkers(localStorage);
        clearNotesDrafts(localStorage);
        clearProjectContextDrafts(localStorage);
        localStorage.removeItem(pendingKey);
        assertOwnerAdoptionCleanup(localStorage);
        localStorage.setItem("ai-executive-server-synced", "1");
        if (localStorage.getItem("ai-executive-server-synced") !== "1")
          throw new Error("OWNER_ADOPTION_SYNC_BASE_NOT_PERSISTED");
        rememberGeneration(source.restoreGeneration, true);
        finishOwnerAdoptionFence(localStorage);
        serverRevision.current = source.revision;
        recoveryBaseRevision.current = source.revision;
        adoptionCompleted = true;
      }, true);
    } catch (error) {
      // No Web Locks, or an unexpected storage error: never start/continue a
      // destructive adoption without serialized access to the rescue barrier.
      console.error("Owner restore adoption could not be serialized:", error);
      needsRecoveryHold = true;
    }
    if (needsRecoveryHold) {
      await engageRecoveryForGeneration(source.restoreGeneration);
      return false;
    }
    if (!adoptionCompleted) {
      signedOut.current = true;
      window.location.replace("/");
      return false;
    }
    if (offlineRecoveryIsHeld()) {
      // Includes a pre-existing hold which acquired the lock after our commit.
      setRecoveryHeld(true);
      setSyncStatus("offline");
      return false;
    }
    setAfterRestoreFlag(notice ? "remote" : "sibling");
    postToTabs({ type: "restore-adopted", from: tabId.current, generation: source.restoreGeneration });
    window.location.reload();
    return true;
  }
  async function replaceLocalWithServer(snapshot?: ServerSnapshot, notice = false) {
    if (signedOut.current) return false;
    // A known generation mismatch must stop writes synchronously, *before* waiting
    // for a queued save or a cross-tab lock. Neither may delay the safety marker.
    if (snapshot && (offlineRecoveryIsHeld() || restoredSinceKnown(snapshot.restoreGeneration)))
      return adoptServerCopy(snapshot, notice);
    const operation = syncQueue.current.then(() => withSyncLock(async () => {
      let source = snapshot;
      if (!source) {
        const response = await fetch("/api/store", { cache: "no-store", signal: requestTimeout() });
        if (!response.ok) throw new Error("Server synchronization failed");
        source = (await response.json()) as ServerSnapshot;
      }
      return adoptServerCopy(source, notice);
    }));
    syncQueue.current = operation.then(() => undefined, () => { setSyncStatus("offline"); });
    return operation;
  }
  // Another tab of this browser adopted restored data (its message, or the generation it stored): this one reloads too, without
  // announcing it again, and only when that generation is newer than the one this page started with.
  function reloadForRestore(generation: number | undefined, fromStorage = false) {
    if (isAdopting() || signedOut.current) return;
    // A page that never knew a generation learns the first one from storage without reloading; a message is a restore.
    if (fromStorage && loadedGeneration.current === undefined) return;
    if (typeof generation === "number" && loadedGeneration.current !== undefined && generation <= loadedGeneration.current) return;
    beginAdoption();
    setAfterRestoreFlag("sibling");
    window.location.reload();
  }
  // Every mutation of the app carries the generation it knows; a refusal because of a restore adopts the restored data.
  useEffect(() => {
    installRestoreFence({ generation: () => restoreGeneration.current,
      onRestored: (observedGeneration, restoreKind) => {
        // A certified owner restore immediately fences ALL in-tab writes,
        // including blur/save callbacks racing the subsequent server GET.
        // The 409 carries no snapshot, so fetch the current authoritative one.
        if (restoreKind === "owner_restore" && !offlineRecoveryIsHeld()) {
          if (isAdopting()) return;
          fencedRestore.current = true;
          beginAdoption();
          void (async () => {
            try {
              const response = await fetch("/api/store", { cache: "no-store", signal: requestTimeout() });
              if (!response.ok) throw new Error("Server synchronization failed");
              const snapshot = (await response.json()) as ServerSnapshot;
              if (snapshot.restoreKind !== "owner_restore" ||
                  !Number.isSafeInteger(snapshot.restoreGeneration) ||
                  typeof observedGeneration !== "number" ||
                  (snapshot.restoreGeneration as number) < observedGeneration) {
                await engageRecoveryForGeneration(snapshot.restoreGeneration);
                return;
              }
              await adoptServerCopy(snapshot, true);
            } catch {
              // Never resume stale writes if the GET or local adoption failed.
              // The next startup checks the generation before local mutations.
              setSyncStatus("offline");
              window.location.reload();
            }
          })();
        } else {
          // Unknown or non-owner source keeps the D2b fail-closed barrier.
          void engageRecoveryForGeneration(observedGeneration);
        }
      },
    });
  }, []);
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if ((event.key === offlineRecoveryHoldKey || event.key === offlineRecoveryIntentKey) && event.newValue !== null) {
        setRecoveryHeld(true);
        setSyncStatus("offline");
      }
      if (event.key === generationKey && event.newValue !== null) reloadForRestore(Number(event.newValue), true);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  // Another tab changed the shared local copy: show it here too.
  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel(tabChannelName);
    channel.onmessage = (event: MessageEvent<TabMessage>) => {
      if (event.data?.type === "changed" && event.data.from !== tabId.current && !signedOut.current) void load().catch(() => undefined);
      if (event.data?.type === "restore-adopted" && event.data.from !== tabId.current) reloadForRestore(event.data.generation);
    };
    return () => channel.close();
  }, []);
  async function putSnapshot(
    entities: Entity[],
    snapshotRelations: any[],
    baseRevision: number,
    deletedIds: string[] = [],
    revivedIds: string[] = [],
    generation: number | undefined = restoreGeneration.current,
  ) {
    if (isAdopting()) throw new Error("OFFLINE_RECOVERY_OR_ADOPTION_FENCED");
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
        restoreGeneration: generation,
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
  async function syncToServer({ reportFailure = false }: { reportFailure?: boolean } = {}) {
    // Existing callers keep the non-rejecting offline-first queue. Preview project
    // actions opt in to observing the result of THEIR particular server write.
    // Restored data is being adopted: nothing of the replaced data is sent.
    if (isAdopting()) {
      if (reportFailure) throw new Error("SYNC_NOT_CONFIRMED");
      return;
    }
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
      // Restored data was adopted while this save waited: nothing is marked or sent.
      if (isAdopting()) {
        if (reportFailure) throw new Error("SYNC_NOT_CONFIRMED");
        return;
      }
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
        if (current.code === "restored") {
          if (isAdopting()) {
            if (reportFailure) throw new Error("SYNC_NOT_CONFIRMED");
            return;
          }
          // The data was restored from a backup since this device last synchronized: what is unsent here was made against
          // data that no longer exists, and merging it would put that data back. Only a browser that never synchronized
          // (nothing from before to protect) learns the number and goes on.
          if (restoredSinceKnown(current.restoreGeneration)) {
            await adoptServerCopy(current, true);
            if (reportFailure) throw new Error("SYNC_NOT_CONFIRMED");
            return;
          }
          rememberGeneration(current.restoreGeneration);
        }
        const deletedIds = new Set(sentMarkers.deleted);
        const revivedIds = new Set(sentMarkers.revived);
        const filteredCurrent = {
          ...current,
          tombstones: (current.tombstones || []).filter((item) => !revivedIds.has(item.id)),
          entities: current.entities.filter((entity) => !deletedIds.has(entity.id)),
          relations: current.relations.filter(
            (relation) =>
              !deletedIds.has(relation.id) &&
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
        if (!mergedWithServer) {
          serverRevision.current = saved.revision;
          recoveryBaseRevision.current = saved.revision;
        }
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
      markSignedIn();
      clearSentMarkers(sentMarkers);
      if (offlineRecoveryIsHeld()) {
        setRecoveryHeld(true);
        setSyncStatus("offline");
        if (reportFailure) throw new Error("SYNC_NOT_CONFIRMED");
      } else setSyncStatus("synced");
    }));
    const settled = settleSyncOperation(operation, () => setSyncStatus("offline"), reportFailure);
    syncQueue.current = settled.queue;
    return settled.result;
  }
  // `afterSignIn`: the browser has just signed in, so nothing local predates the server copy and,
  // once that copy is taken over, the local copy counts as synchronized (see below).
  async function pullFromServer(afterSignIn = false) {
    await syncQueue.current;
    if (offlineRecoveryIsHeld()) {
      setRecoveryHeld(true);
      setSyncStatus("offline");
      return;
    }
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
        if (offlineRecoveryIsHeld()) return "held" as const;
        // Restore generations are authoritative even when a backup rolls the
        // server revision backwards (or keeps the same number).
        const decision = recoveryPullDecision(
          restoredSinceKnown(snapshot.restoreGeneration), snapshot.revision, serverRevision.current,
        );
        if (decision === "restore") {
          const adopted = await adoptServerCopy(snapshot, heldBack.length > 0);
          return adopted ? "synced" as const : "held" as const;
        }
        if (decision === "synced") return "synced" as const;
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
        markSignedIn();
        return "synced" as const;
      });
      if (outcome === "save") { await syncToServer(); return; }
      if (outcome === "held" || offlineRecoveryIsHeld()) {
        setRecoveryHeld(true);
        setSyncStatus("offline");
        return;
      }
      if (outcome === "synced") setSyncStatus("synced");
      // The local copy holds something the server does not have yet: send it. (Usually the change
      // that got in the way brings its own save; one more is harmless.)
      if (outcome === "changed" && !signedOut.current) void syncToServer();
    } catch {
      setSyncStatus("offline");
    }
  }

  // TWO explicit steps: prepare a private byte array, then download from the
  // next direct button click. A delayed synthetic click is unreliable on iOS.
  async function prepareOfflineRecoveryDownload() {
    if (!offlineRecoveryIsHeld() || recoveryPreparing) return;
    setRecoveryPreparing(true);
    setRecoveryReady(false);
    setRecoveryError(false);
    setRecoveryOffline(false);
    recoveryFileBytes.current = null;
    recoveryStorageSnapshot.current = null;
    try {
      const hold = readOfflineRecoveryHold();
      if (!hold) throw new Error("OFFLINE_RECOVERY_HOLD_INVALID");
      // Online validation is best effort. Even if the owner is signed out or
      // the server is down, the persisted hold records a previously observed
      // generation and permits an explicitly UNVERIFIED, local-only rescue.
      // No network failure may force the owner to discard their local edits.
      let remoteGeneration: number | null = null;
      try {
        const response = await fetch("/api/store", { cache: "no-store", signal: requestTimeout() });
        if (response.ok) {
          const server = (await response.json()) as ServerSnapshot;
          // Missing/malformed generation from an otherwise successful GET is
          // invalid evidence, not an excuse to silently claim offline status.
          remoteGeneration = typeof server.restoreGeneration === "number"
            ? server.restoreGeneration : Number.NaN;
        }
      } catch { /* unreachable or invalid response: use the older known hold only */ }
      // A successful response with invalid/backwards generation still fails
      // closed; it must NOT silently turn into a trusted online snapshot.
      const exportPlan = recoveryExportPlan(hold, remoteGeneration);
      const exportGeneration = exportPlan.generation;
      // IndexedDB read transaction queues behind all earlier conflicting writes,
      // including writes from other tabs. The persistent middleware blocks later mutations.
      const [localEntities, localRelations, base] = await readLocalWithBase();
      const drafts = readRawRecoveryDrafts(localStorage);
      const markers = readRawRecoveryMarkers(localStorage);
      // In-flight transactions started before the hold may finish. Double-read
      // and refuse export if their snapshot changed; never silently truncate.
      const [nextEntities, nextRelations, nextBase] = await readLocalWithBase();
      const nextDrafts = readRawRecoveryDrafts(localStorage);
      const nextMarkers = readRawRecoveryMarkers(localStorage);
      if (JSON.stringify([localEntities, localRelations, base, drafts, markers]) !==
          JSON.stringify([nextEntities, nextRelations, nextBase, nextDrafts, nextMarkers]))
        throw new Error("OFFLINE_RECOVERY_UNSTABLE");
      const bundle = prepareOfflineRecovery({
        base: base ?? { entities: [], relations: [] },
        local: { entities: localEntities, relations: localRelations },
        pendingDeletedIds: markers.pendingDeletedIds, pendingRevivedIds: markers.pendingRevivedIds,
        noteDrafts: drafts.noteDrafts,
        projectContextDrafts: drafts.projectContextDrafts,
        pendingSync: markers.pendingSync,
        oldRestoreGeneration: hold.knownGeneration ?? 0,
        newRestoreGeneration: exportGeneration,
        baseRevision: recoveryBaseRevision.current,
      }, Date.now());
      const bytes = encodeOfflineRecoveryFile(bundle);
      if (!offlineRecoveryIsHeld()) throw new Error("OFFLINE_RECOVERY_HOLD_LOST");
      const sameHold = readOfflineRecoveryHold();
      if (!sameHold || JSON.stringify(sameHold) !== JSON.stringify(hold))
        throw new Error("OFFLINE_RECOVERY_HOLD_CHANGED");
      // Record only a private in-memory snapshot, not a new localStorage key.
      recoveryStorageSnapshot.current = JSON.stringify([sameHold, nextDrafts, nextMarkers]);
      recoveryFileBytes.current = bytes;
      setRecoveryOffline(!exportPlan.verifiedNow);
      setRecoveryReady(true);
    } catch {
      // No sensitive data (including errors containing IDs) escapes to logs.
      recoveryFileBytes.current = null;
      recoveryStorageSnapshot.current = null;
      setRecoveryError(true);
    } finally { setRecoveryPreparing(false); }
  }
  function downloadOfflineRecovery() {
    const bytes = recoveryFileBytes.current;
    if (!recoveryHeld || !offlineRecoveryIsHeld() || !bytes) return;
    // localStorage reads are synchronous, so this check remains in the user's
    // direct click activation (required by mobile Safari). Reject stale bundles.
    try {
      const current = JSON.stringify([readOfflineRecoveryHold(), readRawRecoveryDrafts(localStorage), readRawRecoveryMarkers(localStorage)]);
      if (!recoveryStorageSnapshot.current || current !== recoveryStorageSnapshot.current)
        throw new Error("OFFLINE_RECOVERY_UNSTABLE");
    } catch {
      recoveryFileBytes.current = null;
      recoveryStorageSnapshot.current = null;
      setRecoveryReady(false);
      setRecoveryError(true);
      return;
    }
    const blob = new Blob([new Uint8Array(bytes).buffer], { type: offlineRecoveryFile.mimeType });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = recoveryOffline ? offlineRecoveryFile.unverifiedFilename : offlineRecoveryFile.filename;
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    try {
      anchor.click();
      // This records a REQUEST, not proof the browser saved the file.
      setRecoveryDownloadRequested(true);
    } finally {
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    }
  }

  // Owner-selected local files are inspected read-only against a fresh server
  // snapshot. No file bytes, record IDs or private drafts are sent to the server,
  // stored, logged or exposed in the returned aggregate UI summary.
  async function inspectOfflineRecoveryFile(file: File | null) {
    await runLatestRecoveryInspection(recoveryInspectRequest, file, async (selectedFile) => {
      if (!offlineRecoveryIsHeld() || !recoveryHeld)
        throw new Error("OFFLINE_REVIEW_INVALID");
      const initialHold = readOfflineRecoveryHold();
      if (!initialHold || selectedFile.size === 0 || selectedFile.size > offlineRecoveryFile.maxUtf8Bytes)
        throw new Error("OFFLINE_REVIEW_INVALID");
      const bytes = new Uint8Array(await selectedFile.arrayBuffer());
      if (bytes.byteLength !== selectedFile.size || bytes.byteLength > offlineRecoveryFile.maxUtf8Bytes)
        throw new Error("OFFLINE_REVIEW_INVALID");

      // A CURRENT authenticated server snapshot is necessary for comparison.
      // No selected file bytes, IDs or drafts are sent to the server.
      let server: ServerSnapshot;
      try {
        const response = await fetch("/api/store", { cache: "no-store", signal: requestTimeout() });
        if (!response.ok) throw new Error("OFFLINE_REVIEW_SERVER");
        server = (await response.json()) as ServerSnapshot;
        if (!Number.isSafeInteger(server.restoreGeneration) ||
            !Array.isArray(server.entities) || !Array.isArray(server.relations))
          throw new Error("OFFLINE_REVIEW_SERVER");
      } catch { throw new Error("OFFLINE_REVIEW_SERVER"); }

      const summary = inspectOfflineRecoveryBytes(bytes, {
        // The GET generation was validated at runtime above.
        restoreGeneration: server.restoreGeneration as number,
        entities: server.entities,
        relations: server.relations,
      }, initialHold);

      // The hold must not change while a File API read or server GET is pending.
      const latestHold = readOfflineRecoveryHold();
      if (!offlineRecoveryIsHeld() || !latestHold ||
          JSON.stringify(latestHold) !== JSON.stringify(initialHold))
        throw new Error("OFFLINE_REVIEW_INVALID");
      return summary;
    }, setRecoveryReview);
  }

  return {
    recoveryHeld,
    recoveryPreparing,
    recoveryReady,
    recoveryError,
    recoveryOffline,
    recoveryDownloadRequested,
    recoveryInspecting: recoveryReview.busy,
    recoveryInspection: recoveryReview.result,
    recoveryInspectionError: recoveryReview.failure,
    inspectOfflineRecoveryFile,
    prepareOfflineRecoveryDownload,
    downloadOfflineRecovery,
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
    replaceLocalWithServer,
    restoreGeneration,
    restoredSinceKnown,
    rememberGeneration,
    adoptServerCopy,
    restoredNotice,
    showRestoredNotice: () => setRestoredNotice(true),
    dismissRestoredNotice: () => setRestoredNotice(false),
    putSnapshot,
    syncToServer,
    pullFromServer,
    tabId,
  };
}
