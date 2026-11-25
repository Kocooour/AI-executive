/** C-3a real isolated target SQLite acceptance, never a production store.
 * Explicitly enabled by LUMI_TARGET_INBOX_E2E=true. The installed browser
 * drives actual Next HTTP/actor-scoped read, Process, receipt and Undo routes.
 * All page fixtures come from the canonical personal-store bootstrap. */
import {test,expect} from "./fixtures";
import {randomUUID} from "node:crypto";
import {execFileSync} from "node:child_process";
import {DatabaseSync} from "node:sqlite";
import path from "node:path";
import type {Page,Route} from "@playwright/test";

test.skip(process.env.LUMI_TARGET_INBOX_E2E!=="true",
  "C-3a real-store Inbox acceptance is opt-in");
const store=JSON.parse(process.env.LUMI_E2E_TARGET_STORE||"null") as {
  directory:string;restoreGeneration:string;ownerUserId:string;
  seed:{areaId:string;createAreaId:string;areaTitle:string;
    projects:Record<string,{projectId:string;taskId:string;taskTitle:string}>;
    searchProjects:Record<string,{projectId:string;taskId:string;taskTitle:string}>};
}|null;
const inbox=(page:Page)=>page.getByTestId("target-inbox");
const count=(page:Page)=>page.getByTestId("target-inbox-count");
const row=(page:Page,id:string)=>page.locator('.targetInboxRow').filter({
  has:page.locator('[data-detail-row="task:'+id+'"]'),
});
const processAction=(page:Page,title:string)=>
  page.getByRole("button",{name:"Zpracovat úkol: "+title});
const openInbox=(page:Page)=>page.goto("/?view=Inbox&scope=personal");
const opaqueCount=async(page:Page)=>Number((await count(page).textContent())?.trim());
/** Inbox keyset paging may put any ID beyond the first 50 rows.
 * Never weaken the assertion by assuming a record is on page one. */
async function findInboxRow(page:Page,id:string){
  const target=row(page,id);
  // Isolated SQLite read children may transiently return 503 during back/
  // reload; never show cached titles. The user-visible Retry runs a FRESH
  // session verification before another authorized read.
  const retry=page.getByRole("button",{name:"Zkusit znovu"});
  for(let attempt=0;attempt<5;attempt++){
    if(await count(page).isVisible())break;
    await expect.poll(async()=>await count(page).isVisible()||
      await retry.isVisible(),{timeout:10000}).toBe(true);
    if(await count(page).isVisible())break;
    // After a wake/session refresh, Retry may disappear between the visibility
    // probe and the click because a new authorized GET starts. Do not spend the
    // entire 180s scenario timeout waiting for a button that no longer exists.
    // The final count/row assertions still require real authorized content.
    if(await retry.isVisible()){
      try{await retry.click({timeout:2500});}
      catch{/* transient remount; re-check count or retry on the next attempt */}
    }
  }
  await expect(count(page)).toBeVisible({timeout:15000});
  for(let step=0;step<25;step++){
    if(await target.count()){
      await expect(target).toBeVisible();return target;
    }
    const more=inbox(page).getByRole("button",{name:"Načíst další"});
    if(await more.count()===0)break;
    const before=await page.locator(".targetInboxRow").count();
    await more.click();
    await expect.poll(()=>page.locator(".targetInboxRow").count(),
      {timeout:15000}).toBeGreaterThan(before);
  }
  await expect(target).toBeVisible();
  return target;
}

for(const width of [390,1280]){
  test("C-3a: real Process/receipt/Undo + detail URL, Back/Forward, Quick Capture at "+width+"px",
  async({page})=>{
    test.setTimeout(180_000);
    if(!store)throw Error("Missing isolated C-3a SQLite store");
    await page.setViewportSize({width,height:844});
    const seeded=store.seed.projects[String(width)];
    await openInbox(page);
    await expect(count(page)).toBeVisible();
    await findInboxRow(page,seeded.taskId);
    const before=await opaqueCount(page);
    expect(before).toBeGreaterThan(0);

    // A task in a project still opens with the Inbox *origin*, not an
    // invented project-parent route. Reload/Back/Forward remain typed.
    await row(page,seeded.taskId).getByRole("button",{
      name:"Otevřít úkol: "+seeded.taskTitle,
    }).click();
    await expect(page).toHaveURL(new RegExp("view=Inbox&taskId="+encodeURIComponent(seeded.taskId)));
    await expect(page.getByTestId("target-detail")).toContainText(seeded.taskTitle,{timeout:25_000});
    await page.goBack();
    await findInboxRow(page,seeded.taskId);
    await page.goForward();
    await expect(page.getByTestId("target-detail")).toContainText(seeded.taskTitle,{timeout:25_000});
    await page.reload();
    await expect(page.getByTestId("target-detail")).toContainText(seeded.taskTitle,{timeout:25_000});
    await page.getByTestId("target-detail").locator("button.inspectorClose").click();
    await expect(page.getByTestId("target-detail")).toHaveCount(0);
    // Reload/Back/Forward return to the first 50-row page. Find the seeded
    // task again before attempting Process on a later keyset page.
    await findInboxRow(page,seeded.taskId);

    // Process changes triage only; the existing task disappears from the
    // authorized count, Undo is linked to the *receipt-confirmed* Process.
    await processAction(page,seeded.taskTitle).click();
    await expect(row(page,seeded.taskId)).toHaveCount(0);
    await expect.poll(()=>opaqueCount(page)).toBe(before-1);
    await page.getByRole("button",{name:"Vrátit do Inboxu (Undo)"}).click();
    await findInboxRow(page,seeded.taskId);
    await expect.poll(()=>opaqueCount(page)).toBe(before);
    await page.reload();
    await findInboxRow(page,seeded.taskId);

    // The global Quick Capture writes an actual target task, which enters
    // Inbox regardless of its plan/When. No legacy local-task fallback.
    const fab=page.locator('[data-target-private-capture-fab="'+
      (width===390?"mobile":"desktop")+'"]');
    await fab.click();
    await page.getByTestId("target-capture-task-kind").click();
    await page.getByTestId("target-private-task-area").selectOption({
      label:store.seed.areaTitle,
    });
    const title="C-3a captured "+width+" "+randomUUID().slice(0,8);
    await page.getByTestId("target-private-task-form")
      .getByRole("textbox",{name:"Název úkolu"}).fill(title);
    const created=page.waitForResponse(r=>r.request().method()==="POST"&&
      new URL(r.url()).pathname==="/api/target-staging/tasks");
    await page.getByTestId("target-private-task-save").click();
    const confirmation=await created;
    expect(confirmation.status()).toBe(201);
    const taskId=(confirmation.request().postDataJSON() as {taskId:string}).taskId;
    expect(taskId).toMatch(/^[0-9a-f-]{36}$/);
    // Keep the same Inbox component mounted: a confirmed CREATE must
    // invalidate it without navigation, while the count remains actor-scoped.
    await expect.poll(()=>opaqueCount(page),{timeout:15000}).toBe(before+1);
    await expect(await findInboxRow(page,taskId)).toContainText(title);
  });
}

