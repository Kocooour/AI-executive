/** Source can be enabled independently; details remain off by default. */
import {test,expect} from "./fixtures";
// #404: here only detail links are OFF; the global index preview must be ON.
test.skip(process.env.AI_EXECUTIVE_TARGET_STAGING_GLOBAL_INDEX_CLIENT_PREVIEW_ENABLED !== "true",
  "Cross-preview default-off assertion requires enabled global index preview");
const index="/target-staging/global-index/preview";
const indexApi="**/api/target-staging/global-index?*";
const indexPage={
  scope:"all" as const,
  items:[
    {kind:"note",item:{id:"n-3",title:"Ověřená poznámka",areaId:"area-shared",areaKind:"shared",projectId:null,revision:4}},
    {kind:"project",item:{id:"p-1",title:"Ověřený projekt",areaId:"area-private",areaKind:"private"}},
    {kind:"task",item:{id:"t-2",title:"Úkol bez detailu",areaId:"area-private",areaKind:"private",projectId:null,status:"open",dueOn:null}},
  ],
  hasMore:false,nextCursor:null,
};
async function setupIndex(page:import("@playwright/test").Page){
  let indexGets=0;
  await page.route(indexApi,route=>{
    indexGets++;
    return route.fulfill({status:200,headers:{"content-type":"application/json","cache-control":"no-store"},body:JSON.stringify(indexPage)});
  });
  return ()=>indexGets;
}

test("UI-09e default-off has no detail links and both target pages return 404",async({page})=>{
  const gets=await setupIndex(page);
  await page.goto(index);
  await expect(page.getByText("Ověřená poznámka")).toBeVisible();
  await expect(page.getByText("Ověřený projekt")).toBeVisible();
  await expect(page.getByRole("link",{name:/Otevřít (projekt|poznámku):/})).toHaveCount(0);
  await expect(page.locator(".stagingGlobalItemLink")).toHaveCount(0);
  expect(gets()).toBe(1);
  expect((await page.goto("/target-staging/notes/n-3/preview"))?.status()).toBe(404);
  expect((await page.goto("/target-staging/projects/p-1/preview"))?.status()).toBe(404);
});
