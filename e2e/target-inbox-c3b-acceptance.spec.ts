/** C-3b exact real-store 390/1280 browser acceptance.
 * Explicit opt-in only; synthetic external consent fence and mock classifier,
 * no production state, credentials or OpenAI network. */
import {test,expect} from "./fixtures";
import {randomUUID} from "node:crypto";
import path from "node:path";
import {DatabaseSync} from "node:sqlite";
import type {Page} from "@playwright/test";
import {settingsSections} from "./helpers";

test.skip(process.env.LUMI_TARGET_INBOX_C3B_E2E!=="true",
  "C-3b acceptance requires explicit isolated test opt-in");
const store=JSON.parse(process.env.LUMI_E2E_TARGET_STORE||"null") as {
  directory:string;restoreGeneration:string;ownerUserId:string;
  seed:{createAreaTitle:string;c3bProjects:Record<string,{
    projectId:string;projectTitle:string;taskId:string;taskTitle:string}>};
}|null;
const readTask=(id:string)=>{
  if(!store)throw Error("missing isolated SQLite");
  // The app's pinned BEGIN IMMEDIATE writer may briefly hold the SQLite
  // rollback-journal lock while this test observes Accept/Undo. Bound the
  // read-only probe's lock wait; never mutate the database from the test.
  const db=new DatabaseSync(path.join(store.directory,"lumi-target.sqlite"),
    {readOnly:true,timeout:2000});
  try{
    const task=db.prepare(`SELECT id,project_id AS projectId,area_id AS areaId,
      triage_state AS triageState FROM tasks WHERE id=?`).get(id) as
      {id:string;projectId:string|null;areaId:string|null;triageState:string}|undefined;
    const plan=db.prepare(`SELECT when_on AS whenOn FROM personal_task_plans
      WHERE user_id=? AND task_id=?`).get(store.ownerUserId,id) as
      {whenOn:string}|undefined;
    return {task,whenOn:plan?.whenOn??null};
  }finally{db.close();}
};
const row=(page:Page,id:string)=>
  page.getByTestId("target-c3b-suggestion-"+id).locator("..");
const openInbox=(page:Page)=>page.goto("/?view=Inbox&scope=personal");
const count=(page:Page)=>page.getByTestId("target-inbox-count");
async function locateRow(page:Page,id:string){
  await expect(count(page)).toBeVisible({timeout:30000});
  const target=page.getByTestId("target-c3b-suggestion-"+id);
  for(let i=0;i<30;i++){
    if(await target.count()){await target.scrollIntoViewIfNeeded();return target;}
    const more=page.getByRole("button",{name:"Načíst další"});
    if(!await more.count())break;
    await more.click();
  }
  await expect(target).toBeVisible({timeout:15000});
  await target.scrollIntoViewIfNeeded();
  return target;
}

