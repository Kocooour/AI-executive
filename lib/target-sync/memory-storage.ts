import type { StorageOp, TargetSyncNamespace, TargetSyncStorage } from "./storage";

/** Failure injection for tests: the Nth transaction (1-based, counted from now) throws after `afterOps` staged ops. */
export type MemoryFailure = { transaction?: number; afterOps?: number; deleteNamespaces?: boolean };

type Space = Map<string, string>;

/**
 * Reference adapter. Transactions stage their ops on a copy and swap it in only when every op succeeded, which is
 * the atomicity every real adapter must provide. Values are stored as JSON strings (independent copies).
 */
export class MemoryTargetSyncStorage implements TargetSyncStorage {
  private readonly spaces = new Map<string, Space>();
  private failure: MemoryFailure | null = null;
  private transactions = 0;
  /** Count of committed transactions (tests assert that nothing was written). */
  committed = 0;

  injectFailure(failure: MemoryFailure | null): void {
    this.failure = failure ? { ...failure } : null;
    this.transactions = 0;
  }

  async listNamespaces(): Promise<string[]> {
    return [...this.spaces.keys()].sort();
  }

  async openNamespace(name: string): Promise<TargetSyncNamespace> {
    if (!this.spaces.has(name)) this.spaces.set(name, new Map());
    return new MemoryNamespace(this, name, this.spaces.get(name) as Space);
  }

  async deleteNamespaces(names: readonly string[]): Promise<void> {
    if (this.failure?.deleteNamespaces) {
      this.failure = null;
      throw new Error("injected_delete_failure");
    }
    for (const name of names) this.spaces.delete(name);
  }

  /** Test helper: raw dump of every namespace (to prove nothing leaked or survived). */
  dump(): Record<string, Record<string, unknown>> {
    const out: Record<string, Record<string, unknown>> = {};
    for (const [name, space] of this.spaces) {
      out[name] = Object.fromEntries([...space].map(([key, value]) => [key, JSON.parse(value)]));
    }
    return out;
  }

  /** @internal */
  live(name: string, space: Space): boolean {
    return this.spaces.get(name) === space;
  }

  /** @internal */
  apply(name: string, space: Space, ops: readonly StorageOp[]): void {
    if (!this.live(name, space)) throw new Error("namespace_closed");
    this.transactions += 1;
    const plan = this.failure;
    const fail = plan !== null && (plan.transaction ?? 1) === this.transactions;
    const stage: Space = new Map(space);
    let applied = 0;
    for (const op of ops) {
      if (fail && plan.afterOps !== undefined && applied >= plan.afterOps) break;
      if (op.kind === "put") stage.set(op.key, JSON.stringify(op.value));
      else if (op.kind === "delete") stage.delete(op.key);
      else for (const key of [...stage.keys()]) if (key.startsWith(op.prefix)) stage.delete(key);
      applied += 1;
    }
    if (fail) {
      this.failure = null;
      throw new Error("injected_write_failure");
    }
    space.clear();
    for (const [key, value] of stage) space.set(key, value);
    this.committed += 1;
  }
}

class MemoryNamespace implements TargetSyncNamespace {
  readonly name: string;
  private readonly owner: MemoryTargetSyncStorage;
  private readonly space: Space;
  constructor(owner: MemoryTargetSyncStorage, name: string, space: Space) {
    this.owner = owner;
    this.name = name;
    this.space = space;
  }

  async get<T>(key: string): Promise<T | undefined> {
    if (!this.owner.live(this.name, this.space)) throw new Error("namespace_closed");
    const raw = this.space.get(key);
    return raw === undefined ? undefined : (JSON.parse(raw) as T);
  }

  async list<T>(prefix: string): Promise<Array<{ key: string; value: T }>> {
    if (!this.owner.live(this.name, this.space)) throw new Error("namespace_closed");
    return [...this.space.keys()].filter(key => key.startsWith(prefix)).sort()
      .map(key => ({ key, value: JSON.parse(this.space.get(key) as string) as T }));
  }

  async transaction(ops: readonly StorageOp[]): Promise<void> {
    this.owner.apply(this.name, this.space, ops);
  }
}
