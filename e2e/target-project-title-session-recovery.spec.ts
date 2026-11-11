/** R3-FE-4: focused browser acceptance on the real main-app project editor.
 * Only synthetic mocked staging responses; never production state or database. */
import {test,expect} from "./fixtures";
import type {Page,Route} from "@playwright/test";

test.skip(process.env.LUMI_TARGET_PROJECT_TITLE_E2E!=="true",
  "Focused project title recovery requires isolated staging opt-in");

const HEADERS={"content-type":"application/json","cache-control":"no-store"};
const A="A".repeat(43),B="B".repeat(43),ACTOR="P".repeat(43),OTHER="Q".repeat(43);
const STAGE="f44c1989-809b-4cc0-b198-e1d4d53f3401";
const KEY="lumi-target-project-title-unresolved-v1";
const PROJECT="prj";
const ORIGINAL="Synthetic project";
const PRIVATE="Private rename never to leak";
const response=(route:Route,body:unknown,status=200)=>route.fulfill({
  status,headers:HEADERS,body:JSON.stringify(body),
});
type Patch=(route:Route,body:Record<string,unknown>)=>Promise<void>;
async function setup(page:Page,patch:Patch,params:{
  session:()=>string;binding:()=>string;committed?:()=>boolean;
}){
  await page.route("**/api/target-staging/session",route=>response(route,{
    generation:params.session(),
  }));
  await page.route("**/api/target-staging/project-index/global**",route=>{
    const scope=new URL(route.request().url()).searchParams.get("scope");
    return response(route,{scope,projects:[{
      id:PROJECT,title:params.committed?.()?"Renamed project":ORIGINAL,
      areaId:"private-area",areaKind:"private",
    }],hasMore:false,nextCursor:null});
  });
  await page.route(new RegExp("/api/target-staging/projects/"+PROJECT+"/tasks\\?"),route=>
    response(route,{project:{
      id:PROJECT,title:params.committed?.()?"Renamed project":ORIGINAL,
      areaId:"private-area",areaKind:"private",
    },tasks:[],hasMore:false,nextCursor:null}));
  await page.route(new RegExp("/api/target-staging/projects/"+PROJECT+"/title$"),async route=>{
    if(route.request().method()==="GET")return response(route,{
      snapshotRevision:"a".repeat(64),restoreGeneration:STAGE,
      writeAreaId:"private-area",principalBinding:params.binding(),
    });
    const body=JSON.parse(route.request().postData()??"{}") as Record<string,unknown>;
    // The opaque principal proof is a READ-side comparison, never a PATCH token.
    expect(Object.keys(body).sort()).toEqual([
      "commandId","expectedRevision","restoreGeneration","title","writeAreaId",
    ]);
    return patch(route,body);
  });
  await page.goto("/?view=Projects");
  await expect(page.getByTestId("target-scope-list")).toHaveAttribute("data-state","ready");
}
async function open(page:Page){
  await page.getByTestId("target-scope-list").getByRole("button",{name:/Otevřít.*Synthetic project/}).click();
  await expect(page.getByTestId("target-detail")).toBeVisible();
}
async function edit(page:Page,value:string){
  const form=page.getByTestId("target-project-title-edit");
  await form.getByRole("button",{name:"Upravit název"}).click();
  await expect(form.getByRole("textbox",{name:"Název projektu"})).toBeVisible();
  await form.getByRole("textbox",{name:"Název projektu"}).fill(value);
  await form.getByRole("button",{name:"Uložit změny"}).click();
}
async function marker(page:Page){
  return page.evaluate(key=>sessionStorage.getItem(key),KEY);
}
for(const width of [390,1280])test(
  `coded session expiry reauthenticates SAME actor and retries only original command at ${width}px`,
  async({page})=>{
    await page.setViewportSize({width,height:844});
    let generation=A,writes:Record<string,unknown>[]=[];
    let committed=false;
    await setup(page,async(route,body)=>{
      writes.push(body);
      if(writes.length===1){
        generation=B;
        return response(route,{error:"Authentication required",code:"session_expired"},401);
      }
      expect(body).toEqual(writes[0]);
      committed=true;
      return response(route,{ok:true,replayed:true});
    },{session:()=>generation,binding:()=>ACTOR,committed:()=>committed});
    await open(page);
    await edit(page,PRIVATE);
    await expect.poll(()=>writes.length).toBe(1);
    // New auth epoch forces a server re-read. The verified matching principal
    // permits disclosure of the original in-memory title only to that actor.
    const form=page.getByTestId("target-project-title-edit");
    await expect(form.getByRole("textbox",{name:"Název projektu"})).toHaveValue(PRIVATE);
    await expect(form.getByRole("button",{name:"Ověřit uložením znovu"})).toBeVisible();
    const lock=JSON.parse((await marker(page))??"null") as Record<string,unknown>;
    expect(lock.version).toBe(2);
    const entries=lock.entries as Record<string,unknown>[];
    expect(entries).toEqual([{commandId:writes[0].commandId,principalBinding:ACTOR}]);
    expect(JSON.stringify(lock)).not.toContain(PRIVATE);
    await form.getByRole("button",{name:"Ověřit uložením znovu"}).click();
    await expect.poll(()=>writes.length).toBe(2);
    expect(writes[1]).toEqual(writes[0]); // exact UUID/title/CAS, no new command
    await expect.poll(()=>marker(page)).toBeNull();
  });