test("C-3a: uncertain write never resends its UUID and hides both row and navigation count",
async({page})=>{
  test.setTimeout(90_000);
  if(!store)throw Error("Missing isolated C-3a SQLite store");
  await page.setViewportSize({width:390,height:844});
  const seeded=store.seed.projects["390"],title=seeded.taskTitle;
  await openInbox(page);
  await findInboxRow(page,seeded.taskId);
  await expect(processAction(page,title)).toBeVisible();
  let commands=0,receipts=0;
  const abortWrite=async(route:Route)=>{
    commands++;
    await route.fulfill({status:503,contentType:"application/json",
      headers:{"cache-control":"no-store"},body:'{"error":"uncertain"}'});
  };
  await page.route("**/api/target-staging/inbox/triage",abortWrite);
  await page.route("**/api/target-staging/inbox/receipt",async route=>{
    receipts++;await route.continue();
  });
  await processAction(page,title).click();
  await expect(page.getByTestId("target-inbox-uncertain")).toBeVisible();
  await expect(count(page)).toHaveCount(0);
  await expect(page.getByTestId("target-inbox-sidebar-count")).toHaveCount(0);
  await page.getByRole("button",{name:"Ověřit původní příkaz"}).click();
  await expect(page.getByTestId("target-inbox-uncertain")).toBeVisible();

  // Switching shell views unmounts TargetInbox. Its original UUID must
  // survive this route remount, without offering a fresh Process.
  await page.locator('[data-nav-view="More"]').first().click();
  await page.locator('[data-testid="target-more-primary"] [data-nav-view="Home"]').click();
  await expect(page.getByTestId("target-inbox-uncertain")).toHaveCount(0);
  await page.locator('[data-nav-view="More"]').first().click();
  await page.locator('[data-testid="target-more-primary"] [data-nav-view="Inbox"]').click();
  await expect(page.getByTestId("target-inbox-uncertain")).toBeVisible();
  await expect(processAction(page,title)).toHaveCount(0);
  await expect(count(page)).toHaveCount(0);
  await page.getByRole("button",{name:"Ověřit původní příkaz"}).click();
  await expect(page.getByTestId("target-inbox-uncertain")).toBeVisible();
  expect(commands).toBe(1);
  await expect.poll(()=>receipts,{timeout:15000}).toBeGreaterThanOrEqual(3);
  await page.unroute("**/api/target-staging/inbox/triage",abortWrite);
  const saved=await page.evaluate(()=>sessionStorage.getItem("lumi:target-inbox-command:v1"));
  expect(saved).toContain("commandId");
  expect(saved).not.toContain(title);
  await page.reload();
  // A reload must NOT turn an ambiguous original command into a fresh UUID.
  await expect(page.getByTestId("target-inbox-uncertain")).toBeVisible();
  await expect(processAction(page,title)).toHaveCount(0);
  await page.getByRole("button",{name:"Ověřit původní příkaz"}).click();
  await expect(page.getByTestId("target-inbox-uncertain")).toBeVisible();
  expect(commands).toBe(1);
});

for(const width of [390,1280]){
  test("C-3a: passive session 503 hides Inbox and navigation badge at same generation ("+width+"px)",
  async({page})=>{
    test.setTimeout(90_000);
    if(!store)throw Error("Missing isolated C-3a SQLite store");
    await page.setViewportSize({width,height:844});
    await openInbox(page);
    await expect(count(page)).toBeVisible();
    await expect(page.locator(".targetInboxRow").first()).toBeVisible();
    const knownCount=await opaqueCount(page);

    // The runtime keeps the same known generation after a passive 503.
    // UI readers must nevertheless fail closed; a late GET must not restore data.
    let releaseLateGet:()=>void=()=>{};
    let startedLateGet:()=>void=()=>{};
    const lateGetStarted=new Promise<void>(resolve=>{startedLateGet=resolve;});
    let held=false;
    const delayedGet=async(route:Route)=>{
      if(held){await route.continue();return;}
      held=true;
      await new Promise<void>(resolve=>{releaseLateGet=resolve;startedLateGet();});
      try{await route.continue();}catch{/* request may be aborted after a refusal */}
    };
    await page.route("**/api/target-staging/inbox?*",delayedGet);
    // Simulate a connectivity wake: its session verification must precede
    // the next Inbox GET. A plain focus does not force a non-hidden wake.
    await page.evaluate(()=>{
      window.dispatchEvent(new Event("offline"));
      window.dispatchEvent(new Event("online"));
    });
    await lateGetStarted;

    let failures=0;
    const failSession=async(route:Route)=>{
      failures++;
      await route.fulfill({status:503,contentType:"application/json",
        headers:{"cache-control":"no-store"},body:'{"error":"unavailable"}'});
    };
    await page.route("**/api/target-staging/session",failSession);
    await page.evaluate(()=>window.dispatchEvent(new Event("online")));
    await expect.poll(()=>failures,{timeout:15000}).toBeGreaterThan(0);
    await expect(count(page)).toHaveCount(0);
    await expect(page.locator(".targetInboxRow")).toHaveCount(0);
    await expect(page.getByTestId("target-inbox-sidebar-count")).toHaveCount(0);
    if(width===390){
      await page.locator('[data-nav-view="More"]').first().click();
      await expect(page.locator('[data-testid="target-more-primary"] [data-nav-view="Inbox"]'))
        .toBeVisible();
      await expect(page.getByTestId("target-inbox-sidebar-count")).toHaveCount(0);
      // The backdrop covers the bottom tab while the menu is open.
      await page.locator(".mobileMoreClose").click();
    }
    releaseLateGet();
    await expect(count(page)).toHaveCount(0);
    await page.unroute("**/api/target-staging/session",failSession);
    await page.unroute("**/api/target-staging/inbox?*",delayedGet);
    await page.evaluate(()=>window.dispatchEvent(new Event("online")));
    await expect.poll(()=>opaqueCount(page),{timeout:15000}).toBe(knownCount);
    await expect(page.locator(".targetInboxRow").first()).toBeVisible();
  });
}


