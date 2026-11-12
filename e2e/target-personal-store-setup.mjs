// Creates the REAL isolated target store of the personal acceptance run (opt-in
// LUMI_TARGET_PERSONAL_ACCEPTANCE_E2E). Run by playwright.config.ts with
// `node --experimental-loader scripts/target-staging-ts-loader.mjs`:
//   node ... e2e/target-personal-store-setup.mjs <run-dir> <owner-user-id> [1 = run dir created by the config]
// Prints the staging settings as JSON. The directory lives inside the Playwright run dir;
// no legacy data path or production state is touched. Direct SQL seeds ONLY what no
// route can create yet: private Area projects and a shared Area for an ACL
// revocation-between-search-and-click regression (one viewer per viewport).
import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const [runDir, owner, createdByConfig] = process.argv.slice(2);
const fail = (message) => { process.stderr.write(`target-personal-store-setup: ${message}\n`); process.exit(2); };
if (!runDir || !path.isAbsolute(runDir) || !owner) fail("usage: <absolute run dir> <owner user id> [created-by-config]");
// The caller's REAL data directory (the one the bootstrap guard protects) is resolved BEFORE anything else and is
// never overridden here, so the guard stays meaningful: the run dir must neither equal nor lie inside it.
const real = (value) => { try { return realpathSync(value); } catch { return path.resolve(value); } };
const within = (child, parent) => child === parent || child.startsWith(parent + path.sep);
const { resolveDataDirectory } = await import("../lib/data-dir.ts");
const callerData = real(resolveDataDirectory());
const run = real(runDir);
if (within(run, callerData)) fail(`the run dir ${run} is inside the live data directory ${callerData}; refusing`);
if (createdByConfig !== "1" && !within(run, real(os.tmpdir()))) fail(`a preset run dir must live under ${real(os.tmpdir())}; refusing ${run}`);
if (!path.basename(run).startsWith("lumi-e2e-")) fail("the run dir must be a lumi-e2e-* directory");
const { bootstrapIsolatedTargetStore } = await import("../lib/target-store-bootstrap.ts");
const stage = bootstrapIsolatedTargetStore({ stagingDirectory: path.join(runDir, "target-store"), ownerUserId: owner });

// Distinct project/task fixtures per viewport AND per spec: each real-store
// acceptance mutates titles, so parallel or sequential specs must not collide.
const seed = { areaId: "area:e2e:rodina", areaTitle: "Rodina", projects: {}, searchProjects: {}, revokeProjects: {} };
for (const width of ["390", "1280"]) {
  seed.projects[width] = {
    projectId: `project:e2e:${width}`, projectTitle: `Seed Projekt ${width}`,
    taskId: `task:e2e:${width}`, taskTitle: `Seed úkol v projektu ${width}`,
  };
  seed.searchProjects[width] = {
    projectId: `project:e2e:search:${width}`, projectTitle: `Seed Projekt Search ${width}`,
    taskId: `task:e2e:search:${width}`, taskTitle: `Seed úkol Search ${width}`,
  };
  seed.revokeProjects[width] = {
    adminId: `owner:e2e:revoke:${width}`,
    workspaceId: `workspace:e2e:revoke:${width}`,
    areaId: `area:e2e:revoke:${width}`,
    projectId: `project:e2e:revoke:${width}`,
    projectTitle: `Revocable confidential project ${width}`,
  };
}
const db = new DatabaseSync(stage.databasePath);
try {
  db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000");
  const workspace = db.prepare("SELECT id FROM workspaces WHERE kind='personal' AND owner_user_id=?").get(owner);
  db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id) VALUES (?,?,'private',?,?)")
    .run(seed.areaId, seed.areaTitle, workspace.id, owner);
  for (const item of [...Object.values(seed.projects), ...Object.values(seed.searchProjects)]) {
    db.prepare("INSERT INTO projects(id,area_id,title) VALUES (?,?,?)").run(item.projectId, seed.areaId, item.projectTitle);
    db.prepare("INSERT INTO tasks(id,project_id,title) VALUES (?,?,?)").run(item.taskId, item.projectId, item.taskTitle);
  }
  // The signed-in synthetic owner is a viewer, *not* the admin of these shared
  // Areas. Deleting only that viewer later leaves a valid admin and enforces a
  // real authorization refusal on the existing project route.
  for (const item of Object.values(seed.revokeProjects)) {
    db.prepare("INSERT INTO identities(id) VALUES (?)").run(item.adminId);
    db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES (?,'shared',?)")
      .run(item.workspaceId, item.adminId);
    db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id) VALUES (?,'Revocable Area','shared',?,?)")
      .run(item.areaId, item.workspaceId, item.adminId);
    db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES (?,?,'admin')")
      .run(item.areaId, item.adminId);
    db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES (?,?,'viewer')")
      .run(item.areaId, owner);
    db.prepare("INSERT INTO projects(id,area_id,title) VALUES (?,?,?)")
      .run(item.projectId, item.areaId, item.projectTitle);
  }
} finally {
  db.close();
}
process.stdout.write(JSON.stringify({
  directory: stage.directory, restoreGeneration: stage.restoreGeneration, ownerUserId: owner, seed,
}) + "\n");
