// R2c.4b test child: runs the real operator restore, but dies or throws at a chosen point of the
// two-phase journal write of the `restore` record. Synthetic stores only.
//   plain                 - no hook; prints the result JSON
//   throw-before-commit   - the fsync after the restore intent throws (the transaction rolls back)
//   crash-before-commit   - SIGKILL right after the restore intent is fsynced (a non-hot rollback journal remains)
//   crash-before-confirm  - SIGKILL after COMMIT, just before the restore confirm line is written
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const [directory, generation, mode] = process.argv.slice(2);
const realWrite = fs.writeSync;
const realFsync = fs.fsyncSync;
let intentWritten = false;
fs.writeSync = (fd, data, ...rest) => {
  const text = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
  if (mode === "crash-before-confirm" && text.includes('"t":"confirm"')) process.kill(process.pid, "SIGKILL");
  const result = realWrite(fd, data, ...rest);
  if (text.includes('"t":"intent"') && text.includes('"k":"restore"')) intentWritten = true;
  return result;
};
fs.fsyncSync = fd => {
  realFsync(fd);
  if (!intentWritten) return;
  intentWritten = false;
  if (mode === "crash-before-commit") process.kill(process.pid, "SIGKILL");
  if (mode === "throw-before-commit") throw new Error("injected failure before COMMIT");
};
syncBuiltinESMExports();

const { restoreTargetStagingFromBackup } = await import("../../lib/target-staging-restore.ts");
const result = restoreTargetStagingFromBackup({ stagingDirectory: directory, expectedRestoreGeneration: generation });
process.stdout.write(JSON.stringify(result));