// A successful limit=1 GET may have already mounted the navigation badge
// while the main Inbox (limit=50) has not been opened. ANY failed first-page
// response, including transient 503 and rate-limit 429, must suppress that
// independently cached count until a new verified session and authorized GET.
for(const width of [390,1280]){
  for(const status of [409,404,503,429]){
    test("C-3a: first-page "+status+" hides already-visible navigation count ("+
      width+"px)",async({page})=>{
      test.setTimeout(90_000);
      if(!store)throw Error("Missing isolated C-3a SQLite store");
      await page.setViewportSize({width,height:844});
      await page.goto("/?view=Home&scope=personal");
      if(width===390){
        await page.locator('[data-nav-view="More"]').first().click();
        await expect(page.locator(
          '[data-testid="target-more-primary"] [data-testid="target-inbox-sidebar-count"]',
        )).toBeVisible({timeout:15000});
      }else await expect(page.locator(
        'aside [data-testid="target-inbox-sidebar-count"]',
      )).toBeVisible({timeout:15000});

      let refused=0;
      const firstPageRefusal=async(route:Route)=>{
        const params=new URL(route.request().url()).searchParams;
        if(params.get("limit")==="50"&&!params.has("cursor")){
          refused++;
          await route.fulfill({status,contentType:"application/json",
            headers:{"cache-control":"no-store"},
            body:JSON.stringify({error:status===409?"read_stale_reload":
              status===404?"Not found":status===429?"Too many requests":
              "Staging unavailable"})});
        }else await route.continue(); // badge had a successful authorized GET
      };
      await page.route("**/api/target-staging/inbox?*",firstPageRefusal);
      if(width===390){
        await page.locator(
          '[data-testid="target-more-primary"] [data-nav-view="Inbox"]',
        ).click();
      }else await page.locator('aside [data-nav-view="Inbox"]').click();
      await expect.poll(()=>refused,{timeout:15000}).toBeGreaterThan(0);
      await expect(count(page)).toHaveCount(0);
      await expect(page.locator(".targetInboxRow")).toHaveCount(0);
      await expect(page.getByRole("button",{name:"Zkusit znovu"})).toBeVisible();
      if(width===390){
        await page.locator('[data-nav-view="More"]').first().click();
        await expect(page.getByTestId("target-inbox-sidebar-count")).toHaveCount(0);
        await page.locator(".mobileMoreClose").click();
      }else await expect(page.getByTestId("target-inbox-sidebar-count")).toHaveCount(0);

      // A fresh session verification and a new authorized first-page GET
      // restore both the list and badge, never the pre-refusal count cache.
      await page.unroute("**/api/target-staging/inbox?*",firstPageRefusal);
      await page.getByRole("button",{name:"Zkusit znovu"}).click();
      await expect(count(page)).toBeVisible({timeout:15000});
      if(width===390){
        await page.locator('[data-nav-view="More"]').first().click();
        await expect(page.locator(
          '[data-testid="target-more-primary"] [data-testid="target-inbox-sidebar-count"]',
        )).toBeVisible({timeout:15000});
        await page.locator(".mobileMoreClose").click();
      }else await expect(page.getByTestId(
        "target-inbox-sidebar-count",
      )).toBeVisible({timeout:15000});
    });
  }
}

for(const width of [390,1280]){
  test("C-3a: paging refusal hides both Inbox and navigation count ("+width+"px)",
  async({page})=>{
    test.setTimeout(90_000);
    if(!store)throw Error("Missing isolated C-3a SQLite store");
    await page.setViewportSize({width,height:844});
    await openInbox(page);
    await expect(count(page)).toBeVisible();
    await expect(inbox(page).getByRole("button",{name:"Načíst další"})).toBeVisible();
    if(width===390){
      await page.locator('[data-nav-view="More"]').first().click();
      await expect(page.locator('[data-testid="target-more-primary"] [data-testid="target-inbox-sidebar-count"]'))
        .toBeVisible();
      await page.locator(".mobileMoreClose").click();
    }else await expect(page.getByTestId("target-inbox-sidebar-count")).toBeVisible();

    // Keep revalidation failing after a simulated revoked cursor response,
    // proving an old sidebar/mobile badge does NOT survive this boundary.
    const failSession=async(route:Route)=>{
      await route.fulfill({status:503,contentType:"application/json",
        headers:{"cache-control":"no-store"},body:'{"error":"unavailable"}'});
    };
    const status=width===390?403:409;
    const failPage=async(route:Route)=>{
      if(!new URL(route.request().url()).searchParams.has("cursor")){
        await route.continue();return;
      }
      await route.fulfill({status,contentType:"application/json",
        headers:{"cache-control":"no-store"},body:'{"error":"stale"}'});
    };
    await page.route("**/api/target-staging/session",failSession);
    await page.route("**/api/target-staging/inbox?*",failPage);
    await inbox(page).getByRole("button",{name:"Načíst další"}).click();
    await expect(count(page)).toHaveCount(0);
    await expect(page.locator(".targetInboxRow")).toHaveCount(0);
    if(width===390){
      await page.locator('[data-nav-view="More"]').first().click();
      await expect(page.getByTestId("target-inbox-sidebar-count")).toHaveCount(0);
      await page.locator(".mobileMoreClose").click();
    }else await expect(page.getByTestId("target-inbox-sidebar-count")).toHaveCount(0);
    await page.unroute("**/api/target-staging/session",failSession);
    await page.unroute("**/api/target-staging/inbox?*",failPage);
    await page.evaluate(()=>window.dispatchEvent(new Event("online")));
    await expect(count(page)).toBeVisible({timeout:15000});
  });
}


