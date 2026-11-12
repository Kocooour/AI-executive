// Creates the REAL isolated target store of the personal acceptance run (opt-in
// LUMI_TARGET_PERSONAL_ACCEPTANCE_E2E). Run by playwright.config.ts with
// `node --experimental-loader scripts/target-staging-ts-loader.mjs`:
//   node ... e2e/target-personal-store-setup.mjs <run-dir> <owner-user-id>
// Prints the staging settings as JSON. The directory lives inside the Playwright run dir;
// no legacy data path or production state is touched. Direct SQL seeds ONLY what no
// route can create yet: one extra private Area, one private project with one task.
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const [runDir, owner] = process.argv.slice(2);
if (!runDir || !path.isAbsolute(runDir) || !owner) throw new Error("usage: <absolute run dir> <owner user id>");
// The bootstrap compares against the legacy data dir; point it at a sibling of the run dir.
const legacy = path.join(runDir, "data");
process.env.AI_EXECUTIVE_DATA_DIR = legacy;
const { bootstrapIsolatedTargetStore } = await import("../lib/target-store-bootstrap.ts");
const stage = bootstrapIsolatedTargetStore({ stagingDirectory: path.join(runDir, "target-store"), ownerUserId: owner });

// One project with one task per viewport run, so the two runs never share a renamed row.
const seed = { areaId: "area:e2e:rodina", areaTitle: "Rodina", projects: {} };
for (const width of ["390", "1280"]) {
  seed.projects[width] = {
    projectId: `project:e2e:${width}`, projectTitle: `Seed Projekt ${width}`,
    taskId: `task:e2e:${width}`, taskTitle: `Seed úkol v projektu ${width}`,
  };
}
const db = new DatabaseSync(stage.databasePath);
try {
  db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000");
  const workspace = db.prepare("SELECT id FROM workspaces WHERE kind='personal' AND owner_user_id=?").get(owner);
  db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id) VALUES (?,?,'private',?,?)")
    .run(seed.areaId, seed.areaTitle, workspace.id, owner);
  for (const item of Object.values(seed.projects)) {
    db.prepare("INSERT INTO projects(id,area_id,title) VALUES (?,?,?)").run(item.projectId, seed.areaId, item.projectTitle);
    db.prepare("INSERT INTO tasks(id,project_id,title) VALUES (?,?,?)").run(item.taskId, item.projectId, item.taskTitle);
  }
} finally {
  db.close();
}
process.stdout.write(JSON.stringify({
  directory: stage.directory, restoreGeneration: stage.restoreGeneration, ownerUserId: owner, seed,
}) + "\n");
