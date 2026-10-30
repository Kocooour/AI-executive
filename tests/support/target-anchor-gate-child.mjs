// R2c.4a test child: runs the anchor gate and a writer against a store whose journal path was
// replaced by something hostile (FIFO). A regression would block forever, so the parent spawns
// this with a timeout. Synthetic stores only.
const [directory, generation] = process.argv.slice(2);
const durable = await import("../../lib/target-staging-durable-session.ts");
const store = { stagingDirectory: directory, expectedRestoreGeneration: generation };
const gate = durable.checkTargetStagingAnchorLive(store);
const issued = durable.issueDurableTargetStagingSession(store, "alice", 60);
process.stdout.write(JSON.stringify({ gate, ok: issued.ok, reason: issued.ok ? null : issued.reason }));