test("C-3a: lost Process + concurrent title edit cancels old UUID and unlocks fresh CAS",async({page})=>{
  test.setTimeout(115_000);
  if(!store)throw Error("Missing isolated C-3a SQLite store");
  await page.setViewportSize({width:1280,height:844});
  const seeded=store.seed.projects["390"];
  const db=new DatabaseSync(path.join(store.directory,"lumi-target.sqlite"));
  db.exec("PRAGMA busy_timeout=5000");
  const originalTitle=(db.prepare("SELECT title FROM tasks WHERE id=?")
    .get(seeded.taskId) as {title:string}).title;
  const receiptsBefore=(db.prepare("SELECT COUNT(*) AS n FROM task_triage_receipts WHERE task_id=?")
    .get(seeded.taskId) as {n:number}).n;
  let changed=false;
  try{
    await openInbox(page);
    await findInboxRow(page,seeded.taskId);
    const commands:unknown[]=[];
    const dropFirst=async(route:Route)=>{
      commands.push(route.request().postDataJSON());
      if(commands.length===1)await route.fulfill({status:503,contentType:"application/json",
        body:'{"error":"unavailable"}'});
      else await route.continue();
    };
    await page.route("**/api/target-staging/inbox/triage",dropFirst);
    // A C-3b preview/consent child can briefly occupy capacity while the
    // C-3a Process response is lost. The ORIGINAL receipt must be retried
    // read-only; never retry Process or invent another actor-bound UUID.
    let receiptReads=0;
    const transientReceipt=async(route:Route)=>{
      receiptReads++;
      if(receiptReads===1)await route.fulfill({status:503,contentType:"application/json",
        body:'{"error":"Staging unavailable"}'});
      else await route.continue();
    };
    await page.route("**/api/target-staging/inbox/receipt",transientReceipt);
    await processAction(page,seeded.taskTitle).click();
    await expect(page.getByRole("button",{name:"Opakovat původní příkaz"}))
      .toBeVisible({timeout:15000});
    expect(receiptReads).toBeGreaterThanOrEqual(2);
    const witness=(await page.evaluate(()=>
      sessionStorage.getItem("lumi:target-inbox-command:v1")))!;
    const original=JSON.parse(witness) as {command:{commandId:string;taskId:string}};
    expect(original.command.taskId).toBe(seeded.taskId);
    const freshTitle="Concurrent C-3a title edit";
    db.prepare("UPDATE tasks SET title=? WHERE id=?").run(freshTitle,seeded.taskId);
    changed=true;

    // Exact same-UUID replay rejects stale CAS. A pinned read verifies no
    // committed receipt and that the monotonic CAS can never match again:
    // the browser can retire it without any permanent negative UUID row.
    await page.getByRole("button",{name:"Opakovat původní příkaz"}).click();
    expect(commands).toHaveLength(2);
    expect(commands[1]).toEqual(commands[0]);
    await expect.poll(async()=>await page.evaluate(()=>
      sessionStorage.getItem("lumi:target-inbox-command:v1")),
      {timeout:20000}).toBeNull();
    const fenced=(db.prepare("SELECT COUNT(*) AS n FROM metadata WHERE key LIKE ?")
      .get("r3:inbox-triage-cancel-v1:%") as {n:number}).n;
    expect(fenced).toBe(0); // No permanent actor+UUID ledger after stale-CAS recovery.
    const receipts=(db.prepare("SELECT COUNT(*) AS n FROM task_triage_receipts WHERE task_id=?")
      .get(seeded.taskId) as {n:number}).n;
    expect(receipts).toBe(receiptsBefore); // old UUID added no Process receipt

    // Simulate delivery of the original command AFTER cancellation. The
    // server must reject it; it cannot commit or duplicate the Process.
    await page.unroute("**/api/target-staging/inbox/triage",dropFirst);
    const lateStatus=await page.evaluate(async command=>{
      const response=await fetch("/api/target-staging/inbox/triage",{
        method:"POST",headers:{"content-type":"application/json",
          "x-lumi-target-protocol":"1"},
        body:JSON.stringify(command),credentials:"same-origin"});
      return response.status;
    },original.command);
    expect(lateStatus).toBe(409);
    const close=page.getByRole("button",{name:"Zavřít a obnovit"});
    if(await close.isVisible())await close.click();
    await findInboxRow(page,seeded.taskId);
    await expect(row(page,seeded.taskId)).toContainText(freshTitle,{timeout:15000});
    await processAction(page,freshTitle).click();
    await expect(page.getByRole("button",{name:"Vrátit do Inboxu (Undo)"}))
      .toBeVisible({timeout:15000});
    await page.getByRole("button",{name:"Vrátit do Inboxu (Undo)"}).click();
    await findInboxRow(page,seeded.taskId);
  }finally{
    await page.unroute("**/api/target-staging/inbox/receipt");
    if(changed)db.prepare("UPDATE tasks SET title=? WHERE id=?")
      .run(originalTitle,seeded.taskId);
    db.close();
  }
});

