import path from "node:path";
import { expect, test as setup } from "@playwright/test";
import { seeded, signIn } from "./helpers";

// Signs in once, fills the instance with synthetic data and keeps the session for the scenarios.
// Signing in is rate limited, so the scenarios reuse this session instead of signing in each time.
setup("sign in and seed synthetic data", async ({ page }) => {
  await page.goto("/");
  await signIn(page);
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
    ];
    const saved = await fetch("/api/store", { method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseRevision: snapshot.revision, entities, relations: snapshot.relations, deletedIds: [], revivedIds: [] }) });
    return saved.status;
  }, seeded);
  expect(result).toBe(200);
  await page.context().storageState({ path: path.join(process.env.E2E_DATA_DIR!, "session.json") });
});
