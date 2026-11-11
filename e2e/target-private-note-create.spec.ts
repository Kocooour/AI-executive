/** R3-CAPTURE-2: real Notes React UI with synthetic private staging HTTP.
 * Real SQLite/HTTP tests independently protect ACL and receipt semantics. */
import {test,expect} from "./fixtures";
import type {Page,Route} from "@playwright/test";
test.skip(process.env.LUMI_PRIVATE_NOTE_CREATE_E2E!=="true",
  "private create is separately default-off in isolated Chromium only");
const generation="A".repeat(43);
const restoreGeneration="123e4567-e89b-42d3-a456-426614174000";
const choices=[{id:"private-a",title:"Rodina"}];
const headers={"content-type":"application/json","cache-control":"no-store"};
const reply=(route:Route,body:unknown,status=200)=>route.fulfill({
  status,headers,body:JSON.stringify(body),
});
async function setup(page:Page,
  handler:(route:Route,command:any)=>Promise<void>,
  receipt:()=>string=()=>"not_recorded",session:()=>string=()=>generation){
  const created:any[]=[];
  await page.route("**/api/target-staging/session",route=>reply(route,{generation:session()}));
  await page.route("**/api/target-staging/note-index/global**",route=>{
    const scope=new URL(route.request().url()).searchParams.get("scope");
    return reply(route,{scope,notes:[],hasMore:false,nextCursor:null});
  });
  await page.route("**/api/target-staging/notes/create-targets",route=>reply(route,{areas:choices}));
  await page.route("**/api/target-staging/notes/create-preview",async route=>{
    expect(route.request().postDataJSON()).toEqual({areaId:"private-a"});
    await reply(route,{restoreGeneration});
  });
  await page.route("**/api/target-staging/notes/create-recovery",route=>{
    expect(Object.keys(route.request().postDataJSON())).toEqual(["commandId"]);
    return reply(route,{status:receipt()});
  });
  await page.route("**/api/target-staging/notes",async route=>{
    const cmd=route.request().postDataJSON();
    expect(Object.keys(cmd).sort()).toEqual([
      "areaId","body","commandId","noteId","restoreGeneration","title"]);
    expect(cmd.areaId).toBe("private-a");
    expect(cmd.restoreGeneration).toBe(restoreGeneration);
    expect(route.request().headers()["x-lumi-target-protocol"]).toBe("1");
    created.push(cmd);
    await handler(route,cmd);
  });
  await page.goto("/?view=Notes");
  await expect(page.getByTestId("target-scope-list")).toHaveAttribute("data-state","ready");
  return created;
}
async function openAndFill(page:Page){
  await page.getByTestId("target-private-area-open").click();
  const modal=page.getByTestId("target-private-note-areas");
  await expect(modal).toBeVisible();
  await page.getByTestId("target-private-area-select").selectOption("private-a");
  const form=page.getByTestId("target-private-create-form");
  await form.getByRole("textbox",{name:"Název"}).fill("Soukromý titul");
  await form.getByRole("textbox",{name:"Text poznámky"}).fill("Soukromý text v paměti");
  return modal;
}
for(const width of [390,1280]){
  test("private create saved once and list refetches at "+width+"px",async({page})=>{
    await page.setViewportSize({width,height:844});
    const writes=await setup(page,(route,cmd)=>reply(route,{ok:true,noteId:cmd.noteId},201));
    const modal=await openAndFill(page);
    await page.getByTestId("target-private-create-save").click();
    await expect(modal).toHaveCount(0);
    expect(writes).toHaveLength(1);
    expect(writes[0].title).toBe("Soukromý titul");
  });
}
for(const width of [390,1280]){
  test("uncertain create survives reload, no second POST, read-only receipt at "+width+"px",async({page})=>{
    await page.setViewportSize({width,height:844});
    let receiptStatus="not_recorded";
    const writes=await setup(page,route=>
      reply(route,{error:"Staging unavailable"},503),()=>receiptStatus);
    await openAndFill(page);
    await page.getByTestId("target-private-create-save").click();
    const blocked=page.getByTestId("target-private-create-unresolved");
    await expect(blocked).toBeVisible();
    await blocked.getByTestId("target-private-create-receipt").click();
    await expect(blocked).toBeVisible();
    expect(writes).toHaveLength(1);
    await page.reload();
    await expect(page.getByTestId("target-scope-list")).toHaveAttribute("data-state","ready");
    await page.getByTestId("target-private-area-open").click();
    await expect(blocked).toBeVisible();
    await expect(page.getByTestId("target-private-create-form")).toHaveCount(0);
    await expect(page.getByTestId("target-private-note-areas")).not.toContainText("Soukromý text v paměti");
    receiptStatus="committed";
    await blocked.getByTestId("target-private-create-receipt").click();
    await expect(page.getByTestId("target-private-note-areas")).toHaveCount(0);
    expect(writes).toHaveLength(1);
    await page.getByTestId("target-private-area-open").click();
    await expect(page.getByTestId("target-private-create-unresolved")).toHaveCount(0);
    expect(writes).toHaveLength(1);
  });
}
test("unmounted creator does not resend; positive POST unblocks the tab",async({page})=>{
  let delayed:Route|null=null;
  const writes=await setup(page,async route=>{delayed=route;});
  const modal=await openAndFill(page);
  await page.getByTestId("target-private-create-save").click();
  await expect.poll(()=>delayed!==null).toBe(true);
  await modal.getByRole("button",{name:"Zavřít"}).click();
  await expect(modal).toHaveCount(0);
  if(!delayed)throw Error("No CREATE route");
  await reply(delayed,{ok:true,noteId:writes[0].noteId},201);
  await page.getByTestId("target-private-area-open").click();
  await expect(page.getByTestId("target-private-create-unresolved")).toHaveCount(0);
  expect(writes).toHaveLength(1);
});
test("revoked receipt cannot unlock or send another POST",async({page})=>{
  let posts=0;
  const writes=await setup(page,route=>{
    posts++;return reply(route,{error:"Staging unavailable"},503);
  });
  const modal=await openAndFill(page);
  await page.getByTestId("target-private-create-save").click();
  await expect(modal.getByTestId("target-private-create-unresolved")).toBeVisible();
  await page.route("**/api/target-staging/notes/create-recovery",route=>
    reply(route,{error:"session_revoked"},401));
  await page.getByTestId("target-private-create-receipt").click();
  await expect(modal.getByTestId("target-private-create-unresolved")).toBeVisible();
  await expect(modal.getByTestId("target-private-create-form")).toHaveCount(0);
  expect(posts).toBe(1);
  expect(writes).toHaveLength(1);
});