for(const [width,status] of [[390,503],[1280,409]] as const){
  test("C-3a: delayed page-2 "+status+" preserves pending original UUID ("+
    width+"px)",async({page})=>{
    test.setTimeout(100_000);
    if(!store)throw Error("Missing isolated C-3a SQLite store");
    await page.setViewportSize({width,height:844});
    await openInbox(page);
    await expect(count(page)).toBeVisible({timeout:15000});
    // Operate on a FIRST-page row so that the page-2 cursor still exists.
    // Seeded tasks can sort onto page two; findInboxRow would consume it.
    await expect(page.locator(".targetInboxRow").first()).toBeVisible();
    await expect(inbox(page).getByRole("button",{name:"Načíst další"})).toBeVisible();
    let begin:()=>void=()=>{},release:()=>void=()=>{};
    const started=new Promise<void>(resolve=>{begin=resolve;});
    const held=new Promise<void>(resolve=>{release=resolve;});
    const delayedPage=async(route:Route)=>{
      if(!new URL(route.request().url()).searchParams.has("cursor")){
        await route.continue();return;
      }
      begin();await held;
      try{await route.fulfill({status,contentType:"application/json",
        body:JSON.stringify({error:status===409?"read_stale_reload":"unavailable"})});}
      catch{/* session may abort the old GET before it is fulfilled */}
    };
    let commands=0;
    const dropPost=async(route:Route)=>{
      commands++;
      await route.fulfill({status:503,contentType:"application/json",
        body:'{"error":"unavailable"}'});
    };
    await page.route("**/api/target-staging/inbox?*",delayedPage);
    await page.route("**/api/target-staging/inbox/triage",dropPost);
    await inbox(page).getByRole("button",{name:"Načíst další"}).click();
    await started;
    await page.locator(".targetInboxRow").first()
      .getByRole("button",{name:/Zpracovat úkol:/}).click();
    await expect(page.getByRole("button",{name:"Opakovat původní příkaz"}))
      .toBeVisible({timeout:15000});
    const witness=(await page.evaluate(()=>
      sessionStorage.getItem("lumi:target-inbox-command:v1")))!;
    const original=JSON.parse(witness) as {command:{commandId:string}};
    release();
    await expect(count(page)).toHaveCount(0);
    await expect(page.getByTestId("target-inbox-sidebar-count")).toHaveCount(0);
    await expect(page.getByTestId("target-inbox-uncertain")).toBeVisible();
    expect(commands).toBe(1);
    expect((await page.evaluate(()=>
      sessionStorage.getItem("lumi:target-inbox-command:v1")))).toContain(
        original.command.commandId);

    // A reload must restore that exact command, not silently offer a fresh
    // Process. Resolve only through the pinned cancellation lock.
    await page.unroute("**/api/target-staging/inbox?*",delayedPage);
    await page.reload();
    await expect(page.getByTestId("target-inbox-uncertain")).toBeVisible();
    await expect(page.locator(".targetInboxRow")).toHaveCount(0);
    await page.getByRole("button",{name:"Bezpečně ukončit původní příkaz"}).click();
    await expect.poll(async()=>await page.evaluate(()=>
      sessionStorage.getItem("lumi:target-inbox-command:v1")),
      {timeout:15000}).toBeNull();
    expect(commands).toBe(1);
    await page.unroute("**/api/target-staging/inbox/triage",dropPost);
  });
}


test("C-3a: lost Undo can be cancelled and safely replaced without replaying its UUID",async({page})=>{
  test.setTimeout(120_000);
  if(!store)throw Error("Missing isolated C-3a SQLite store");
  await page.setViewportSize({width:1280,height:844});
  const seeded=store.seed.projects["1280"];
  const db=new DatabaseSync(path.join(store.directory,"lumi-target.sqlite"));
  const writes:unknown[]=[];
  const dropFirstUndo=async(route:Route)=>{
    const command=route.request().postDataJSON() as {mode:string;commandId:string};
    if(command.mode==="undo"){
      writes.push(command);
      if(writes.length===1){
        await route.fulfill({status:503,contentType:"application/json",
          body:'{"error":"unavailable"}'});
        return;
      }
    }
    await route.continue();
  };
  try{
    await openInbox(page);
    await findInboxRow(page,seeded.taskId);
    await processAction(page,seeded.taskTitle).click();
    await expect(page.getByRole("button",{name:"Vrátit do Inboxu (Undo)"}))
      .toBeVisible({timeout:20000});
    await page.route("**/api/target-staging/inbox/triage",dropFirstUndo);
    await page.getByRole("button",{name:"Vrátit do Inboxu (Undo)"}).click();
    await expect(page.getByRole("button",{name:"Bezpečně ukončit původní příkaz"}))
      .toBeVisible({timeout:20000});
    expect(writes).toHaveLength(1);
    await page.getByRole("button",{name:"Bezpečně ukončit původní příkaz"}).click();
    await expect(page.getByText(
      "Původní Undo bylo bezpečně zrušeno. Úkol lze nyní znovu vrátit do Inboxu."
    )).toBeVisible({timeout:20000});
    await expect(page.getByRole("button",{name:"Vrátit do Inboxu (Undo)"}))
      .toBeVisible();
    // Reload cannot discard the recovery of a cancelled pending Undo.
    // Only the old actor-issued command is persisted and reverified.
    await page.reload();
    await expect(page.getByTestId("target-inbox-uncertain"))
      .toBeVisible({timeout:20000});
    await page.getByRole("button",{name:"Ověřit původní příkaz"}).click();
    await expect(page.getByRole("button",{name:"Vrátit do Inboxu (Undo)"}))
      .toBeVisible({timeout:20000});
    const oldUndo=writes[0];
    await page.unroute("**/api/target-staging/inbox/triage",dropFirstUndo);
    const late=await page.evaluate(async command=>{
      const response=await fetch("/api/target-staging/inbox/triage",{
        method:"POST",headers:{"content-type":"application/json",
          "x-lumi-target-protocol":"1"},credentials:"same-origin",
        body:JSON.stringify(command)});
      return response.status;
    },oldUndo);
    expect(late).toBe(409); // Old Undo UUID remains irrevocably retired.
    await page.getByRole("button",{name:"Vrátit do Inboxu (Undo)"}).click();
    await findInboxRow(page,seeded.taskId);
    expect((db.prepare("SELECT triage_state FROM tasks WHERE id=?")
      .get(seeded.taskId) as {triage_state:string}).triage_state).toBe("unprocessed");
    expect(writes).toHaveLength(1);
  }finally{
    await page.unroute("**/api/target-staging/inbox/triage",dropFirstUndo);
    db.close();
  }
});

