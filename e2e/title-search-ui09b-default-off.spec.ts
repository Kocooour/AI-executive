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
