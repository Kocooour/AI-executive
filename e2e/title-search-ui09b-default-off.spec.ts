/** UI-09b default-deny smoke: the separate synthetic Playwright server must
 * return 404 unless all three preview flags are explicitly enabled.
 * Run with LUMI_TITLE_SEARCH_PREVIEW_E2E=false; no production data is read. */
import {expect,test} from "./fixtures";

test("UI-09b default-off preview is HTTP 404 with no private search UI",async({page})=>{
  const response=await page.goto("/target-staging/title-search/preview");
  expect(response?.status()).toBe(404);
  await expect(page.getByRole("heading",{name:"Hledání v názvech"})).toHaveCount(0);
  await expect(page.getByRole("searchbox",{name:"Hledaný název"})).toHaveCount(0);
});

/** UI-09a compatibility: the title-search opt-in must never turn off another
 * preview's explicitly enabled shared staging HTTP transport. */
test("UI-09b default-off preserves independently enabled global index API",async({page})=>{
  test.skip(process.env.LUMI_EXPECT_SHARED_STAGING_HTTP!=="true",
    "Run with independently enabled global staging HTTP flags");
  const previewResponse=await page.goto("/target-staging/title-search/preview");
  expect(previewResponse?.status()).toBe(404);
  // Without a configured target staging store, an ENABLED global endpoint
  // reports unavailable (503), whereas a forcibly disabled one returns 404.
  const response=await page.request.get("/api/target-staging/global-index?scope=all");
  expect(response.status()).toBe(503);
  await expect(page.getByRole("searchbox",{name:"Hledaný název"})).toHaveCount(0);
});
