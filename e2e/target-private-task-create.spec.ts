/** R3-FE-6: isolated real-React task Quick Capture at 390/1280 px.
 * All staging HTTP is synthetic Playwright interception; the server uses
 * disposable E2E credentials and never writes real personal task data.
 * Real SQLite/HTTP ACL and idempotency are covered by separate backend tests. */
import {test,expect} from "./fixtures";
import type {Page,Route} from "@playwright/test";

test.skip(process.env.LUMI_PRIVATE_TASK_CREATE_E2E!=="true",
  "private task Quick Capture is default-off, only isolated browser QA opts in");

const generation="A".repeat(43);
const restore="123e4567-e89b-42d3-a456-426614174000";
const headers={"content-type":"application/json","cache-control":"no-store"};
const reply=(route:Route,body:unknown,status=200)=>route.fulfill({
  status,headers,body:JSON.stringify(body),
});
type Cmd={taskId:string;commandId:string;areaId:string;restoreGeneration:string;title:string};
async function setup(page:Page,create:(route:Route,cmd:Cmd)=>Promise<void>,
  receipt:()=>string=()=>"not_recorded"){
  const posted:Cmd[]=[];
  await page.route("**/api/target-staging/session",route=>reply(route,{generation}));
  await page.route("**/api/target-staging/note-index/global**",route=>{
    const scope=new URL(route.request().url()).searchParams.get("scope");
    return reply(route,{scope,notes:[],hasMore:false,nextCursor:null});
  });
  await page.route("**/api/target-staging/notes/create-targets",route=>
    reply(route,{areas:[{id:"private-a",title:"Rodina"}]}));
  await page.route("**/api/target-staging/notes/create-preview",route=>
    reply(route,{restoreGeneration:restore}));
  await page.route("**/api/target-staging/tasks/create-status",route=>{
    expect(route.request().postDataJSON()).toEqual(posted[0],
      "status must send the original full command, not create a second task");
    return reply(route,{status:receipt()});
  });
  await page.route("**/api/target-staging/tasks",async route=>{
    const cmd=route.request().postDataJSON() as Cmd;
    expect(Object.keys(cmd).sort()).toEqual([
      "areaId","commandId","restoreGeneration","taskId","title"]);
    expect(cmd.areaId).toBe("private-a");
    expect(cmd.restoreGeneration).toBe(restore);
    expect(route.request().headers()["x-lumi-target-protocol"]).toBe("1");
    posted.push(cmd);
    await create(route,cmd);
  });
  await page.route("**/api/target-staging/my-plan/slice?**",route=>{
    const url=new URL(route.request().url());
    const evaluationDate=url.searchParams.get("evaluationDate");
    const areaFilter=url.searchParams.get("areaFilter")||"all";
    return reply(route,{evaluationDate,areaFilter,
      today:{tasks:[],hasMore:false},tomorrow:{tasks:[],hasMore:false},
      hasMore:false,nextCursor:null});
  });
  await page.route("**/api/target-staging/task-temporal/**",route=>
    reply(route,{error:"not-available"},404));
  return posted;
}
function fab(page:Page,width:number){
  return page.locator('[data-target-private-capture-fab="'+(width===390?"mobile":"desktop")+'"]');
}
async function openAndFill(page:Page,width:number,title="Citlivý nový úkol"){
  await fab(page,width).click();
  await expect(page.getByTestId("target-private-quick-capture")).toBeVisible();
  await page.getByTestId("target-capture-task-kind").click();
  const modal=page.getByTestId("target-private-task-capture");
  await expect(modal).toBeVisible();
  await page.getByTestId("target-private-task-area").selectOption("private-a");
  await page.getByTestId("target-private-task-form").getByRole("textbox",{name:"Název úkolu"}).fill(title);
  return modal;
}
for(const width of [390,1280]){
  test("exact single POST, server confirmation, and authorized detail at "+width+"px",async({page})=>{
    await page.setViewportSize({width,height:844});
    const writes=await setup(page,(route,cmd)=>reply(route,{ok:true,taskId:cmd.taskId},201));
    await page.goto("/?view=Calendar&scope=shared");
    const modal=await openAndFill(page,width);
    await expect(modal.getByRole("button",{name:"Zavřít"})).toBeFocused();
    await page.getByTestId("target-private-task-save").click();
    await expect(modal).toHaveCount(0);
    const notice=page.getByTestId("target-private-task-created");
    await expect(notice).toBeVisible();
    expect(writes).toHaveLength(1);
    const taskId=writes[0].taskId;
    const persisted=await page.evaluate(()=>
      JSON.stringify([sessionStorage.getItem("lumi-private-task-create-unresolved-v1"),
        Object.entries(localStorage)]));
    expect(persisted).not.toContain("Citlivý nový úkol");
    expect(persisted).not.toContain(writes[0].areaId);
    await notice.getByTestId("target-private-task-open").click();
    await expect(page).toHaveURL(/view=MyPlanPreview/);
    await expect(page).toHaveURL(/scope=personal/);
    await expect(page).toHaveURL(new RegExp("taskId="+taskId));
    await expect(page.getByTestId("target-detail")).toBeVisible();
  });
}
test("close/reopen during uncertain POST unlocks only on exact committed receipt",async({page})=>{
  await page.setViewportSize({width:390,height:844});
  let hold:Route|null=null,status="not_recorded";
  const writes=await setup(page,async route=>{hold=route;},()=>status);
  await page.goto("/?view=Calendar");
  const modal=await openAndFill(page,390);
  await page.getByTestId("target-private-task-save").click();
  await expect.poll(()=>hold!==null).toBe(true);
  await modal.getByRole("button",{name:"Zavřít"}).click();
  await expect(modal).toHaveCount(0);
  await fab(page,390).click();
  await page.getByTestId("target-capture-task-kind").click();
  const reopened=page.getByTestId("target-private-task-capture");
  await expect(reopened).toBeVisible();
  await expect(page.getByTestId("target-private-task-receipt")).toHaveCount(0);
  if(!hold)throw Error("task CREATE not dispatched");
  await reply(hold,{error:"unavailable"},503);
  const verify=page.getByTestId("target-private-task-receipt");
  await expect(verify).toBeEnabled();
  await verify.click();
  await expect(page.getByTestId("target-private-task-unresolved")).toBeVisible();
  expect(writes).toHaveLength(1);
  status="committed";
  await verify.click();
  await expect(reopened).toHaveCount(0);
  await expect(page.getByTestId("target-private-task-created")).toBeVisible();
  expect(writes).toHaveLength(1);
});
test("close before successful POST still announces the saved task without another write",async({page})=>{
  await page.setViewportSize({width:1280,height:844});
  let hold:Route|null=null;
  const writes=await setup(page,async route=>{hold=route;});
  await page.goto("/?view=Calendar");
  const modal=await openAndFill(page,1280);
  await page.getByTestId("target-private-task-save").click();
  await expect.poll(()=>hold!==null).toBe(true);
  await modal.getByRole("button",{name:"Zavřít"}).click();
  if(!hold)throw Error("task CREATE not dispatched");
  await reply(hold,{ok:true,taskId:writes[0].taskId},201);
  await expect(page.getByTestId("target-private-task-created")).toBeVisible();
  expect(writes).toHaveLength(1);
});
test("uncertain task CREATE cannot be resent after reload; private title is not stored",async({page})=>{
  await page.setViewportSize({width:390,height:844});
  const writes=await setup(page,route=>reply(route,{error:"unavailable"},503));
  await page.goto("/?view=Calendar");
  await openAndFill(page,390);
  await page.getByTestId("target-private-task-save").click();
  await expect(page.getByTestId("target-private-task-unresolved")).toBeVisible();
  const stored=await page.evaluate(()=>sessionStorage.getItem("lumi-private-task-create-unresolved-v1"));
  expect(stored).toContain(writes[0].commandId);
  expect(stored).not.toContain(writes[0].title);
  await page.reload();
  await fab(page,390).click();
  await page.getByTestId("target-capture-task-kind").click();
  await expect(page.getByTestId("target-private-task-unresolved")).toBeVisible();
  await expect(page.getByTestId("target-private-task-form")).toHaveCount(0);
  await expect(page.getByTestId("target-private-task-receipt")).toHaveCount(0);
  expect(writes).toHaveLength(1);
});
test("preflight timeout restores a retryable Area selection without CREATE",async({page})=>{
  test.setTimeout(45000);
  await page.setViewportSize({width:390,height:844});
  const writes=await setup(page,(route,cmd)=>reply(route,{ok:true,taskId:cmd.taskId},201));
  let timeoutRoute:Route|null=null;
  await page.route("**/api/target-staging/notes/create-preview",route=>{timeoutRoute=route;});
  await page.goto("/?view=Calendar");
  await openAndFill(page,390);
  await page.getByTestId("target-private-task-save").click();
  await expect.poll(()=>timeoutRoute!==null).toBe(true);
  await expect(page.getByTestId("target-private-task-area")).toHaveValue("",{timeout:15000});
  await expect(page.getByTestId("target-private-task-area")).toBeEnabled();
  expect(writes).toHaveLength(0);
  await timeoutRoute?.abort("failed").catch(()=>{});
});
test("receipt timeout re-enables exact verification; never retries CREATE",async({page})=>{
  test.setTimeout(45000);
  await page.setViewportSize({width:1280,height:844});
  const writes=await setup(page,route=>reply(route,{error:"unavailable"},503));
  let timeoutRoute:Route|null=null;
  await page.route("**/api/target-staging/tasks/create-status",route=>{timeoutRoute=route;});
  await page.goto("/?view=Calendar");
  await openAndFill(page,1280);
  await page.getByTestId("target-private-task-save").click();
  const verify=page.getByTestId("target-private-task-receipt");
  await expect(verify).toBeEnabled();
  await verify.click();
  await expect.poll(()=>timeoutRoute!==null).toBe(true);
  await expect(verify).toBeEnabled({timeout:15000});
  expect(writes).toHaveLength(1);
  await timeoutRoute?.abort("failed").catch(()=>{});
});
