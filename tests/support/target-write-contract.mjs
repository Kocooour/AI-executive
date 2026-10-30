// R2c.3 helpers for tests that drive the WRITE target-staging endpoints.
export const PROTOCOL_HEADER = "x-lumi-target-protocol";
export const PROTOCOL = { [PROTOCOL_HEADER]: "1" };

/** The Area a well-behaved client would name: the task's effective Area, else its tombstone's. */
export function taskAreaOf(db, taskId) {
  const live = db.prepare(`SELECT COALESCE(t.area_id,p.area_id) AS id FROM tasks t
    LEFT JOIN projects p ON p.id=t.project_id WHERE t.id=?`).get(taskId);
  if (live) return live.id;
  const tomb = db.prepare("SELECT area_id AS id FROM task_tombstones WHERE id=?").get(taskId);
  return tomb ? tomb.id : "no-such-area";
}

/** Fields a client adds to every per-item write command (undefined payload keys still override). */
export const writeFields = (db, taskId, restoreGeneration) =>
  ({ writeAreaId: taskAreaOf(db, taskId), restoreGeneration });
