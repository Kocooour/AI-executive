/** R3-QA-01: opt-in focused browser acceptance of the actual main-app editor.
 * Synthetic, actor-scoped staging responses only. No production data or real
 * writes; this is NOT the full release Browser E2E suite. */
import {expect,test} from "./fixtures";
import type {Page,Route} from "@playwright/test";
import {
  NOTE_EDIT_COMMAND_HEADER,NOTE_EDIT_PRECOMMIT_HEADER,NOTE_EDIT_PRECOMMIT_VALUE,
} from "../lib/target-note-edit-precommit";

test.skip(process.env.LUMI_TARGET_NOTE_EDIT_E2E!=="true",
  "Focused target note editor requires explicit isolated browser opt-in");

const headers={"content-type":"application/json","cache-control":"no-store"};
const generation="A".repeat(43);
const restoreGeneration="f44c1989-809b-4cc0-b198-e1d4d53f3401";
const noteIds=["note-a","note-b"] as const;
const note=(id:string)=>({
  id,title:id==="note-a"?"Note A":"Note B",body:id==="note-a"?"A private body":"B private body",
  projectId:null,areaId:"private-area",areaKind:"private",revision:1,
});
const receiptKey="lumi-target-note-edit-unresolved-v2";
const integrated=process.env.LUMI_TARGET_NOTE_EDIT_PROFILE==="combined"||
  process.env.LUMI_TARGET_NOTE_EDIT_PROFILE==="4b";
const reply=(route:Route,body:unknown,status=200)=>route.fulfill({
  status,headers,body:JSON.stringify(body),
});
const preCommitReply=(route:Route,body:unknown,status:400|403|404|409,commandId:string)=>{
  expect(route.request().headers()[NOTE_EDIT_COMMAND_HEADER]).toBe(commandId);
  return route.fulfill({status,
    headers:{...headers,[NOTE_EDIT_PRECOMMIT_HEADER]:NOTE_EDIT_PRECOMMIT_VALUE,
      [NOTE_EDIT_COMMAND_HEADER]:commandId},
    body:JSON.stringify(body)});
};
type Patch=(route:Route,command:Record<string,unknown>)=>Promise<void>;
async function setup(page:Page,patch:Patch,recover?:Patch){
  await page.route("**/api/target-staging/session",route=>
    reply(route,{generation}));
  await page.route("**/api/target-staging/note-index/global**",route=>{
    const scope=new URL(route.request().url()).searchParams.get("scope");
    return reply(route,{scope,notes:noteIds.map(id=>({
      id,title:note(id).title,projectId:null,areaId:"private-area",
      areaKind:"private",revision:1,
    })),hasMore:false,nextCursor:null});
  });
  await page.route("**/api/target-staging/notes/edit-recovery",async route=>{
    const command=JSON.parse(route.request().postData()??"{}") as Record<string,unknown>;
    if(recover)return recover(route,command);
    return reply(route,{status:"not_recorded"});
  });
  // Exact paths: a note GET must never swallow its edit preflight/PATCH.
  await page.route(/\/api\/target-staging\/notes\/note-[ab]\/edit$/,async route=>{
    const id=route.request().url().includes("note-a")?"note-a":"note-b";
    if(route.request().method()==="GET")
      return reply(route,{expectedRevision:"a".repeat(64),
        writeAreaId:"private-area",restoreGeneration});
    const command=JSON.parse(route.request().postData()??"{}") as Record<string,unknown>;
    expect(command).toMatchObject({writeAreaId:"private-area",restoreGeneration});
    expect(typeof command.commandId).toBe("string");
    return patch(route,command);
  });
  await page.route(/\/api\/target-staging\/notes\/note-[ab]$/,route=>{
    const id=route.request().url().includes("note-a")?"note-a":"note-b";
    return reply(route,{note:note(id)});
  });
  await page.goto("/?view=Notes");
  await expect(page.getByTestId("target-scope-list")).toHaveAttribute("data-state","ready");
}
async function open(page:Page,id:"note-a"|"note-b"){
  const title=id==="note-a"?"Note A":"Note B";
  await page.getByRole("button",{name:new RegExp("Otevřít.*"+title)}).click();
  await expect(page.getByTestId("target-detail")).toBeVisible();
  await expect(page.getByText(note(id).body)).toBeVisible();
  if(integrated){
    // 4b note-delete may coexist with the recovery-safe PATCH editor,
    // but there must never be an independent, UUID-minting 4b note editor.
    await expect(page.getByTestId("target-detail-edit-note")).toHaveCount(0);
  }
}
async function close(page:Page){
  await page.getByTestId("target-detail").getByRole("button",{name:/Zavřít|Zpět/}).click();
  await expect(page.getByTestId("target-detail")).toHaveCount(0);
}
async function editAndSave(page:Page,value:string){
  const form=page.getByTestId("target-note-edit");
  await form.getByRole("button",{name:"Upravit poznámku"}).click();
  await expect(form.getByRole("textbox",{name:"Název"})).toBeVisible();
  await form.getByRole("textbox",{name:"Název"}).fill(value);
  await form.getByRole("button",{name:"Uložit změny"}).click();
}
async function marker(page:Page){
  return page.evaluate(key=>sessionStorage.getItem(key),receiptKey);
}

