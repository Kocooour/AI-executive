// Run by tests/backups-v2.test.mjs in a child process: "crash" makes a backup and is killed right after VACUUM INTO (the
// copy still holds everything); "start" only opens the store, as a restart does, and reports where the marker is found.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const [dataDir, mode, marker] = process.argv.slice(2);
process.env.AI_EXECUTIVE_DATA_DIR = dataDir;
process.env.NODE_TEST_CONTEXT = "child-v8";
const store = await import("../../lib/server-store.ts");

const database = store.getDatabase();
if (mode === "crash") {
  database.prepare("INSERT INTO passkey_credentials (credential_id, public_key, counter, transports, device_type, backed_up, rp_id, label, created_at) VALUES (?, ?, 0, '[]', 'x', 0, 'localhost', ?, 1)")
    .run(`${marker}-id`, Buffer.from(`${marker}-key`), `${marker}-label`);
  database.prepare("INSERT INTO metadata (key, value) VALUES ('vapidKeys', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(`${marker}-vapid`);
  store.stopBackupAfterVacuumForTests(() => process.kill(process.pid, "SIGKILL"));
  store.createBackup("manual");
  console.log("not reached");
} else {
  const found = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory)) {
      const file = path.join(directory, entry);
      if (statSync(file).isDirectory()) walk(file);
      else if (!/^store\.sqlite(-wal|-shm)?$/.test(entry) && readFileSync(file).includes(Buffer.from(marker))) found.push(path.relative(dataDir, file));
    }
  };
  walk(dataDir);
  console.log(JSON.stringify(found));
}