for(const width of [390,1280])test(
  `another actor sees no old title and can safely edit under their own principal at ${width}px`,
  async({page})=>{
    await page.setViewportSize({width,height:844});
    let generation=A,binding=ACTOR,writes=0;
    await setup(page,async(route)=>{
      writes++;
      if(writes===1){generation=B;binding=OTHER;
        return response(route,{error:"Authentication required",code:"session_expired"},401);}
      return response(route,{ok:true});
    },{session:()=>generation,binding:()=>binding});
    await open(page);
    await edit(page,PRIVATE);
    await expect.poll(()=>writes).toBe(1);
    const form=page.getByTestId("target-project-title-edit");
    await expect(form.getByRole("button",{name:"Upravit název"})).toBeVisible();
    await expect(form.getByRole("textbox",{name:"Název projektu"})).toHaveCount(0);
    await expect(page.getByText(PRIVATE)).toHaveCount(0);
    const old=JSON.parse((await marker(page))??"null") as {entries:{principalBinding:string}[]};
    expect(old.entries).toEqual([expect.objectContaining({principalBinding:ACTOR})]);
    await edit(page,"Other actor rename");
    await expect.poll(()=>writes).toBe(2);
    await expect.poll(async()=>JSON.parse((await marker(page))??"null")?.entries?.length).toBe(1);
    const left=JSON.parse((await marker(page))??"null") as {entries:{principalBinding:string}[]};
    expect(left.entries[0].principalBinding).toBe(ACTOR);
  });
for(const width of [390,1280])test(
  `reload after ambiguous PATCH locks writes until same-actor committed receipt at ${width}px`,
  async({page})=>{
    await page.setViewportSize({width,height:844});
    let writes=0,originalId="";
    let receiptRequests=0;
    await page.route("**/api/target-staging/project-title/recovery",async route=>{
      receiptRequests++;
      const input=JSON.parse(route.request().postData()??"{}") as Record<string,unknown>;
      expect(input).toEqual({commandId:originalId});
      return response(route,{status:"committed",principalBinding:ACTOR});
    });
    await setup(page,async(route,command)=>{
      writes++;originalId=String(command.commandId);
      return response(route,{error:"Staging unavailable"},503);
    },{session:()=>A,binding:()=>ACTOR});
    await open(page);
    await edit(page,PRIVATE);
    await expect(page.getByTestId("target-project-title-edit")
      .getByRole("button",{name:"Ověřit uložením znovu"})).toBeVisible();
    expect(writes).toBe(1);
    const before=JSON.parse((await marker(page))??"null") as Record<string,unknown>;
    expect(before).toEqual({version:2,entries:[{commandId:originalId,principalBinding:ACTOR}]});
    await page.reload();
    await expect(page.getByTestId("target-scope-list")).toHaveAttribute("data-state","ready");
    await expect(page.getByText(PRIVATE)).toHaveCount(0);
    if(await page.getByTestId("target-detail").isVisible()){
      // Deep link can restore the project dialog on mobile and desktop.
      await expect(page.getByTestId("target-project-title-edit")
        .getByRole("button",{name:"Ověřit předchozí zápis"})).toBeVisible();
    }else await open(page);
    const form=page.getByTestId("target-project-title-edit");
    await expect(form.getByRole("button",{name:"Ověřit předchozí zápis"})).toBeVisible();
    expect(writes).toBe(1);
    await form.getByRole("button",{name:"Ověřit předchozí zápis"}).click();
    await expect.poll(()=>marker(page)).toBeNull();
    expect(receiptRequests).toBe(1);
    expect(writes).toBe(1);
    await expect(form.getByRole("button",{name:"Upravit název"})).toBeVisible();
  });

for(const width of [390,1280])test(
  `not_recorded requires durable cancel before a new project rename at ${width}px`,
  async({page})=>{
    await page.setViewportSize({width,height:844});
    let writes:Record<string,unknown>[]=[],originalId="",cancelled=false,committed=false;
    await page.route("**/api/target-staging/project-title/recovery",route=>
      response(route,{status:"not_recorded"}));
    await page.route("**/api/target-staging/projects/prj/title/cancel",async route=>{
      const input=JSON.parse(route.request().postData()??"{}") as Record<string,unknown>;
      expect(input).toEqual({commandId:originalId,restoreGeneration:STAGE});
      cancelled=true;
      return response(route,{status:"cancelled"});
    });
    await setup(page,async(route,body)=>{
      writes.push(body);
      if(writes.length===1){originalId=String(body.commandId);
        return response(route,{error:"Staging unavailable"},503);}
      expect(cancelled).toBe(true);
      expect(body.commandId).not.toBe(originalId);
      committed=true;
      return response(route,{ok:true});
    },{session:()=>A,binding:()=>ACTOR,committed:()=>committed});
    await open(page);
    await edit(page,PRIVATE);
    await expect(page.getByTestId("target-project-title-edit")
      .getByRole("button",{name:"Ověřit uložením znovu"})).toBeVisible();
    await page.reload();
    await expect(page.getByTestId("target-scope-list")).toHaveAttribute("data-state","ready");
    if(!(await page.getByTestId("target-detail").isVisible()))await open(page);
    const form=page.getByTestId("target-project-title-edit");
    await expect(form.getByRole("button",{name:"Ověřit předchozí zápis"})).toBeVisible();
    await form.getByRole("button",{name:"Ověřit předchozí zápis"}).click();
    await expect(form.getByRole("button",{name:"Bezpečně ukončit nevyřízený zápis"})).toBeVisible();
    expect(cancelled).toBe(false);
    expect((await marker(page))).not.toBeNull();
    await form.getByRole("button",{name:"Bezpečně ukončit nevyřízený zápis"}).click();
    await expect.poll(()=>marker(page)).toBeNull();
    await expect(form.getByRole("button",{name:"Upravit název"})).toBeVisible();
    await edit(page,"Fresh authorized rename");
    await expect.poll(()=>writes.length).toBe(2);
    expect(committed).toBe(true);
  });