test("C-3a: missing POST recovers after reload by replaying only its original UUID",async({page})=>{
  test.setTimeout(120_000);
  if(!store)throw Error("Missing isolated C-3a SQLite store");
  await page.setViewportSize({width:1280,height:844});
  const seeded=store.seed.projects["1280"],title=seeded.taskTitle;
  const db=new DatabaseSync(path.join(store.directory,"lumi-target.sqlite"));
  const receiptCount=()=>Number((db.prepare(
    "SELECT COUNT(*) AS n FROM task_triage_receipts WHERE task_id=? AND action='process'",
  ).get(seeded.taskId) as {n:number}).n);
  const before=receiptCount();
  try{
    await openInbox(page);
    await findInboxRow(page,seeded.taskId);
    const sent:unknown[]=[];
    const loseFirstPost=async(route:Route)=>{
      sent.push(route.request().postDataJSON());
      if(sent.length===1){
        // No server write at all. A matching receipt says not_recorded.
        await route.fulfill({status:503,contentType:"application/json",
          headers:{"cache-control":"no-store"},body:'{"error":"unavailable"}'});
      }else await route.continue();
    };
    await page.route("**/api/target-staging/inbox/triage",loseFirstPost);
    await processAction(page,title).click();
    await expect(page.getByTestId("target-inbox-uncertain")).toBeVisible();
    await expect(page.getByRole("button",{name:"Opakovat původní příkaz"}))
      .toBeVisible({timeout:15000});
    await expect(count(page)).toHaveCount(0);
    await expect(page.getByTestId("target-inbox-sidebar-count")).toHaveCount(0);
    expect(sent).toHaveLength(1);
    expect(receiptCount()).toBe(before);
    const original=JSON.parse((await page.evaluate(()=>
      sessionStorage.getItem("lumi:target-inbox-command:v1")))!) as
      {command:{commandId:string}};
    expect(original.command.commandId).toBe(
      (sent[0] as {commandId:string}).commandId);

    // A full reload has only the original content-free witness. Verify again
    // and replay THAT exact UUID/CAS, never a new command or a blind retry.
    await page.reload();
    await expect(page.getByTestId("target-inbox-uncertain")).toBeVisible();
    await expect(processAction(page,title)).toHaveCount(0);
    await page.getByRole("button",{name:"Ověřit původní příkaz"}).click();
    await expect(page.getByRole("button",{name:"Opakovat původní příkaz"}))
      .toBeVisible();
    await page.getByRole("button",{name:"Opakovat původní příkaz"}).click();
    await expect(page.getByRole("button",{name:"Vrátit do Inboxu (Undo)"}))
      .toBeVisible({timeout:20000});
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(sent[0]);
    expect(receiptCount()).toBe(before+1); // exactly one committed Process
    expect((db.prepare("SELECT triage_state FROM tasks WHERE id=?")
      .get(seeded.taskId) as {triage_state:string}).triage_state).toBe("processed");
    await page.getByRole("button",{name:"Vrátit do Inboxu (Undo)"}).click();
    await findInboxRow(page,seeded.taskId);
    await page.unroute("**/api/target-staging/inbox/triage",loseFirstPost);
  }finally{db.close();}
});

test("C-3a: hung Process request times out without losing UUID after reload",async({page})=>{
  test.setTimeout(100_000);
  if(!store)throw Error("Missing isolated C-3a SQLite store");
  await page.setViewportSize({width:1280,height:844});
  const seeded=store.seed.projects["1280"],title=seeded.taskTitle;
  await openInbox(page);
  await findInboxRow(page,seeded.taskId);
  await expect(processAction(page,title)).toBeVisible();
  let commands=0,release:()=>void=()=>{};
  const intercepted=async(route:Route)=>{
    commands++;
    await new Promise<void>(resolve=>{release=resolve;});
    try{await route.fulfill({status:503,contentType:"application/json",
      body:'{"error":"unavailable"}'});}catch{/* request has timed out */}
  };
  await page.route("**/api/target-staging/inbox/triage",intercepted);
  await processAction(page,title).click();
  // Transport deadline includes both fetch and an indefinitely stalled body.
  await expect(page.getByTestId("target-inbox-uncertain"))
    .toBeVisible({timeout:25_000});
  expect(commands).toBe(1);
  await page.reload();
  await expect(page.getByTestId("target-inbox-uncertain")).toBeVisible();
  await expect(processAction(page,title)).toHaveCount(0);
  await page.getByRole("button",{name:"Ověřit původní příkaz"}).click();
  await expect(page.getByTestId("target-inbox-uncertain")).toBeVisible();
  expect(commands).toBe(1);
  release();
  await page.unroute("**/api/target-staging/inbox/triage",intercepted);
});


