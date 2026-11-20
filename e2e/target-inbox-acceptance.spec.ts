/** C-3a real isolated target SQLite acceptance, never a production store.
 * Explicitly enabled by LUMI_TARGET_INBOX_E2E=true. The installed browser
 * drives actual Next HTTP/actor-scoped read, Process, receipt and Undo routes.
 * All page fixtures come from the canonical personal-store bootstrap. */
import {test,expect} from "./fixtures";
import {randomUUID} from "node:crypto";
import type {Page,Route} from "@playwright/test";

test.skip(process.env.LUMI_TARGET_INBOX_E2E!=="true",
  "C-3a real-store Inbox acceptance is opt-in");
const store=JSON.parse(process.env.LUMI_E2E_TARGET_STORE||"null") as {
  directory:string;restoreGeneration:string;
  seed:{areaTitle:string;projects:Record<string,{taskId:string;taskTitle:string}>};
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
  for(let attempt=0;attempt<3;attempt++){
    if(await count(page).isVisible())break;
    await expect.poll(async()=>await count(page).isVisible()||
      await retry.isVisible(),{timeout:10000}).toBe(true);
    if(await count(page).isVisible())break;
    await retry.click();
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
    await expect(page.getByTestId("target-detail")).toContainText(seeded.taskTitle);
    await page.goBack();
    await findInboxRow(page,seeded.taskId);
    await page.goForward();
    await expect(page.getByTestId("target-detail")).toContainText(seeded.taskTitle);
    await page.reload();
    await expect(page.getByTestId("target-detail")).toContainText(seeded.taskTitle);
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
// while the main Inbox (limit=50) has not been opened. The first-page response
// must revoke that independently cached count on either an ACL/policy 409 or
// a disabled Inbox 404, and never revive it from a late old GET.
for(const width of [390,1280]){
  for(const status of [409,404]){
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
            body:JSON.stringify({error:status===409?"read_stale_reload":"Not found"})});
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
