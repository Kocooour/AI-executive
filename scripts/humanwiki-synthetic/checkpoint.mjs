import { mkdir, lstat, open, rename, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";

export async function ensurePrivateCheckpointDirectory(directory) {
  try { await mkdir(directory, { mode: 0o700 }); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() ||
    metadata.uid !== process.getuid() || (metadata.mode & 0o077) !== 0) {
    throw new Error("Synthetic import: checkpoint directory is not private and owned by this process");
  }
  // O_NOFOLLOW also rejects a symlink substituted between lstat and open.
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (opened.dev !== metadata.dev || opened.ino !== metadata.ino) {
      throw new Error("Synthetic import: checkpoint directory changed during validation");
    }
  } finally { await handle.close(); }
}

export async function writeCheckpointAtomic(directory, statePath, state) {
  const temp = `${statePath}.${randomUUID()}.tmp`;
  let tempOwned = false;
  try {
    const file = await open(temp, "wx", 0o600);
    tempOwned = true;
    try { await file.writeFile(JSON.stringify(state)); await file.sync(); }
    finally { await file.close(); }
    await rename(temp, statePath);
    tempOwned = false;
    const dir = await open(directory, "r");
    try { await dir.sync(); } finally { await dir.close(); }
  } catch (error) {
    if (tempOwned) {
      try { await unlink(temp); }
      catch (cleanupError) {
        if (cleanupError.code !== "ENOENT") throw new AggregateError([error, cleanupError],
          "Synthetic import: checkpoint write and cleanup both failed");
      }
    }
    throw error;
  }
}
