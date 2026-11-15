import { expect, test } from "./fixtures";
import { waitUntilSynced } from "./helpers";

// Alphabetically last in the C23 single-worker selection, sharing one real
// synthetic server with the preceding fixture owners.
test("C23: no synthetic workspace survives the ordered fixture owners", async ({ page }) => {
  await page.goto("/");
  await waitUntilSynced(page);
  const leftovers = await page.evaluate(async () => {
    const response = await fetch("/api/store", { cache: "no-store" });
    if (!response.ok) throw new Error(`C23 snapshot: ${response.status}`);
    const snapshot = await response.json();
    const workspacePrefixes = [
      "e2e-family-workspace-", "e2e-project-workspace-", "e2e-boundary-ws-",
      "e2e-icloud-work-", "b5-", "approval-other-", "e2e-b3-workspace-",
      "e2e-b1-history-shared-", "ui01b-shared-", "c21-menu-", "e2e-later-",
    ];
    const entityPrefixes = ["task:one:b5-", "task:two:b5-", "project:b5-",
      "area:b5-", "e2e-personal-area-", "e2e-own-area-"];
    const matches = (id: string, prefixes: string[]) => prefixes.some((prefix) => id.startsWith(prefix));
    return snapshot.entities.filter((entity: { id: string; type: string; workspaceId: string }) =>
      (entity.workspaceId !== "personal" && matches(entity.workspaceId, workspacePrefixes)) ||
      matches(entity.id, entityPrefixes)).map((entity: { id: string }) => entity.id).sort();
  });
  expect(leftovers, "all synthetic workspace fixtures must be deleted before the next spec").toEqual([]);
});
