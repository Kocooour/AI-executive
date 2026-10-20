import { expect, test } from "./fixtures";
import { integrationToken } from "../playwright.config";

// Route-level protection of raw evidence/history does not depend on client-side filtering.
// Each test context has its own synthetic address; no production credentials are involved.
test("owner Context Search and Explain reject bearer-only and bearer+cookie, accept owner cookie in one workspace", async ({ page, playwright }) => {
  await page.goto("/");
  const origin = new URL(page.url()).origin;
  const query = "/api/context/search?workspaceId=personal&q=e2e-project";
  const claimId = "e2e-route-auth-" + Date.now();
  const claim = await page.evaluate(async (id) => {
    const response = await fetch("/api/context/claims", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "create", idempotencyKey: crypto.randomUUID(),
        workspaceId: "personal", id, expectedRevision: 0,
        subject: { entityId: "workspace:personal" }, predicate: "e2e.context.route_auth",
        literal: { type: "string", value: "Route owner-only proof" },
        freshness: "current", sensitivity: "normal" }),
    });
    return { status: response.status, body: await response.json() };
  }, claimId);
  expect(claim.status).toBe(201);
  const explain = "/api/context/explain?workspaceId=personal&claimId=" + encodeURIComponent(claimId);
  const anonymous = await playwright.request.newContext({ baseURL: origin, storageState: { cookies: [], origins: [] },
    extraHTTPHeaders: { "x-forwarded-for": "10.10.20.76" } });
  try {
    for (const endpoint of [query, explain]) {
      const unauthorized = await anonymous.get(endpoint);
      expect(unauthorized.status()).toBe(401);
      const bearer = await anonymous.get(endpoint, { headers: { authorization: "Bearer " + integrationToken } });
      expect(bearer.status()).toBe(401);
      const mixed = await page.request.get(endpoint, { headers: { authorization: "Bearer " + integrationToken } });
      expect(mixed.status()).toBe(401);
      const owner = await page.request.get(endpoint);
      expect(owner.status()).toBe(200);
      expect(owner.headers()["cache-control"]).toContain("no-store");
      expect((await owner.json()).workspaceId).toBe("personal");
    }
    const other = await page.request.get("/api/context/explain?workspaceId=unknown-workspace&claimId=" + claimId);
    expect(other.status()).toBe(404);
    expect(JSON.stringify(await other.json())).not.toContain("Route owner-only proof");
    const aggregate = await page.request.get("/api/context/search?workspaceId=all&q=Route");
    expect(aggregate.status()).toBe(400);
    const ownerSearch = await page.request.get("/api/context/search?workspaceId=personal&q=Route%20owner-only%20proof");
    expect(ownerSearch.status()).toBe(200);
    expect((await ownerSearch.json()).results.some((row: { id: string }) => row.id === claimId)).toBe(true);
  } finally {
    await anonymous.dispose();
    await page.evaluate(async (id) => {
      const response = await fetch("/api/context/claims?workspaceId=personal");
      const current = ((await response.json()).claims || []).find((row: { id: string }) => row.id === id);
      if (current) await fetch("/api/context/claims", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "archive", idempotencyKey: crypto.randomUUID(),
          workspaceId: "personal", id, expectedRevision: current.revision }),
      });
    }, claimId);
  }
});