test("C-3b: signed rules appear before a delayed optional AI response",async({page})=>{
  test.setTimeout(80_000);
  if(!store)throw Error("C-3b test requires isolated target SQLite");
  const width=Number(process.env.LUMI_TARGET_C3B_VIEWPORT||390);
  await page.setViewportSize({width,height:844});
  const seeded=store.seed.c3bProjects[String(width)];
  // Default-off: merely viewing an Inbox row, and even explicitly asking
  // for an AI alternative before granting consent, must not dispatch "best".
  let unconsentedAIRequests=0;
  page.on("request",request=>{
    const u=new URL(request.url());
    if(u.pathname==="/api/target-staging/inbox/c3b"&&
       u.searchParams.get("mode")!=="rules")unconsentedAIRequests++;
  });
  await openInbox(page);
  const withoutGrant=await locateRow(page,seeded.taskId);
  await expect(withoutGrant.getByRole("button",{name:"Přijmout"}))
    .toBeVisible({timeout:25000});
  expect(unconsentedAIRequests).toBe(0);
  await expect(withoutGrant.getByRole("button",{name:"Získat alternativu AI"}))
    .toHaveCount(0);
  expect(unconsentedAIRequests,
    "the browser must refuse an OpenAI request until durable consent is enabled").toBe(0);
  // The check only authorizes a model request after an explicit Settings
  // grant; no implicit AI dispatch is allowed on scroll or focus.
  await page.goto("/?view=Settings");
  const consent=page.getByTestId("target-c3b-consent-settings");
  const toggle=consent.getByRole("checkbox");
  await expect(toggle).toBeVisible({timeout:25000});
  await expect(consent.getByTestId("target-c3b-receipt-capacity"))
    .toContainText("65536",{timeout:25000});
  if(await toggle.isChecked())await toggle.uncheck();
  await toggle.check();
  await expect.poll(async()=>{
    const r=await page.request.get("/api/target-staging/inbox/c3b/consent");
    return r.ok()&&(await r.json()).enabled===true;
  },{timeout:15000}).toBe(true);
  let releaseAI:()=>void=()=>{};
  const held=new Promise<void>(resolve=>{releaseAI=resolve;});
  let aiStarted=false,aiCompleted=false;
  await page.route("**/api/target-staging/inbox/c3b?*",async route=>{
    const requestUrl=new URL(route.request().url());
    if(requestUrl.searchParams.get("taskId")!==seeded.taskId||
       requestUrl.searchParams.get("mode")==="rules"){
      await route.continue();return;
    }
    aiStarted=true;
    await held;
    await route.continue();
    aiCompleted=true;
  });
  try{
    await openInbox(page);
    const suggestion=await locateRow(page,seeded.taskId);
    await expect(suggestion.getByRole("button",{name:"Přijmout"}))
      .toBeVisible({timeout:25000});
    const visibleAction=await suggestion.locator(".targetInboxSuggestionHeading span")
      .innerText();
    expect(visibleAction).toContain(seeded.projectTitle);
    expect(visibleAction).toMatch(/\d{1,2}\.\s?\d{1,2}\.\s?\d{4}/);
    // No second request is allowed just because a row came into view.
    expect(aiStarted).toBe(false);
    await suggestion.getByRole("button",{name:"Získat alternativu AI"}).click();
    await expect.poll(()=>aiStarted,{timeout:10000}).toBe(true);
    expect(aiCompleted,"a pending AI request must not prevent rule Accept")
      .toBe(false);
    await expect(suggestion.getByRole("button",{name:"Přijmout"})).toBeEnabled();
    expect(await suggestion.locator(".targetInboxSuggestionHeading span")
      .innerText()).toBe(visibleAction);
    releaseAI();
    await expect(suggestion.getByRole("button",{name:"Zobrazit alternativní návrh AI"}))
      .toBeVisible({timeout:25000});
  }finally{releaseAI();}
});


