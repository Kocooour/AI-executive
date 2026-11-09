import { mkdir, lstat, open } from "node:fs/promises";
import { constants } from "node:fs";

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
