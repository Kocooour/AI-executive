/**
 * Default-off note-only storage bridge. All IndexedDB namespace creation,
 * deletion, reads and checkpoint writes are fenced inside one global lease.
 *
 * This intentionally does not expose the generic task/project namespace API.
 * The older injectable TargetSyncStorage is only for isolated test adapters;
 * app-facing note sync must use this lease-backed bridge.
 */
import { IndexedDbNoteMetadataLease, type NoteLeaseToken } from "./note-lease";
import type { StorageOp, TargetSyncNamespace, TargetSyncStorage } from "./storage";

const CHECKPOINT = "checkpoint";
const LOCAL_READ_MARGIN_MS = 1_000;
const LEASE_TTL_MS = 30_000;

export class IndexedDbLeasedNoteStorage implements TargetSyncStorage {
  private readonly lease: IndexedDbNoteMetadataLease;
  private ticket: NoteLeaseToken | null = null;
  private validUntil = 0;
  private readable = false;

  constructor(name = "lumi-note-metadata-v1") {
    this.lease = new IndexedDbNoteMetadataLease(name);
  }

  /** Only an explicit trusted activation can acquire or re-acquire a writer. */
  async acquire(): Promise<boolean> {
    const before = Date.now();
    if (this.ticket && await this.lease.renew(this.ticket)) {
      this.validUntil = before + LEASE_TTL_MS - LOCAL_READ_MARGIN_MS;
      return true;
    }
    this.ticket = null;
    this.readable = false;
    this.validUntil = 0;
    const claim = await this.lease.claim();
    if (claim.kind !== "acquired") return false;
    this.ticket = claim.lease;
    this.validUntil = before + LEASE_TTL_MS - LOCAL_READ_MARGIN_MS;
    return true;
  }

  /** Pull renews before network I/O. An expired lease fails closed. */
  async renew(): Promise<boolean> {
    const ticket = this.ticket;
    if (!ticket || !this.isReadable()) return false;
    const before = Date.now();
    if (!await this.lease.renew(ticket)) {
      this.blockReads();
      return false;
    }
    this.validUntil = before + LEASE_TTL_MS - LOCAL_READ_MARGIN_MS;
    return true;
  }

  allowReads(): void { if (this.ticket) this.readable = true; }
  blockReads(): void { this.readable = false; }
  isReadable(): boolean {
    return this.readable && this.ticket !== null && Date.now() < this.validUntil;
  }
  ownsTicket(): boolean { return this.ticket !== null; }

  async release(): Promise<void> {
    const ticket = this.ticket;
    this.blockReads();
    this.ticket = null;
    this.validUntil = 0;
    if (ticket) await this.lease.release(ticket);
  }

  private current(): NoteLeaseToken {
    if (!this.ticket || Date.now() >= this.validUntil)
      throw new Error("note_lease_lost");
    return this.ticket;
  }

  listNamespaces(): Promise<string[]> {
    return this.lease.listNamespaces(this.current());
  }
  deleteNamespaces(names: readonly string[]): Promise<void> {
    return this.lease.deleteNamespaces(this.current(), names);
  }

  async openNamespace(name: string): Promise<TargetSyncNamespace> {
    const ticket = this.current();
    const marker = await this.lease.openNamespace(ticket, name);
    // Never return a generic unguarded IndexedDbNamespace. Every subsequent
    // operation checks the global owner and the exact marker in one transaction.
    return {
      name,
      get: async <T = unknown>(key: string): Promise<T | undefined> => {
        if (key !== CHECKPOINT) throw new Error("note_lease_invalid_checkpoint");
        return await this.lease.readCheckpoint(this.current(), name, marker) as T | undefined;
      },
      list: async <T = unknown>(_prefix: string): Promise<Array<{ key: string; value: T }>> => {
        throw new Error("note_lease_invalid_checkpoint");
      },
      transaction: async (ops: readonly StorageOp[]): Promise<void> => {
        const op = ops[0];
        if (ops.length !== 1 || !op ||
            (op.kind !== "put" && op.kind !== "delete") ||
            op.key !== CHECKPOINT)
          throw new Error("note_lease_invalid_checkpoint");
        await this.lease.checkpoint(this.current(), name, marker,
          op.kind === "put" ? op.value : null);
      },
    };
  }
}