for(const width of [390,1280]){
  test("C-3b real SQLite: explicit AI consent, Today+project+triage Accept/Undo, reload at "+
    width+"px",async({page})=>{
    test.setTimeout(220_000);
    if(process.env.LUMI_TARGET_C3B_VIEWPORT&&
       process.env.LUMI_TARGET_C3B_VIEWPORT!==String(width))test.skip();
    if(!store)throw Error("C-3b test requires an isolated target store");
    await page.setViewportSize({width,height:844});
    const seeded=store.seed.c3bProjects[String(width)];
    const original=readTask(seeded.taskId);
    expect(original.task?.triageState).toBe("unprocessed");
    expect(original.task?.projectId).toBeNull();
    expect(original.whenOn).toBeNull();

    await page.goto("/?view=Settings");
    const consent=page.getByTestId("target-c3b-consent-settings");
    await expect(consent).toBeVisible({timeout:25000});
    const toggle=consent.getByRole("checkbox");
    await expect(toggle).toBeVisible({timeout:15000});
    // The viewport cases share isolated SQLite; never inherit an earlier
    // interrupted run\u0027s owner grant without an explicit revoke.
    if(await toggle.isChecked()){
      await toggle.uncheck();
      await expect(toggle).not.toBeChecked({timeout:15000});
    }
    await toggle.check();
    await expect(toggle).toBeChecked({timeout:15000});
    await expect(toggle).toBeEnabled({timeout:15000});
    await expect.poll(async()=>{
      const r=await page.request.get("/api/target-staging/inbox/c3b/consent");
      return r.ok()&&(await r.json()).enabled===true;
    },{timeout:15000}).toBe(true);
    // The isolated mock OpenAI branch must ACTUALLY be authorized, not just
    // inferred from a visually optimistic checkbox or fallback rules.
    const aiProof=await page.request.get("/api/target-staging/inbox/c3b?taskId="+
      encodeURIComponent(seeded.taskId));
    expect(aiProof.ok()).toBe(true);
    expect((await aiProof.json()).source).toBe("ai");

    await openInbox(page);
    const before=Number((await count(page).textContent())?.trim());
    expect(before).toBeGreaterThan(0);
    const suggestion=await locateRow(page,seeded.taskId);
    await expect(suggestion.getByRole("button",{name:"Proč tento návrh?"}))
      .toBeVisible({timeout:25000});
    // The signed exact destination and actor-local Today must be displayed
    // BEFORE clicking Why or Accept (not hidden behind an explanation).
    const visibleAction=await suggestion.locator(".targetInboxSuggestionHeading span").innerText();
    expect(visibleAction).toContain(seeded.projectTitle);
    expect(visibleAction).toMatch(/\d{1,2}\.\s?\d{1,2}\.\s?\d{4}/);
    await suggestion.getByRole("button",{name:"Proč tento návrh?"}).click();
    await expect(suggestion.locator(".targetInboxSuggestionWhy")).toBeVisible();
    const why=await suggestion.locator(".targetInboxSuggestionWhy").innerText();
    expect(why.length).toBeGreaterThan(8);
    // Rules are immediately available; explicitly request and choose the
    // additional AI version. The Accept POST must use its exact signed token.
    const aiNetwork=page.waitForResponse(r=>r.request().method()==="GET"&&
      new URL(r.url()).pathname==="/api/target-staging/inbox/c3b"&&
      new URL(r.url()).searchParams.get("taskId")===seeded.taskId&&
      new URL(r.url()).searchParams.get("mode")!=="rules");
    await suggestion.getByRole("button",{name:"Získat alternativu AI"}).click();
    const aiReply=await aiNetwork;
    expect(aiReply.status()).toBe(200);
    const aiVersion=await aiReply.json() as {
      source:string;token:string;why:string;changes:unknown;
    };
    expect(aiVersion.source).toBe("ai");
    await expect(suggestion.getByRole("button",{name:"Zobrazit alternativní návrh AI"}))
      .toBeVisible({timeout:25000});
    await suggestion.getByRole("button",{name:"Zobrazit alternativní návrh AI"}).click();
    await expect(suggestion.getByTestId("target-c3b-ai-selected")).toBeVisible();
    const acceptNetwork=page.waitForRequest(r=>r.method()==="POST"&&
      new URL(r.url()).pathname==="/api/target-staging/inbox/c3b/accept");
    await suggestion.getByRole("button",{name:"Přijmout"}).click();
    const submitted=(await acceptNetwork).postDataJSON() as {
      command:{token:string;displayedWhy:string;displayedChanges:unknown};
    };
    expect(submitted.command.token).toBe(aiVersion.token);
    expect(submitted.command.displayedWhy).toBe(aiVersion.why);
    expect(submitted.command.displayedChanges).toEqual(aiVersion.changes);

    await expect(page.getByTestId("target-c3b-committed")).toBeVisible({
      timeout:25000});
    await expect(page.getByTestId("target-c3b-suggestion-"+seeded.taskId))
      .toHaveCount(0);
    await expect.poll(()=>readTask(seeded.taskId).task?.triageState)
      .toBe("processed");
    const accepted=readTask(seeded.taskId);
    expect(accepted.task?.projectId).toBe(seeded.projectId);
    expect(accepted.task?.areaId).toBeNull();
    const parts=new Intl.DateTimeFormat("en-GB",{
      timeZone:"Europe/Prague",year:"numeric",month:"2-digit",day:"2-digit",
    }).formatToParts(new Date());
    const field=(name:string)=>parts.find(p=>p.type===name)?.value;
    const date=field("year")+"-"+field("month")+"-"+field("day");
    expect(accepted.whenOn).toBe(date);
    await expect.poll(async()=>Number((await count(page).textContent())?.trim()))
      .toBe(before-1);

    await page.getByTestId("target-c3b-committed")
      .getByRole("button",{name:"Vrátit změny (Undo)"}).click();
    await expect.poll(()=>readTask(seeded.taskId).task?.triageState)
      .toBe("unprocessed");
    const undone=readTask(seeded.taskId);
    expect(undone.task?.projectId).toBeNull();
    expect(undone.task?.areaId).toBe(original.task?.areaId);
    expect(undone.whenOn).toBeNull();
    await expect.poll(async()=>Number((await count(page).textContent())?.trim()))
      .toBe(before);

    await page.reload();
    await locateRow(page,seeded.taskId);
    // No scrolling across the 390px viewport and existing bottom tabs intact.
    const overflow=await page.evaluate(()=>document.documentElement.scrollWidth-
      document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    if(width===390)
      await expect(page.locator('[data-nav-view="More"]').first()).toBeVisible();

    // Real Quick Capture still creates an ordinary private Inbox task.
    const fab=page.locator('[data-target-private-capture-fab="'+
      (width===390?"mobile":"desktop")+'"]');
    await fab.click();
    await page.getByTestId("target-capture-task-kind").click();
    await page.getByTestId("target-private-task-area").selectOption({
      label:store.seed.createAreaTitle,
    });
    const title="Dnes připravit "+seeded.projectTitle+" "+randomUUID().slice(0,8);
    await page.getByTestId("target-private-task-form")
      .getByRole("textbox",{name:"Název úkolu"}).fill(title);
    const created=page.waitForResponse(r=>r.request().method()==="POST"&&
      new URL(r.url()).pathname==="/api/target-staging/tasks");
    await page.getByTestId("target-private-task-save").click();
    const confirmation=await created;
    expect(confirmation.status()).toBe(201);
    const taskId=(confirmation.request().postDataJSON() as {taskId:string}).taskId;
    const captured=await locateRow(page,taskId);
    await expect(captured.getByRole("button",{name:"Proč tento návrh?"}))
      .toBeVisible({timeout:25000});
    await captured.getByRole("button",{name:"Přijmout"}).click();
    await expect.poll(()=>readTask(taskId).task?.triageState).toBe("processed");
    expect(readTask(taskId).task?.projectId).toBe(seeded.projectId);
    await expect(page.getByTestId("target-c3b-committed"))
      .toBeVisible({timeout:25000});
    // P1: an intervening edit must make Undo fail its CAS, but its ORIGINAL
    // UUID must be terminally fenced so Inbox never remains stuck/hidden.
    const changedTitle="Novější zadání "+randomUUID().slice(0,8);
    const edited=new DatabaseSync(path.join(store.directory,"lumi-target.sqlite"));
    try{
      edited.prepare("UPDATE tasks SET title=? WHERE id=?")
        .run(changedTitle,taskId);
    }finally{edited.close();}
    await page.getByTestId("target-c3b-committed")
      .getByRole("button",{name:"Vrátit změny (Undo)"}).click();
    await expect(page.getByTestId("target-c3b-undo-cancelled"))
      .toBeVisible({timeout:30000});
    expect(readTask(taskId).task?.triageState).toBe("processed");
    const verified=new DatabaseSync(path.join(store.directory,"lumi-target.sqlite"),{readOnly:true});
    try{
      expect(verified.prepare("SELECT title FROM tasks WHERE id=?")
        .get(taskId)?.title).toBe(changedTitle);
    }finally{verified.close();}
    await expect(count(page)).toBeVisible();
    await page.reload();
    await expect(count(page)).toBeVisible();
    // No model outputs/notes are persisted in the local browser session.
    const contents=await page.evaluate(()=>JSON.stringify({...sessionStorage}));
    expect(contents).not.toContain(seeded.taskTitle);
    expect(contents).not.toContain(why);
    // Tests share one isolated SQLite store. Explicitly revoke after each
    // viewport so 1280 also exercises a NEW explicit grant after revocation,
    // never inherits the 390 consent or silently skips the Settings action.
    await page.goto("/?view=Settings");
    const revokeToggle=page.getByTestId("target-c3b-consent-settings")
      .getByRole("checkbox");
    try{
      await expect(revokeToggle).toBeChecked({timeout:7000});
    }catch{
      // A temporary 503 is not evidence of a revoked grant. The Settings
      // control must allow an explicit fresh durable consent re-read.
      await page.getByTestId("target-c3b-consent-settings")
        .getByRole("button",{name:"Ověřit aktuální souhlas"}).click();
      await expect(revokeToggle).toBeChecked({timeout:20000});
    }
    await revokeToggle.uncheck();
    await expect(revokeToggle).not.toBeChecked({timeout:15000});
    await expect(revokeToggle).toBeEnabled({timeout:15000});
    await expect.poll(async()=>{
      const r=await page.request.get("/api/target-staging/inbox/c3b/consent");
      return r.ok()&&(await r.json()).enabled===false;
    },{timeout:15000}).toBe(true);
    if(width===1280){
      await page.goto("/?view=Settings");
      // C-3b is isolated target SQLite, not legacy browser sync. Readiness
      // means the actual Settings UI is mounted, not a legacy storage bit.
      await expect(page.getByRole("navigation",{name:"Sekce nastavení"}))
        .toBeVisible({timeout:25000});
      await settingsSections(page).filter({hasText:"Přístup"}).click();
      await page.getByRole("button",{name:"Odhlásit se"}).click();
      await expect(page.locator(".authCard")).toBeVisible();
      // Every Inbox and consent route must hide actor-private content and
      // must never infer an owner from a revoked browser session.
      const statuses=await page.evaluate(async()=>{
        const urls=[
          "/api/target-staging/inbox/c3b?taskId=0-c3b:390",
          "/api/target-staging/inbox/c3b/consent",
        ];
        return Promise.all(urls.map(u=>fetch(u,{cache:"no-store"})
          .then(r=>r.status)));
      });
      expect(statuses).toEqual([401,401]);
      await page.goto("/?view=Inbox&scope=personal");
      await expect(count(page)).toHaveCount(0);
      await expect(page.locator(".targetInboxRow")).toHaveCount(0);
    }
  });
}


test("C-3b 390px: lost response -> reload -> query-only cancellation terminates UUID",async({page})=>{
  test.setTimeout(120_000);
  if(process.env.LUMI_TARGET_C3B_VIEWPORT==="1280")test.skip();
  if(!store)throw Error("C-3b needs isolated store");
  await page.setViewportSize({width:390,height:844});
  await openInbox(page);
  const task=store.seed.c3bProjects["390"];
  const suggestion=await locateRow(page,task.taskId);
  await expect(suggestion.getByRole("button",{name:"Přijmout"}))
    .toBeVisible({timeout:25000});
  // Reject transport BEFORE it reaches the target store, producing a
  // never-recorded original UUID that intentionally loses its signed body.
  await page.route("**/api/target-staging/inbox/c3b/accept",
    route=>route.abort("failed"));
  await suggestion.getByRole("button",{name:"Přijmout"}).click();
  await expect(page.getByTestId("target-c3b-uncertain"))
    .toBeVisible({timeout:25000});
  await page.reload();
  await expect(page.getByTestId("target-c3b-uncertain"))
    .toBeVisible({timeout:25000});
  const cancelling=page.waitForResponse(r=>r.request().method()==="POST"&&
    new URL(r.url()).pathname==="/api/target-staging/inbox/c3b/cancel");
  await page.getByRole("button",{name:"Bezpečně ukončit původní Přijmout"})
    .click();
  const cancellation=await cancelling;
  const reply=await cancellation.json();
  expect(cancellation.status(),JSON.stringify(reply)).toBe(200);
  expect(reply).toMatchObject({ok:true,status:"cancelled"});
  await expect(page.getByTestId("target-c3b-uncertain"))
    .toHaveCount(0,{timeout:25000});
  await page.unroute("**/api/target-staging/inbox/c3b/accept");
  await locateRow(page,task.taskId);
  expect(readTask(task.taskId).task?.triageState).toBe("unprocessed");
});