test("rotated session preserves unresolved note CREATE until the current actor verifies receipt",async({page})=>{
  let epoch=generation,receiptStatus="not_recorded";
  const writes=await setup(page,route=>reply(route,{error:"Staging unavailable"},503),
    ()=>receiptStatus,()=>epoch);
  await openAndFill(page);
  await page.getByTestId("target-private-create-save").click();
  await expect(page.getByTestId("target-private-create-unresolved")).toBeVisible();
  expect(writes).toHaveLength(1);
  epoch="B".repeat(43);
  await page.reload();
  await expect(page.getByTestId("target-scope-list")).toHaveAttribute("data-state","ready");
  await page.getByTestId("target-private-area-open").click();
  const modal=page.getByTestId("target-private-note-areas");
  await expect(modal.getByTestId("target-private-create-unresolved")).toBeVisible();
  await expect(modal.getByTestId("target-private-create-form")).toHaveCount(0);
  await modal.getByTestId("target-private-create-receipt").click();
  await expect(modal.getByTestId("target-private-create-unresolved")).toBeVisible();
  expect(writes).toHaveLength(1);
  // Real receipts are authenticated and Area ACL-scoped; this synthetic
  // status only tests the UI's positive-confirmation state transition.
  receiptStatus="committed";
  await modal.getByTestId("target-private-create-receipt").click();
  await expect(modal).toHaveCount(0);
  expect(writes).toHaveLength(1);
});
