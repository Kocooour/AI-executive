import { writeFileSync } from "node:fs";
import { expect, test as setup } from "@playwright/test";
import { sessionFile } from "../playwright.config";
import { seeded, signIn } from "./helpers";

// Signs in once, fills the instance with synthetic data and keeps the session for the scenarios.
// Signing in is rate limited, so the scenarios reuse this session instead of signing in each time.
setup("sign in and seed synthetic data", async ({ page }) => {
  await page.goto("/");
  await signIn(page);
  // #501: the full personal-v1 acceptance suite deliberately starts with a
  // purged legacy Archive. This shared setup previously reintroduced test
  // entities via PUT /api/store *after* the purge preflight and before the
  // browser case could inspect it. Do not seed the retired Archive for this
  // profile; the isolated target store has its own independent seeded data.
  // The off-mode and all other legacy E2E setups are intentionally unchanged.
  if (process.env.LUMI_TARGET_PERSONAL_ACCEPTANCE_E2E === "true") {
    const result = await page.evaluate(async () => {
      const response = await fetch("/api/store", { cache: "no-store" });
      if (!response.ok) return { status: response.status, count: -1 };
      const snapshot = await response.json() as { entities: Array<{ type: string }> };
      // The purge keeps only structural workspace containers.
      return { status: response.status,
        count: snapshot.entities.filter((entity) => entity.type !== "workspace").length };
    });
    expect(result).toEqual({ status: 200, count: 0 });
  } else {
  const result = await page.evaluate(async (names) => {
    const snapshot = await fetch("/api/store", { cache: "no-store" }).then((response) => response.json());
    const now = Date.now();
    const day = (offset: number) => new Date(now + offset * 86_400_000).toISOString().slice(0, 10);
    const entity = (id: string, type: string, title: string, properties: Record<string, unknown> = {}) =>
      ({ id, type, title, status: type === "project" ? "active" : "open", workspaceId: "personal", properties, createdAt: now, updatedAt: now });
    const entities = [
      ...snapshot.entities,
      entity("e2e-project", "project", names.project),
      entity("e2e-overdue", "task", names.overdueTask, { deadline: day(-2) }),
      entity("e2e-plain", "task", names.plainTask, { inbox: true }),
      entity("e2e-rename", "task", names.renameTask, { inbox: true }),
    ];
    const saved = await fetch("/api/store", { method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseRevision: snapshot.revision, restoreGeneration: snapshot.restoreGeneration, entities, relations: snapshot.relations, deletedIds: [], revivedIds: [] }) });
    return saved.status;
  }, seeded);
  expect(result).toBe(200);
  }
  // Only the session cookie is kept: every scenario starts with an empty browser (no local copy and
  // no sync marks), the way a newly opened browser with a valid session would.
  const { cookies } = await page.context().storageState();
  writeFileSync(sessionFile, JSON.stringify({ cookies, origins: [] }));
});
