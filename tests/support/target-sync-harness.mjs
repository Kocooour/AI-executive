// R2c.5a test harness: a fake server (contract model), a transport whose session cookie can change, a manual clock.
const { TargetSyncClient } = await import("../../lib/target-sync/client.ts");
const { MemoryTargetSyncStorage } = await import("../../lib/target-sync/memory-storage.ts");
const fake = await import("../../lib/target-sync/fake.ts");
export const { FakeTargetServer, FakeScheduler, settle } = fake;
export { MemoryTargetSyncStorage, TargetSyncClient };

export const G1 = "11111111-1111-4111-8111-111111111111";
export const G2 = "22222222-2222-4222-8222-222222222222";

/** Alice admin, Bob editor, Carol viewer of `team`; Dave is not a member. */
export function makeServer(generation = G1) {
  const server = new FakeTargetServer(generation);
  for (const user of ["alice", "bob", "carol", "dave"]) server.addUser(user);
  server.addArea("team", { alice: "admin", bob: "editor", carol: "viewer" });
  server.addArea("secret", { alice: "admin" });
  for (const id of ["t1", "t2", "t3"]) server.addTask(id, "team", `${id} original`);
  server.addTask("s1", "secret", "secret one");
  return server;
}

/** One device: storage, a client and the session cookie it currently holds. */
export function makeDevice(server, userId, options = {}) {
  const storage = options.storage ?? new MemoryTargetSyncStorage();
  const scheduler = options.scheduler ?? new FakeScheduler();
  const holder = { token: options.token ?? server.login(userId), userId };
  const methods = ["fetchChanges", "readTitleToken", "sendTitle", "titleStatus", "sendDelete", "deleteStatus"];
  const transport = Object.fromEntries(methods.map(name => [name, (...args) => server.transport(holder.token)[name](...args)]));
  let counter = 0;
  const newId = () => `00000000-0000-4000-8000-${String(++counter + (options.idBase ?? 0)).padStart(12, "0")}`;
  const client = new TargetSyncClient({ storage, transport, scheduler, newId, autoRun: options.autoRun ?? false });
  const events = [];
  client.on(event => events.push(event));
  return {
    client, storage, scheduler, events, holder, server, userId,
    relogin() { holder.token = server.login(userId); return holder.token; },
    async start() { await client.activate({ userId }); return client; },
    eventsOf(type) { return events.filter(event => event.type === type); },
  };
}

export const unwrap = readable => {
  if (readable.locked) throw new Error(`locked: ${readable.reason}`);
  return readable.value;
};
export const titles = async client => Object.fromEntries(unwrap(await client.listItems()).map(item => [item.id, item.title]));
export const draftsOf = async client => Object.fromEntries(unwrap(await client.listDrafts()).map(draft => [draft.taskId, draft]));

/** A scripted feed answer (an injection for `server.script("fetchChanges", ...)`). */
export const feedPage = (server, userId, items, extra = {}) => ({
  result: {
    kind: "ok",
    value: { phase: "feed", items, more: false, done: false, cursor: server.feedCursor(userId), restoreGeneration: server.generation, ...extra },
  },
});