test("C-3a: receipt 409 after real Process retains original UUID across reload",async({page})=>{
  test.setTimeout(100_000);
  if(!store)throw Error("Missing isolated C-3a SQLite store");
  await page.setViewportSize({width:390,height:844});
  const seeded=store.seed.projects["390"],title=seeded.taskTitle;
  await openInbox(page);
  await findInboxRow(page,seeded.taskId);
  let writes=0,checks=0;
  const countWrite=async(route:Route)=>{writes++;await route.continue();};
  const staleReceipt=async(route:Route)=>{
    checks++;
    await route.fulfill({status:409,contentType:"application/json",
      headers:{"cache-control":"no-store"},
      body:'{"error":"read_stale_reload"}'});
  };
  await page.route("**/api/target-staging/inbox/triage",countWrite);
  await page.route("**/api/target-staging/inbox/receipt",staleReceipt);
  await processAction(page,title).click();
  await expect(page.getByTestId("target-inbox-uncertain")).toBeVisible();
  expect(writes).toBe(1);
  await expect.poll(()=>checks,{timeout:15000}).toBeGreaterThan(0);
  await expect(count(page)).toHaveCount(0);
  await expect(page.getByTestId("target-inbox-sidebar-count")).toHaveCount(0);
  const witness=await page.evaluate(()=>
    sessionStorage.getItem("lumi:target-inbox-command:v1"));
  expect(witness).toContain("commandId");
  expect(witness).not.toContain(title);
  const originalId=(JSON.parse(witness!) as {command:{commandId:string}})
    .command.commandId;

  await page.reload();
  await expect(page.getByTestId("target-inbox-uncertain")).toBeVisible();
  await expect(processAction(page,title)).toHaveCount(0);
  expect(writes).toBe(1);
  expect((JSON.parse((await page.evaluate(()=>
    sessionStorage.getItem("lumi:target-inbox-command:v1")))!) as
      {command:{commandId:string}}).command.commandId).toBe(originalId);

  // The worker DID commit Process. Remove the stale-read mock BEFORE
  // rechecking after reload: a mocked route is not guaranteed to survive
  // full navigation, and a real receipt can already complete the recovery.
  await page.unroute("**/api/target-staging/inbox/receipt",staleReceipt);
  await page.getByRole("button",{name:"Ověřit původní příkaz"}).click();
  await expect(page.getByRole("button",{name:"Vrátit do Inboxu (Undo)"})).toBeVisible();
  expect(writes).toBe(1);
  await page.getByRole("button",{name:"Vrátit do Inboxu (Undo)"}).click();
  await findInboxRow(page,seeded.taskId);
  expect(writes).toBe(2); // The second unique write is the authorized Undo.
});

test("C-3a: exhausted refusal budget keeps sidebar hidden after third 409",async({page})=>{
  test.setTimeout(100_000);
  if(!store)throw Error("Missing isolated C-3a SQLite store");
  await page.setViewportSize({width:1280,height:844});
  await openInbox(page);
  await expect(count(page)).toBeVisible();
  await expect(page.getByTestId("target-inbox-sidebar-count")).toBeVisible();
  let refusals=0;
  const failPage=async(route:Route)=>{
    if(!new URL(route.request().url()).searchParams.has("cursor")){
      await route.continue();return;
    }
    refusals++;
    await route.fulfill({status:409,contentType:"application/json",
      headers:{"cache-control":"no-store"},
      body:'{"error":"read_stale_reload"}'});
  };
  await page.route("**/api/target-staging/inbox?*",failPage);
  // The shared refusal budget is 2 per 60 seconds and is runtime-scoped;
  // no page reload is allowed during these three authorizations.
  for(let i=0;i<3;i++){
    await inbox(page).getByRole("button",{name:"Načíst další"}).click();
    await expect(count(page)).toHaveCount(0);
    await expect(page.getByTestId("target-inbox-sidebar-count")).toHaveCount(0);
    if(i<2){
      await page.getByRole("button",{name:"Zkusit znovu"}).click();
      await expect(count(page)).toBeVisible({timeout:20000});
    }
  }
  expect(refusals).toBe(3);
  // No successful re-verification happened after the third 409.
  await page.waitForTimeout(800);
  await expect(count(page)).toHaveCount(0);
  await expect(page.getByTestId("target-inbox-sidebar-count")).toHaveCount(0);
});


