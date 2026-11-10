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
  // The shortcut deliberately does not intercept editable/search inputs.
  // Focus a neutral heading, as when invoked outside a text editor.
  await page.locator(".pageTitleRow h1").focus();
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

test("focus-trapped desktop detail opens private capture after closing the detail",async({page})=>{
  await page.setViewportSize({width:1280,height:844});
  const writes=await setup(page);
  const id="123e4567-e89b-42d3-a456-426614174001";
  // The detail may have no readable record; the globally gated action still
  // belongs in its focus trap and must not leak stale detail text into capture.
  await page.route("**/api/target-staging/notes/"+id,route=>
    reply(route,{error:"not-available"},404));
  await page.goto("/?view=Notes&noteId="+id);
  const detail=page.getByTestId("target-detail");
  await expect(detail).toBeVisible();
  const action=detail.getByTestId("target-detail-capture");
  await expect(action).toBeVisible();
  await action.focus();
  await expect(action).toBeFocused();
  await action.press("Enter");
  await expect(detail).toHaveCount(0);
  await expect(page.getByTestId("target-private-note-areas")).toBeVisible();
  await expect(page).not.toHaveURL(/noteId=/);
  await expect(page.getByTestId("target-private-area-select")).toHaveValue("");
  await fill(page);
  await page.getByTestId("target-private-create-save").click();
  await expect(page.getByTestId("target-private-note-areas")).toHaveCount(0);
  expect(writes).toHaveLength(1);
});
test("CREATE in Shared read filter reveals Personal Notes, never changes write Area",async({page})=>{
  await page.setViewportSize({width:390,height:844});
  const writes=await setup(page);
  await page.goto("/?view=Calendar&scope=shared");
  await page.locator('[data-target-private-capture-fab="mobile"]').click();
  await fill(page);
  await page.getByTestId("target-private-create-save").click();
  await expect(page.getByTestId("target-private-note-areas")).toHaveCount(0);
  await expect(page.getByTestId("target-scope-switcher")).toHaveAttribute("data-scope","personal");
  await expect(page.getByTestId("target-scope-list")).toHaveAttribute("data-scope","personal");
  await expect(page).toHaveURL(/view=Notes/);
  await expect(page).toHaveURL(/scope=personal/);
  expect(writes).toHaveLength(1);
  expect(writes[0].areaId).toBe("private-a");
});
test("BFCache lifecycle and real back navigation never revive private draft or Area",async({page})=>{
  await page.setViewportSize({width:390,height:844});
  const writes=await setup(page);
  // A real cross-document navigation MAY restore from BFCache, depending on
  // browser/server cache eligibility. Record whether it actually did.
  await page.addInitScript(()=>{
    (window as Window & {__lumiBfcacheRestored?:boolean}).__lumiBfcacheRestored=false;
    window.addEventListener("pageshow",event=>{
      if(event.persisted)
        (window as Window & {__lumiBfcacheRestored?:boolean}).__lumiBfcacheRestored=true;
    });
  });
  await page.goto("/?view=Calendar");
  const fab=page.locator('[data-target-private-capture-fab="mobile"]');
  await fab.click();
  await fill(page);
  const modal=page.getByTestId("target-private-note-areas");
  // Deterministic BFCache persisted event-path coverage even on CI browsers
  // where HTTP no-store / headless configuration prevents actual caching.
  await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent("pagehide",{persisted:true})));
  await expect(page.getByTestId("target-private-create-form")).toHaveCount(0);
  await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent("pageshow",{persisted:true})));
  await expect(page.getByTestId("target-private-area-select")).toHaveValue("");
  await page.getByTestId("target-private-area-select").selectOption("private-a");
  await expect(page.getByTestId("target-private-create-form")
    .getByRole("textbox",{name:"Název"})).toHaveValue("");
  await fill(page);
  await page.evaluate(()=>{
    (window as Window & {__lumiBfcacheRestored?:boolean}).__lumiBfcacheRestored=false;
  });
  // Real back navigation separately tests the full reload fallback and true
  // BFCache restore when the browser actually admits this page to its cache.
  await page.goto("/robots.txt");
  await page.goBack({waitUntil:"domcontentloaded"});
  const restored=await page.evaluate(()=>
    (window as Window & {__lumiBfcacheRestored?:boolean}).__lumiBfcacheRestored);
  if(restored){
    await expect(modal).toBeVisible();
  }else{
    // A reloaded page must not recreate an abandoned private composer.
    await expect(modal).toHaveCount(0);
    await fab.click();
  }
  await expect(page.getByTestId("target-private-area-select")).toHaveValue("");
  await expect(modal).not.toContainText("Citlivý text nezůstane po offline");
  await page.getByTestId("target-private-area-select").selectOption("private-a");
  await expect(page.getByTestId("target-private-create-form")
    .getByRole("textbox",{name:"Název"})).toHaveValue("");
  expect(writes).toHaveLength(0);
});