for(const width of [390,1280]){
  test(`first PATCH 409 after closing detail releases unrelated note editing at ${width}px`,async({page})=>{
    await page.setViewportSize({width,height:844});
    let pending:{route?:Route}={};
    let requests=0;
    await setup(page,async(route,command)=>{
      requests++;
      if(requests===1){
        pending.route=route;
        return; // delay definitive conflict until the editor is unmounted
      }
      return reply(route,{ok:true});
    });
    await open(page,"note-a");
    if(integrated)await expect(page.getByTestId("target-detail-edit-delete")).toBeVisible();
    await editAndSave(page,"Conflicting draft");
    if(integrated)await expect(page.getByTestId("target-detail-edit-delete")).toHaveCount(0);
    await expect.poll(()=>Boolean(pending.route)).toBe(true);
    const first=JSON.parse((await marker(page))??"null") as {commandId:string};
    expect(first?.commandId).toBeTruthy();
    await close(page); // unsubscribes the source editor before 409
    await preCommitReply(pending.route!,{error:"Revision conflict"},409,first.commandId);
    await expect.poll(()=>marker(page)).toBeNull();
    await open(page,"note-b");
    await editAndSave(page,"Independent B");
    await expect(page.getByTestId("target-note-edit")).not.toContainText(
      "Předchozí zápis není po obnovení stránky potvrzený");
    await expect.poll(()=>requests).toBe(2);
    await expect.poll(()=>marker(page)).toBeNull();
  });
}

for(const width of [390,1280]){
test(`uncertain PATCH then retry 409 retains tab marker; other notes stay readable at ${width}px`,async({page})=>{
  await page.setViewportSize({width,height:844});
  const sent:string[]=[];
  await setup(page,async(route,command)=>{
    sent.push(String(command.commandId));
    if(sent.length===1)return reply(route,{error:"Staging unavailable"},503);
    return preCommitReply(route,{error:"Revision conflict"},409,String(command.commandId));
  });
  await open(page,"note-a");
  if(integrated)await expect(page.getByTestId("target-detail-edit-delete")).toBeVisible();
  await editAndSave(page,"Uncertain A");
  if(integrated)await expect(page.getByTestId("target-detail-edit-delete")).toHaveCount(0);
  const form=page.getByTestId("target-note-edit");
  const id=JSON.parse((await marker(page))??"null") as {commandId:string};
  await expect(form.getByRole("button",{name:"Ověřit uložením znovu"})).toBeVisible();
  await form.getByRole("button",{name:"Ověřit uložením znovu"}).click();
  await expect(form.getByRole("button",{name:"Zahodit koncept a načíst aktuální obsah"})).toBeVisible();
  expect(sent).toEqual([id.commandId,id.commandId]); // exact UUID retry
  expect((await marker(page))).not.toBeNull();
  await close(page);
  await open(page,"note-b");
  await expect(page.getByText("B private body")).toBeVisible();
  const other=page.getByTestId("target-note-edit");
  if(integrated)await expect(page.getByTestId("target-detail-edit-delete")).toHaveCount(0);
  await expect(other.getByRole("button",{name:"Ověřit předchozí zápis"})).toBeVisible();
  await expect(other.getByRole("button",{name:"Uložit změny"})).toHaveCount(0);
  expect((await marker(page))).not.toBeNull();
  expect(sent).toHaveLength(2);
});
}

for(const width of [390,1280]){
test(`full reload loses private draft; receipt unlocks without another PATCH at ${width}px`,async({page})=>{
  await page.setViewportSize({width,height:844});
  let committedId="";
  let patchCount=0;
  let statusCount=0;
  await setup(page,async(route,command)=>{
    patchCount++;
    committedId=String(command.commandId);
    // Represents a committed write whose acknowledgment was lost.
    return reply(route,{error:"Staging unavailable"},503);
  },async(route,command)=>{
    statusCount++;
    expect(command).toEqual({commandId:committedId});
    return reply(route,{status:"committed"});
  });
  await open(page,"note-a");
  await editAndSave(page,"Private draft that must not persist");
  await expect(page.getByTestId("target-note-edit").getByRole("button",{
    name:"Ověřit uložením znovu",
  })).toBeVisible();
  if(integrated)await expect(page.getByTestId("target-detail-edit-delete")).toHaveCount(0);
  const before=JSON.parse((await marker(page))??"null") as Record<string,unknown>;
  expect(before).toEqual({commandId:committedId,generation});
  await page.reload(); // sessionStorage survives, React draft/CAS does not
  await expect(page.getByTestId("target-scope-list")).toHaveAttribute("data-state","ready");
  // The URL may restore note A's inspector across reload (notably at 390px).
  // Verify the lost private draft is absent, then navigate using the real
  // close control before opening another row underneath the modal backdrop.
  await expect(page.getByText("Private draft that must not persist")).toHaveCount(0);
  if(await page.getByTestId("target-detail").isVisible())await close(page);
  await open(page,"note-b");
  const form=page.getByTestId("target-note-edit");
  await expect(form.getByRole("button",{name:"Ověřit předchozí zápis"})).toBeVisible();
  await expect(form.getByText("Private draft that must not persist")).toHaveCount(0);
  expect(patchCount).toBe(1);
  if(integrated)await expect(page.getByTestId("target-detail-edit-delete")).toHaveCount(0);
  await form.getByRole("button",{name:"Ověřit předchozí zápis"}).click();
  await expect.poll(()=>marker(page)).toBeNull();
  if(integrated)await expect(page.getByTestId("target-detail-edit-delete")).toBeVisible();
  expect(statusCount).toBe(1);
  expect(patchCount).toBe(1); // read-only receipt never sends a PATCH
  await expect(form.getByRole("button",{name:"Upravit poznámku"})).toBeVisible();
});
}
