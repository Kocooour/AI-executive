/** R3-CAPTURE-3: actual global FAB, opt-in v1 shell, mocked staging HTTP.
 * PR #380 independently tests real SQLite/HTTP ACL and receipt semantics. */
import {test,expect} from "./fixtures";
import type {Page,Route} from "@playwright/test";

test.skip(process.env.LUMI_TARGET_GLOBAL_CAPTURE_E2E!=="true",
  "global private Quick Capture is default-off");
const generation="A".repeat(43);
const headers={"content-type":"application/json","cache-control":"no-store"};
function reply(route:Route,body:unknown,status=200){
  return route.fulfill({status,headers,body:JSON.stringify(body)});
}
async function setup(page:Page,mode:"saved"|"uncertain"="saved"){
  const writes:any[]=[];
  await page.route("**/api/target-staging/session",route=>reply(route,{generation}));
  await page.route("**/api/target-staging/note-index/global**",route=>{
    const scope=new URL(route.request().url()).searchParams.get("scope");
    return reply(route,{scope,notes:[],hasMore:false,nextCursor:null});
  });
  await page.route("**/api/target-staging/notes/create-targets",route=>
    reply(route,{areas:[{id:"private-a",title:"Rodina"}]}));
  await page.route("**/api/target-staging/notes/create-preview",route=>
    reply(route,{restoreGeneration:"123e4567-e89b-42d3-a456-426614174000"}));
  await page.route("**/api/target-staging/notes/create-recovery",route=>
    reply(route,{status:"not_recorded"}));
  await page.route("**/api/target-staging/notes",route=>{
    const data=route.request().postDataJSON();
    writes.push(data);
    expect(data.areaId).toBe("private-a");
    expect(Object.keys(data).sort()).toEqual([
      "areaId","body","commandId","noteId","restoreGeneration","title",
    ]);
    return reply(route,mode==="saved"?{ok:true,noteId:data.noteId}:{error:"unavailable"},
      mode==="saved"?201:503);
  });
  return writes;
}
async function fill(page:Page){
  await page.getByTestId("target-private-area-select").selectOption("private-a");
  const form=page.getByTestId("target-private-create-form");
  await form.getByRole("textbox",{name:"Název"}).fill("Soukromá globální");
  await form.getByRole("textbox",{name:"Text poznámky"}).fill("Citlivý text nezůstane po offline");
}
for(const width of [390,1280]){
  test("global FAB opens outside Notes, restores focus and saves once at "+width+"px",
    async({page})=>{
    await page.setViewportSize({width,height:844});
    const writes=await setup(page);
    await page.goto("/?view=Calendar");
    const fab=page.locator('[data-target-private-capture-fab="'+(width===390?"mobile":"desktop")+'"]');
    await expect(fab).toBeVisible();
    await fab.focus();
    await fab.click();
    const dialog=page.getByTestId("target-private-note-areas");
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId("target-private-area-select")).toHaveValue("");
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(fab).toBeFocused();
    await fab.click();
    await fill(page);
    await page.getByTestId("target-private-create-save").click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId("target-scope-list")).toHaveAttribute("data-kind","note");
    await expect(page).toHaveURL(/view=Notes/);
    expect(writes).toHaveLength(1);
    expect(writes[0].title).toBe("Soukromá globální");
  });
}
test("desktop shortcut opens private creator, not legacy capture",async({page})=>{
  await page.setViewportSize({width:1280,height:844});
  await setup(page);
  await page.goto("/?view=Calendar");
  await page.keyboard.press("Control+Shift+Period");
  await expect(page.getByTestId("target-private-note-areas")).toBeVisible();
  await expect(page.locator(".captureModal")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("target-private-note-areas")).toHaveCount(0);
});
test("offline discards draft and Area without a POST",async({page,context})=>{
  await page.setViewportSize({width:390,height:844});
  const writes=await setup(page);
  await page.goto("/?view=Calendar");
  await page.locator('[data-target-private-capture-fab="mobile"]').click();
  await fill(page);
  await context.setOffline(true);
  await expect(page.getByTestId("target-private-create-form")).toHaveCount(0);
  await context.setOffline(false);
  await expect(page.getByTestId("target-private-area-select")).toBeVisible();
  await page.getByTestId("target-private-area-select").selectOption("private-a");
  await expect(page.getByTestId("target-private-create-form").getByRole("textbox",{name:"Název"})).toHaveValue("");
  expect(writes).toHaveLength(0);
});
test("uncertain global create never resends after reload",async({page})=>{
  await page.setViewportSize({width:390,height:844});
  const writes=await setup(page,"uncertain");
  await page.goto("/?view=Calendar");
  await page.locator('[data-target-private-capture-fab="mobile"]').click();
  await fill(page);
  await page.getByTestId("target-private-create-save").click();
  await expect(page.getByTestId("target-private-create-unresolved")).toBeVisible();
  expect(writes).toHaveLength(1);
  await page.reload();
  await page.locator('[data-target-private-capture-fab="mobile"]').click();
  await expect(page.getByTestId("target-private-create-unresolved")).toBeVisible();
  await expect(page.getByTestId("target-private-create-form")).toHaveCount(0);
  expect(writes).toHaveLength(1);
});