test("C-3a: committed Process receipt recovers after Area move, with no stale Undo",async({page})=>{
  test.setTimeout(110_000);
  if(!store)throw Error("Missing isolated C-3a SQLite store");
  await page.setViewportSize({width:1280,height:844});
  const movedTask=store.seed.projects["1280"];
  const secondTask=store.seed.projects["390"];
  await openInbox(page);
  await findInboxRow(page,movedTask.taskId);

  let commands=0,receipts=0;
  const ambiguousPost=async(route:Route)=>{
    commands++;
    const response=await route.fetch();
    expect(response.status()).toBe(200); // the original Process REALLY committed
    await route.fulfill({status:503,contentType:"application/json",
      headers:{"cache-control":"no-store"},body:'{"error":"uncertain"}'});
  };
  const unavailableReceipt=async(route:Route)=>{
    receipts++;
    await route.fulfill({status:503,contentType:"application/json",
      headers:{"cache-control":"no-store"},body:'{"error":"unavailable"}'});
  };
  await page.route("**/api/target-staging/inbox/triage",ambiguousPost);
  await page.route("**/api/target-staging/inbox/receipt",unavailableReceipt);
  await processAction(page,movedTask.taskTitle).click();
  await expect(page.getByTestId("target-inbox-uncertain")).toBeVisible({timeout:15000});
  expect(commands).toBe(1);
  // Finish all four deliberately failed *read-only* receipt attempts before
  // changing the task and unblocking the route. An in-flight retry could
  // otherwise auto-resolve the original Process and remove this button.
  await expect.poll(()=>receipts,{timeout:15000}).toBe(4);
  await expect(page.getByRole("button",{name:"Ověřit původní příkaz"}))
    .toBeVisible();

  const db=new DatabaseSync(path.join(store.directory,"lumi-target.sqlite"));
  let moved=false;
  try{
    db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000");
    // Project Area moves require a separate R2 confirmation, so move the
    // individual task out of its project into another owned private Area.
    // The canonical task_revision_bump trigger increments revision automatically.
    db.prepare("UPDATE tasks SET project_id=NULL,area_id=? WHERE id=?")
      .run(store.seed.createAreaId,movedTask.taskId);
    moved=true; // same actor remains private owner of both Areas
    await page.unroute("**/api/target-staging/inbox/receipt",unavailableReceipt);
    await page.unroute("**/api/target-staging/inbox/triage",ambiguousPost);
    await page.getByRole("button",{name:"Ověřit původní příkaz"}).click();
    await expect(page.getByTestId("target-inbox-uncertain")).toHaveCount(0);
    await expect(page.getByText("Zpracování bylo potvrzeno.")).toBeVisible();
    await expect(page.getByRole("button",{name:"Vrátit do Inboxu (Undo)"}))
      .toHaveCount(0);
    await expect(page.getByRole("button",{name:"Zavřít a obnovit"})).toBeVisible();
    expect(commands).toBe(1); // reconciliation never resends the original UUID

    // Resolve the original receipt and prove that a new unrelated command
    // is possible in the SAME actor generation, with a genuine Undo.
    await page.getByRole("button",{name:"Zavřít a obnovit"}).click();
    await findInboxRow(page,secondTask.taskId);
    await processAction(page,secondTask.taskTitle).click();
    await expect(page.getByRole("button",{name:"Vrátit do Inboxu (Undo)"}))
      .toBeVisible({timeout:15000});
    await page.getByRole("button",{name:"Vrátit do Inboxu (Undo)"}).click();
    await findInboxRow(page,secondTask.taskId);
  }finally{
    if(moved)db.prepare("UPDATE tasks SET project_id=?,area_id=NULL WHERE id=?")
      .run(movedTask.projectId,movedTask.taskId);
    db.close();
  }
});


test("C-3a: real Process receipt unlocks after authorized tombstone; never Undo deleted task",async({page})=>{
  test.setTimeout(110_000);
  if(!store)throw Error("Missing isolated C-3a SQLite store");
  await page.setViewportSize({width:1280,height:844});
  const deletedTask=store.seed.searchProjects["1280"];
  const nextTask=store.seed.searchProjects["390"];
  await openInbox(page);
  await findInboxRow(page,deletedTask.taskId);

  let commands=0,receipts=0;
  const ambiguousProcess=async(route:Route)=>{
    commands++;
    const response=await route.fetch();
    expect(response.status()).toBe(200); // the original Process did commit
    await route.fulfill({status:503,contentType:"application/json",
      headers:{"cache-control":"no-store"},body:'{"error":"uncertain"}'});
  };
  const blockedReceipt=async(route:Route)=>{
    receipts++;
    await route.fulfill({status:503,contentType:"application/json",
      headers:{"cache-control":"no-store"},body:'{"error":"unavailable"}'});
  };
  await page.route("**/api/target-staging/inbox/triage",ambiguousProcess);
  await page.route("**/api/target-staging/inbox/receipt",blockedReceipt);
  await processAction(page,deletedTask.taskTitle).click();
  await expect(page.getByTestId("target-inbox-uncertain")).toBeVisible({timeout:15000});
  // Keep every injected 503 in place until the automatic receipt retry
  // has exhausted its bounded four attempts and recovery is user-controlled.
  await expect.poll(()=>receipts,{timeout:15000}).toBe(4);
  await expect(page.getByRole("button",{name:"Ověřit původní příkaz"}))
    .toBeVisible();
  expect(commands).toBe(1);

  // Run the genuine, pinned delete writer in the same isolated child-process
  // harness as the target-store bootstrap. The Playwright TS project must not
  // import all server-side modules under its unrelated strict compiler config.
  const deletion=JSON.parse(execFileSync(process.execPath,[
    "--experimental-loader",
    path.join(process.cwd(),"scripts","target-staging-ts-loader.mjs"),
    path.join(process.cwd(),"e2e","target-inbox-delete-child.mjs"),
    deletedTask.taskId,
  ],{cwd:process.cwd(),stdio:["ignore","pipe","inherit"]}).toString());
  expect(deletion).toEqual({ok:true});
  const db=new DatabaseSync(path.join(store.directory,"lumi-target.sqlite"));
  db.exec("PRAGMA busy_timeout=5000");
  try{
    expect(db.prepare("SELECT 1 FROM tasks WHERE id=?").get(deletedTask.taskId))
      .toBeUndefined();
    expect(db.prepare("SELECT 1 FROM task_tombstones WHERE id=?").get(deletedTask.taskId))
      .toBeDefined();
  }finally{db.close();}

  await page.unroute("**/api/target-staging/inbox/receipt",blockedReceipt);
  await page.unroute("**/api/target-staging/inbox/triage",ambiguousProcess);
  await page.getByRole("button",{name:"Ověřit původní příkaz"}).click();
  await expect(page.getByTestId("target-inbox-uncertain")).toHaveCount(0);
  await expect(page.getByText("Zpracování bylo potvrzeno.")).toBeVisible();
  await expect(page.getByRole("button",{name:"Vrátit do Inboxu (Undo)"})).toHaveCount(0);
  await expect(page.getByRole("button",{name:"Zavřít a obnovit"})).toBeVisible();
  expect(commands).toBe(1); // original UUID is never resent

  await page.getByRole("button",{name:"Zavřít a obnovit"}).click();
  await findInboxRow(page,nextTask.taskId);
  await processAction(page,nextTask.taskTitle).click();
  await expect(page.getByRole("button",{name:"Vrátit do Inboxu (Undo)"}))
    .toBeVisible({timeout:15000});
  await page.getByRole("button",{name:"Vrátit do Inboxu (Undo)"}).click();
  await findInboxRow(page,nextTask.taskId);
});
