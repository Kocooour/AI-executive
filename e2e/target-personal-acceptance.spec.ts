/** R3 personal acceptance: ONE browser journey through the REAL target stack.
 * Browser -> real Next route handlers -> real isolated target SQLite, every flag of
 * TARGET_PERSONAL_V1_PROFILE on together (playwright.config.ts creates the store in the run dir).
 * All task and authorization data reads use the real isolated store.
 * The C-2 session failure regression alone injects a synthetic 503 for the
 * session witness; it never substitutes task/summary data or ACL decisions.
 * Synthetic data, default-off: only LUMI_TARGET_PERSONAL_ACCEPTANCE_E2E=true runs it. */
import {test,expect} from "./fixtures";
import {signIn} from "./helpers";
import {createHash} from "node:crypto";
import {DatabaseSync} from "node:sqlite";
import { request as upstreamRequest } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";
import type {Page,Response,Route} from "@playwright/test";
import {isTargetReadRequest} from "../lib/target-edit-fetch";

test.skip(process.env.LUMI_TARGET_PERSONAL_ACCEPTANCE_E2E!=="true",
  "personal acceptance needs the real isolated target store; it is opt-in");

type Seed={areaTitle:string;projects:Record<string,{projectId:string;projectTitle:string;taskId:string;taskTitle:string}>};
const store=JSON.parse(process.env.LUMI_E2E_TARGET_STORE||"null") as {seed:Seed}|null;
type Calls={method:string;path:string}[]&{peakReads?:number;postReads?:number;unavailableReads?:number};
const targetCalls=(page:Page)=>{
  const calls:Calls=[];
  calls.peakReads=0;
  calls.postReads=0;
  calls.unavailableReads=0;
  let reads=0;
  const outstanding=new Set<object>();
  // A read is exactly what the client queue treats as one (lib/target-edit-fetch.ts): every GET and the POST-shaped
  // reads (create-preview, create-status, create-recovery, receipt and status checks), each of which can spawn a staging
  // read child. Only the /session check is excluded: it is answered in-process and never queued (lib/target-app-fetch.ts).
  const isRead=(method:string,pathname:string)=>
    pathname!=="/api/target-staging/session"&&isTargetReadRequest(pathname,{method});
  const target=(url:string)=>new URL(url).pathname.startsWith("/api/target-staging/");
  page.on("request",request=>{
    if(!target(request.url()))return;
    const {pathname}=new URL(request.url());
    calls.push({method:request.method(),path:pathname});
    if(isRead(request.method(),pathname)){
      outstanding.add(request);
      reads++;calls.peakReads=Math.max(calls.peakReads!,reads);
      if(request.method()!=="GET")calls.postReads!++;
    }
  });
  // Fetch resolves on response headers and then releases the shared read-queue
  // slot. requestfinished waits for the BODY consumer and overcounts active
  // server readers while the next queued request is already in progress.
  const done=(request:object)=>{
    if(outstanding.delete(request))reads--;
  };
  page.on("response",response=>{
    const request=response.request();
    if(outstanding.has(request)&&response.status()===503)calls.unavailableReads!++;
    done(request);
  });
  page.on("requestfailed",done);
  return calls;
};
const count=(calls:Calls,method:string,pathname:RegExp)=>
  calls.filter(call=>call.method===method&&pathname.test(call.path)).length;
const isPost=(path:string)=>(response:{url():string;request():{method():string}})=>
  response.request().method()==="POST"&&new URL(response.url()).pathname===path;
// The id the server confirmed for a create: the command carries the client-generated id, and the 201 body echoes
// it. Chromium may already have dropped the body once the dialog closes, so the echo is compared when readable.
const createdId=async(response:Response,key:"taskId"|"noteId")=>{
  const sent=(response.request().postDataJSON() as Record<string,string>)[key];
  expect(sent).toMatch(/^[0-9a-f-]{36}$/);
  const echoed=await response.json().then((body:Record<string,unknown>)=>body[key],()=>undefined);
  if(echoed!==undefined)expect(echoed).toBe(sent);
  return sent;
};
// Everything a page could keep on the client: web storage, cookies readable by script and the VALUES of every
// IndexedDB object store (bounded), not just database names.
const clientState=(page:Page)=>page.evaluate(async()=>{
  const dump:unknown[]=[Object.entries(localStorage),Object.entries(sessionStorage),document.cookie];
  for(const info of await indexedDB.databases()){
    if(!info.name)continue;
    const db=await new Promise<IDBDatabase>((resolve,reject)=>{
      const request=indexedDB.open(info.name as string);
      request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
    });
    for(const name of Array.from(db.objectStoreNames)){
      const rows=await new Promise<unknown[]>((resolve,reject)=>{
        const request=db.transaction(name,"readonly").objectStore(name).getAll(undefined,500);
        request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
      });
      dump.push([info.name,name,rows]);
    }
    db.close();
  }
  return JSON.stringify(dump).slice(0,4_000_000);
});

// #501: ONE synthetic, connected E2E from operator purge to the *real*
// server boot and authenticated browser in both responsive layouts. The
// preflight is executed by playwright.config.ts BEFORE its webServer starts,
// inside the SAME throwaway legacy data directory that Next subsequently uses.
// The target personal-v1 SQLite store remains separate and untouched.
test("#501: dry-run, purge, real restart, login/settings, protected rows, second zero at 390/1280",async({page})=>{
  test.setTimeout(150_000);
  const runDir=process.env.LUMI_E2E_RUN_DIR;
  if(!runDir||!store)throw new Error("Requires the isolated #501 preflight and target store");
  const witness=JSON.parse(readFileSync(path.join(runDir,"archive-purge-preflight.json"),"utf8")) as {
    databasePath:string;protectedTables:string[];protectedBefore:Record<string,string>;
    firstBefore:Record<string,number>;afterApply:Record<string,number>;
    afterStartup:Record<string,number>;secondBefore:Record<string,number>;
    secondAfter:Record<string,number>;
  };
  expect(witness.firstBefore.entities).toBeGreaterThan(0);
  for(const counts of [witness.afterApply,witness.afterStartup,witness.secondBefore,witness.secondAfter])
    expect(Object.values(counts).every(value=>value===0)).toBe(true);
  for(const width of [390,1280]){
    await page.setViewportSize({width,height:844});
    // Authenticate afresh after purge; a pre-existing owner fixture cookie
    // would test only session reuse, not the actual login UI.
    await page.context().clearCookies();
    await page.goto("/?view=MyPlanPreview&scope=personal");
    await expect(page.locator('.authCard input[type="password"]')).toBeVisible();
    await signIn(page);
    await expect(page.getByTestId("target-my-plan")).toBeVisible();
    await page.goto("/?view=LegacyInbox&scope=personal");
    await expect(page.getByTestId("target-my-plan")).toBeVisible();
    await expect(page).toHaveURL(/view=MyPlanPreview/);
    await expect(page.locator('[data-nav-archive="true"]')).toHaveCount(0);
    // Live connected Gmail is a current Inbox tab, never an old Archive view.
    await page.goto("/?view=Inbox&scope=personal");
    await expect(page.getByTestId("target-inbox-mail-tabs")).toBeVisible();
    await expect(page.getByTestId("target-inbox")).toBeVisible();
    await page.locator('[data-testid="target-inbox-mail-tabs"] [data-inbox-tab="mail"]').click();
    await expect(page.locator(".mailReader")).toBeVisible();
    await expect(page.locator('[data-nav-archive="true"]')).toHaveCount(0);
    if(width===390){
      await expect(page.locator(".mobileNav [data-nav-tab]")).toHaveCount(4);
      await page.locator('.mobileNav [data-nav-tab="More"]').click();
      await page.locator('.mobileMore [data-nav-view="Settings"]').click();
    }else{
      await page.locator('.sidebarActions [data-nav-system="Settings"]').click();
    }
    await expect(page.locator(".settingsPanel")).toBeVisible();
    // The legacy backing SQLite has been opened by the real Next process,
    // not merely by a standalone raw SQLite process.
    const db=new DatabaseSync(witness.databasePath,{readOnly:true});
    try{
      for(const table of ["entities","relations","tombstones","note_revisions"]){
        const count=Number(db.prepare('SELECT COUNT(*) AS n FROM "'+table+'"').get().n);
        expect(count,table+" must remain empty after server boot").toBe(0);
      }
      for(const table of witness.protectedTables){
        const current=createHash("sha256").update(JSON.stringify(db.prepare(
          'SELECT * FROM "'+table+'" ORDER BY rowid').all())).digest("hex");
        expect(current,"protected table changed: "+table).toBe(witness.protectedBefore[table]);
      }
    }finally{db.close();}
  }
});

for(const width of [390,1280]){
  test("one owner, private Areas only: the whole daily loop on the real store at "+width+"px",async({page})=>{
    test.setTimeout(180_000);
    if(!store)throw new Error("The isolated target store was not created");
    const seed=store.seed.projects[String(width)];
    const token="acc"+width+"x"+Math.random().toString(36).slice(2,8);
    const taskTitle="Úkol "+token;
    const taskRenamed="Úkol "+token+" přejmenovaný";
    const projectRenamed="Projekt "+token;
    const noteTitle="Poznámka "+token;
    const noteEdited="Poznámka "+token+" upravená";
    const calls=targetCalls(page);
    await page.setViewportSize({width,height:844});
    const detail=page.getByTestId("target-detail");
    const fab=page.locator('[data-target-private-capture-fab="'+(width===390?"mobile":"desktop")+'"]');
    // A task opened from its project returns to the project first, then closes.
    const closeDetail=async()=>{
      for(let step=0;step<3&&await detail.count()>0;step++){
        await detail.locator("button.inspectorClose").click();
        await page.waitForTimeout(150);
      }
      await expect(detail).toHaveCount(0);
    };
    const planRow=(title:string)=>page.locator('[data-detail-row^="task:"]').filter({hasText:title});
    const today=page.getByRole("region",{name:/^Dnes a dřívější/});
    const tomorrow=page.getByRole("region",{name:/^Zítra/});
    const openMyPlan=async()=>{
      await page.goto("/?view=MyPlanPreview&scope=personal");
      await expect(page.getByTestId("target-my-plan")).toBeVisible();
      await expect(today).toBeVisible(); // the day lists render only from a server answer
      await expect(page.getByTestId("target-my-plan-unavailable")).toHaveCount(0);
    };
    const readsAfter=(mark:number,method:string,pathname:RegExp)=>
      calls.slice(mark).filter(call=>call.method===method&&pathname.test(call.path)).length;

    // 1. The signed-in owner opens My Plan; it renders from the server.
    await openMyPlan();
    expect(count(calls,"GET",/\/my-plan\/slice$/)).toBeGreaterThan(0);

    // 1b. Regression (concurrency): open My Plan and click Quick Capture at once, with no waiting. Every
    // read of the app shares one queue, so the Area catalog is never refused with "Oblasti nelze ověřit".
    await page.goto("/?view=MyPlanPreview&scope=personal");
    await fab.click();
    await page.getByTestId("target-capture-task-kind").click();
    await expect(page.getByTestId("target-private-task-area")).toBeVisible();
    await expect(page.getByText("Oblasti nelze ověřit")).toHaveCount(0);
    await page.getByRole("dialog").getByRole("button",{name:"Zavřít"}).click();
    await expect(page.getByTestId("target-private-task-capture")).toHaveCount(0);
    await expect(page.getByTestId("target-my-plan-unavailable")).toHaveCount(0);

    // 2. Global Quick Capture: private task with an explicit Area choice, exactly one POST (201).
    await fab.click();
    await page.getByTestId("target-capture-task-kind").click();
    await page.getByTestId("target-private-task-area").selectOption({label:store.seed.areaTitle});
    await page.getByTestId("target-private-task-form").getByRole("textbox",{name:"Název úkolu"}).fill(taskTitle);
    const taskPost=page.waitForResponse(isPost("/api/target-staging/tasks"));
    await page.getByTestId("target-private-task-save").click();
    const taskResponse=await taskPost;
    expect(taskResponse.status()).toBe(201);
    const taskId=await createdId(taskResponse,"taskId");
    await expect(page.getByTestId("target-private-task-created")).toBeVisible();
    expect(count(calls,"POST",/^\/api\/target-staging\/tasks$/)).toBe(1);

    // 3. A new task has no day yet; the detail (of exactly the created task) sets When = today.
    await page.getByTestId("target-private-task-open").click();
    await expect(detail).toBeVisible();
    await expect(page).toHaveURL(new RegExp("taskId="+taskId));
    await expect(detail).toContainText(taskTitle);
    await detail.getByTestId("target-detail-edit-when-today").click();
    await expect(detail.getByTestId("target-detail-edit-status")).toContainText("Termín „Kdy“ je uložen.");
    await closeDetail();
    await expect(today.locator('[data-detail-row="task:'+taskId+'"]')).toHaveCount(1);

    // 4. When = tomorrow (My Plan button) moves it from today's list into tomorrow's.
    await page.getByRole("button",{name:"Naplánovat osobně na zítřek: "+taskTitle}).click();
    await expect(tomorrow.locator('[data-detail-row="task:'+taskId+'"]')).toHaveCount(1);
    await expect(today.locator('[data-detail-row="task:'+taskId+'"]')).toHaveCount(0);

    // C-2: a tomorrow When is visible in the authorized seven-day view and Home,
    // never in legacy/archive data. Back/Forward and reload keep the target route.
    const nextDay=await page.evaluate(()=>{
      const d=new Date();d.setDate(d.getDate()+1);
      return [d.getFullYear(),String(d.getMonth()+1).padStart(2,"0"),
        String(d.getDate()).padStart(2,"0")].join("-");
    });
    await page.goto("/?view=Upcoming&scope=personal");
    await expect(page.getByTestId("target-upcoming")).toBeVisible();
    await expect(page.locator('[data-target-day="'+nextDay+'"] [data-detail-row="task:'+taskId+'"]')).toHaveCount(1);
    await page.locator('[data-target-day="'+nextDay+'"] [data-detail-row="task:'+taskId+'"]').click();
    await expect(detail).toContainText(taskTitle);
    await page.goBack();
    await expect(page.getByTestId("target-upcoming")).toBeVisible();
    await page.goForward();
    await expect(detail).toContainText(taskTitle);
    await closeDetail();
    // C-2 privacy: offline hides previously authorized task titles, and coming
    // back online must re-verify and re-read (not resurrect a stored page).
    await page.context().setOffline(true);
    await expect(page.getByTestId("target-overview-error")).toBeVisible();
    await expect(page.getByTestId("target-upcoming")).toHaveCount(0);
    await page.context().setOffline(false);
    await expect(page.getByTestId("target-upcoming")).toContainText(taskTitle);
    await page.goto("/?view=Home&scope=personal");
    await expect(page.getByTestId("target-home")).toBeVisible();
    await expect(page.getByTestId("target-home")).toContainText(taskTitle);
    await expect(page.getByTestId("target-home")).toContainText("úkolů celkem");
    await page.reload();
    await expect(page.getByTestId("target-home")).toContainText(taskTitle);

    // #477: a same-generation session 503 must erase titles already mounted
    // in Home and Upcoming. The server-authorized task reads stay real.
    const checkFailedSessionPoll=async(view:"target-home"|"target-upcoming")=>{
      let rejected=0;
      const rejectSession=async(route:Route)=>{
        rejected++;
        await route.fulfill({status:503,contentType:"application/json",
          headers:{"cache-control":"no-store"},body:'{"error":"temporary_unavailable"}'});
      };
      const sessionRoute="**/api/target-staging/session";
      await page.route(sessionRoute,rejectSession);
      try{
        // The runtime's unthrottled sign-in signal triggers the exact same
        // session refresh as a passive poll; it does not rotate actor identity.
        await page.evaluate(()=>window.dispatchEvent(new Event("lumi:auth-signed-in")));
        await expect.poll(()=>rejected).toBeGreaterThan(0);
        await expect(page.getByTestId("target-overview-gate")).toBeVisible();
        await expect(page.getByTestId(view)).toHaveCount(0);
        await expect(page.locator('[data-detail-row="task:'+taskId+'"]')).toHaveCount(0);
      }finally{
        await page.unroute(sessionRoute,rejectSession);
      }

      // Once the session succeeds, hold the *real* newly authorized day read.
      // Neither old DOM rows nor their prior response may reappear while the
      // fresh request is pending. Release only after checking the blank state.
      let pendingReads=0;
      let releaseRead:()=>void=()=>{};
      const barrier=new Promise<void>(resolve=>{releaseRead=()=>resolve();});
      const dayRoute="**/api/target-staging/task-temporal/my-plan-day?*";
      const holdFreshRead=async(route:Route)=>{
        pendingReads++;
        await barrier;
        await route.continue();
      };
      await page.route(dayRoute,holdFreshRead);
      try{
        await page.evaluate(()=>window.dispatchEvent(new Event("lumi:auth-signed-in")));
        await expect.poll(()=>pendingReads).toBeGreaterThan(0);
        await expect(page.getByTestId("target-overview-loading")).toBeVisible();
        await expect(page.getByTestId(view)).toHaveCount(0);
        await expect(page.locator('[data-detail-row="task:'+taskId+'"]')).toHaveCount(0);
        releaseRead();
        await expect(page.getByTestId(view)).toContainText(taskTitle);
        await expect(page.locator('[data-detail-row="task:'+taskId+'"]')).toHaveCount(1);
      }finally{
        releaseRead();
        await page.unroute(dayRoute,holdFreshRead);
      }
    };
    await checkFailedSessionPoll("target-home");
    await page.goto("/?view=Upcoming&scope=personal");
    await expect(page.getByTestId("target-upcoming")).toContainText(taskTitle);
    await checkFailedSessionPoll("target-upcoming");
    await page.goto("/?view=Home&scope=personal");
    await expect(page.getByTestId("target-home")).toContainText(taskTitle);

    // C-2 privacy: hidden documents must not retain rendered target titles.
    // Shadow the DOM visibility getter (no real browser backgrounding needed).
    await page.evaluate(()=>{
      Object.defineProperty(document,"visibilityState",
        {configurable:true,get:()=>"hidden"});
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect(page.getByTestId("target-overview-error")).toBeVisible();
    await expect(page.getByTestId("target-home")).toHaveCount(0);
    await page.evaluate(()=>{
      Reflect.deleteProperty(document,"visibilityState");
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect(page.getByTestId("target-home")).toContainText(taskTitle);
    await openMyPlan();

    // 5. Open the task detail and rename it.
    await planRow(taskTitle).click();
    await expect(detail).toContainText(taskTitle);
    await detail.getByTestId("target-detail-edit-title").click();
    await detail.getByTestId("target-detail-edit-title-input").fill(taskRenamed);
    await detail.getByTestId("target-detail-edit-save").click();
    await expect(detail.getByTestId("target-detail-edit-status")).toContainText("Název je uložen.");
    await expect(detail.getByRole("heading",{name:taskRenamed})).toBeVisible();
    await closeDetail();
    await expect(planRow(taskRenamed)).toHaveCount(1);

    // 6. Projects, scope Osobní: the seeded project; open it, see its task, rename it.
    await page.goto("/?view=Projects&scope=personal");
    const list=page.getByTestId("target-scope-list");
    await expect(list).toContainText(seed.projectTitle);
    await list.locator('[data-detail-row="project:'+seed.projectId+'"]').click();
    await expect(detail).toContainText(seed.taskTitle);
    const edit=detail.getByTestId("target-project-title-edit");
    await edit.getByRole("button",{name:"Upravit název"}).click();
    await edit.getByRole("textbox",{name:"Název projektu"}).fill(projectRenamed);
    await edit.getByRole("button",{name:"Uložit změny"}).click();
    await expect(detail.getByRole("heading",{name:projectRenamed})).toBeVisible();
    // The project's task opens its own detail; plan it for today.
    await detail.locator('[data-detail-row="task:'+seed.taskId+'"]').click();
    await expect(detail).toContainText(seed.taskTitle);
    await detail.getByTestId("target-detail-edit-when-today").click();
    await expect(detail.getByTestId("target-detail-edit-status")).toContainText("Termín „Kdy“ je uložen.");
    await closeDetail();
    await expect(list).toContainText(projectRenamed);
    await expect(list).not.toContainText(seed.projectTitle);

    // 7. My Plan: mark the project task done, then reopen it with Undo.
    await openMyPlan();
    await expect(planRow(seed.taskTitle)).toHaveCount(1);
    await page.getByRole("button",{name:"Dokončit úkol: "+seed.taskTitle}).click();
    await expect(planRow(seed.taskTitle)).toHaveCount(0);
    await page.getByRole("button",{name:"Vrátit dokončení (Undo)"}).click();
    await expect(page.getByRole("status").filter({hasText:"Obnovení potvrzeno."})).toBeVisible();
    // The original personal day is atomically restored by My Plan Undo.
    await expect(planRow(seed.taskTitle)).toHaveCount(1);
    await page.goto("/?view=Projects&scope=personal");
    await page.getByTestId("target-scope-list").locator('[data-detail-row="project:'+seed.projectId+'"]').click();
    await detail.locator('[data-detail-row="task:'+seed.taskId+'"]').click();
    await expect(detail.getByTestId("target-detail-edit-status-toggle")).toBeVisible();
    await expect(detail.getByText("Otevřeno",{exact:true})).toBeVisible(); // the status line itself
    await expect(detail.getByText("Dokončeno",{exact:true})).toHaveCount(0);
    // Regression: detail completion must bind the actor's real planned day,
    // and its Undo must restore that day through the real status route.
    await detail.getByTestId("target-detail-edit-status-toggle").click();
    await expect(detail.getByTestId("target-detail-edit-status")).toContainText("Stav úkolu je uložen.");
    await expect(detail.getByTestId("target-detail-edit-undo")).toBeVisible();
    await detail.getByTestId("target-detail-edit-undo").click();
    await expect(detail.getByTestId("target-detail-edit-status")).toContainText("Úkol je znovu otevřen.");
    await closeDetail();
    await openMyPlan();
    await expect(planRow(seed.taskTitle)).toHaveCount(1);

    // 8. Notes: create a private note (one POST, 201), open exactly that note, edit and save.
    await page.goto("/?view=Notes&scope=personal");
    await expect(page.getByTestId("target-scope-list")).toHaveAttribute("data-state","ready");
    await fab.click();
    await page.getByTestId("target-capture-note-kind").click();
    await page.getByTestId("target-private-area-select").selectOption({label:store.seed.areaTitle});
    const form=page.getByTestId("target-private-create-form");
    await form.getByRole("textbox",{name:"Název"}).fill(noteTitle);
    await form.getByRole("textbox",{name:"Text poznámky"}).fill("Tělo poznámky "+token);
    const notePost=page.waitForResponse(isPost("/api/target-staging/notes"));
    await form.getByTestId("target-private-create-save").click();
    const noteResponse=await notePost;
    expect(noteResponse.status()).toBe(201);
    const noteId=await createdId(noteResponse,"noteId");
    await expect(page.getByTestId("target-private-note-areas")).toHaveCount(0);
    expect(count(calls,"POST",/^\/api\/target-staging\/notes$/)).toBe(1);
    const noteList=page.getByTestId("target-scope-list");
    await expect(noteList).toContainText(noteTitle);
    await noteList.locator('[data-detail-row="note:'+noteId+'"]').click();
    await expect(page).toHaveURL(new RegExp("noteId="+noteId));
    await expect(detail).toContainText("Tělo poznámky "+token);
    const noteEdit=detail.getByTestId("target-note-edit");
    await noteEdit.getByRole("button",{name:"Upravit poznámku"}).click();
    await noteEdit.getByRole("textbox",{name:"Název"}).fill(noteEdited);
    await noteEdit.getByRole("textbox",{name:"Text poznámky"}).fill("Upravené tělo "+token);
    await noteEdit.getByRole("button",{name:"Uložit změny"}).click();
    await expect(detail.getByRole("heading",{name:noteEdited})).toBeVisible();
    await expect(detail).toContainText("Upravené tělo "+token);
    await closeDetail();

    // 9. Main Search finds the renamed task, project and note by title (every search is a fresh server read).
    const search=async()=>{
      const input=page.locator(".searchField input");
      await input.fill(token); // Focus/typing navigates to Search and never fetches.
      const section=page.getByTestId("target-main-title-search");
      await expect(section).toBeVisible();
      const mark=calls.length;
      await input.press("Enter");
      await expect.poll(()=>readsAfter(mark,"GET",/\/title-search$/)).toBeGreaterThan(0);
      return section;
    };
    let results=await search();
    await expect(results).toContainText(taskRenamed);
    await expect(results).toContainText(projectRenamed);
    await expect(results).toContainText(noteEdited);

    // 10. Full reload: everything is served from the server, not from client state.
    const before=calls.length;
    await openMyPlan();
    await expect(planRow(taskRenamed)).toHaveCount(1);
    expect(readsAfter(before,"GET",/\/my-plan\/slice$/)).toBeGreaterThan(0);
    const stored=await clientState(page);
    for(const secret of [token,taskRenamed,projectRenamed,noteEdited,"Tělo poznámky"])
      expect(stored,"client state must not hold "+secret).not.toContain(secret);
    await page.goto("/?view=Projects&scope=personal");
    await expect(page.getByTestId("target-scope-list")).toContainText(projectRenamed);
    await page.goto("/?view=Notes&scope=personal");
    await expect(page.getByTestId("target-scope-list")).toContainText(noteEdited);
    results=await search();
    await expect(results).toContainText(taskRenamed);
    await expect(results).toContainText(projectRenamed);
    await expect(results).toContainText(noteEdited);

    // 11. Delete the task and the note. Absence is asserted only after a fresh server read of that list.
    await openMyPlan();
    await planRow(taskRenamed).click();
    await detail.getByTestId("target-detail-edit-delete").click();
    await detail.getByTestId("target-detail-edit-confirm-yes").click();
    await expect(detail.getByTestId("target-detail-edit-deleted")).toBeVisible();
    const planMark=calls.length;
    await closeDetail();
    await page.getByRole("button",{name:"Obnovit"}).click();
    await expect.poll(()=>readsAfter(planMark,"GET",/\/my-plan\/slice$/)).toBeGreaterThan(0);
    await expect(today).toBeVisible();
    await expect(tomorrow).toBeVisible();
    await expect(page.getByTestId("target-my-plan-unavailable")).toHaveCount(0);
    await expect(planRow(taskRenamed)).toHaveCount(0);
    await page.goto("/?view=Notes&scope=personal");
    await expect(page.getByTestId("target-scope-list")).toContainText(noteEdited);
    await page.getByTestId("target-scope-list").locator('[data-detail-row="note:'+noteId+'"]').click();
    await detail.getByTestId("target-detail-edit-delete").click();
    const noteMark=calls.length; // the list re-reads itself as soon as the delete commits
    await detail.getByTestId("target-detail-edit-confirm-yes").click();
    await expect(detail.getByTestId("target-detail-edit-deleted")).toBeVisible();
    await closeDetail();
    await expect.poll(()=>readsAfter(noteMark,"GET",/\/note-index\/global$/)).toBeGreaterThan(0);
    await expect(page.getByTestId("target-scope-list")).toHaveAttribute("data-state","ready");
    await expect(page.getByTestId("target-scope-list")).not.toContainText(noteEdited);
    results=await search(); // fresh GET /title-search observed inside search()
    await expect(results).toContainText(projectRenamed); // positive proof that the answer is the ready list
    await expect(results).not.toContainText(taskRenamed);
    await expect(results).not.toContainText(noteEdited);
    // Read capacity is bounded at two actual server children. Compare pending
    // requests only UNTIL response headers: subsequent body draining is not a
    // server child, and counting until requestfinished inflates concurrency.
    expect(calls.peakReads).toBeLessThanOrEqual(2);
    expect(calls.unavailableReads,"no target GET/receipt may exhaust child capacity").toBe(0);
    // The invariant above is only meaningful if POST-shaped reads were really counted: the journey issues at least
    // the note create-preview and a receipt/status check.
    expect(calls.postReads).toBeGreaterThan(0);
    expect(count(calls,"POST",/\/notes\/create-preview$/)).toBeGreaterThan(0);

    // 12. Without the owner cookie the server refuses generically and the page drops every title.
    // NOTE: this proves CLIENT-side removal only; the stateless owner token itself stays valid on the server
    // (see docs/R3-PERSONAL-ACCEPTANCE.md, gap 7).
    await expect(page.getByTestId("target-main-title-search")).toContainText(projectRenamed);
    await page.context().clearCookies();
    const refused=await page.request.get("/api/target-staging/my-plan/slice?evaluationDate=2026-01-01&areaFilter=all&limit=50");
    expect(refused.status()).toBe(401);
    expect(await refused.text()).not.toContain(projectRenamed);
    // The runtime revalidates when the tab becomes visible/focused (throttle 1 s). Bringing another tab to the
    // front and back is a real visibility change (no synthetic window event is dispatched).
    await page.waitForTimeout(1100);
    const other=await page.context().newPage();
    await other.bringToFront();
    await page.bringToFront();
    await other.close();
    await expect(page.getByText(projectRenamed)).toHaveCount(0,{timeout:15_000});
    await expect(page.getByText(token)).toHaveCount(0);
    await page.reload();
    await expect(page.locator('.authCard input[type="password"]')).toBeVisible();
    await expect(page.getByText(token)).toHaveCount(0);
    await expect(page.getByTestId("target-my-plan")).toHaveCount(0);
  });
}


// #501 (2026-11-25): Archive navigation is gone on both layouts. The
// browser is authenticated against the same real isolated personal-v1 store
// used by the existing acceptance suite. The offline/legacy profile is separate.
for (const width of [390, 1280]) {
  test("#501 Archive removed; old links resolve to My Plan at " + width + "px", async ({ page }) => {
    test.setTimeout(90_000);
    if (!store) throw new Error("Requires the real isolated target store");
    await page.setViewportSize({ width, height: 844 });
    for (const retired of ["LegacyHome", "LegacyInbox", "LegacyUpcoming", "LegacyObsolete", "Archive", "Today",
      "Overdue", "Anytime", "Someday", "Completed", "Areas", "Context"]) {
      await page.goto("/?view=" + retired);
      await expect(page.getByTestId("target-my-plan")).toBeVisible();
      await expect(page).toHaveURL(/view=MyPlanPreview/);
      await expect(page.locator('[data-nav-archive="true"]')).toHaveCount(0);
      await expect(page.getByTestId("target-archive-heading")).toHaveCount(0);
      await expect(page.getByTestId("legacy-read-only-notice")).toHaveCount(0);
    }
    if (width === 390) {
      await expect(page.locator(".mobileNav [data-nav-tab]")).toHaveCount(4);
      await page.locator('.mobileNav [data-nav-tab="More"]').click();
      await expect(page.getByTestId("target-archive-mobile")).toHaveCount(0);
      await expect(page.getByTestId("target-more-primary")).toBeVisible();
      await page.locator('.mobileMore [data-nav-view="Settings"]').click();
    } else {
      await expect(page.getByTestId("target-archive-sidebar")).toHaveCount(0);
      await page.locator('.sidebarActions [data-nav-system="Settings"]').click();
    }
    await expect(page.locator(".settingsPanel")).toBeVisible();
    // The browser's Back destination was canonicalized, not revived as Archive.
    await page.goBack();
    await expect(page.getByTestId("target-my-plan")).toBeVisible();
    await expect(page.locator('[data-nav-archive="true"]')).toHaveCount(0);
  });
}

test.describe("C34 HTTPS reverse-proxy acceptance",()=>{
  // Trust only the ephemeral self-signed proxy certificate in this scenario.
  test.use({ignoreHTTPSErrors:true});
  test("C34: browser creates a task through reverse proxy with public Origin distinct from Next listener",async({page})=>{
  test.setTimeout(120_000);
  if(!store)throw new Error("Requires the isolated target store");
  const innerPort=Number(process.env.E2E_PORT||3100);
  const publicPort=innerPort+1;
  // HTTPS at the browser, plain HTTP to Next, with Host preserved: the precise
  // Tailscale Serve scheme mismatch that the old strict equality rejected.
  const publicOrigin=`https://localhost:${publicPort}`;
  const forwardedHosts:string[]=[];
  const proxiedTaskWrites:{host:string;origin:string;fetchSite:string;forwardedHeaders:string[]}[]=[];
  // Match Tailscale Serve: preserve the browser Host and Origin as received,
  // do not manufacture X-Forwarded-Host/Proto/Port, and forward to loopback.
  const tlsDir=mkdtempSync(path.join(tmpdir(),"lumi-c34-https-proxy-"));
  try{
    const keyPath=path.join(tlsDir,"proxy.key");
    const certPath=path.join(tlsDir,"proxy.crt");
    execFileSync("openssl",[
      "req","-x509","-nodes","-newkey","rsa:2048",
      "-keyout",keyPath,"-out",certPath,"-days","1","-subj","/CN=localhost",
    ],{stdio:"ignore"});
    const proxy=createHttpsServer({
      key:readFileSync(keyPath),cert:readFileSync(certPath),
    },(incoming,outgoing)=>{
    forwardedHosts.push(String(incoming.headers.host||""));
    const headers={...incoming.headers};
    for(const key of Object.keys(headers)){
      if(key.startsWith("x-forwarded-"))delete headers[key];
    }
    if(incoming.method==="POST"&&new URL(incoming.url||"/",publicOrigin).pathname==="/api/target-staging/tasks"){
      // Capture what the proxy actually forwards, not just the browser URL.
      proxiedTaskWrites.push({
        host:String(headers.host||""),
        origin:String(headers.origin||""),
        fetchSite:String(headers["sec-fetch-site"]||""),
        forwardedHeaders:Object.keys(headers).filter(key=>key.startsWith("x-forwarded-")),
      });
    }
    const upstream=upstreamRequest({
      hostname:"127.0.0.1",port:innerPort,method:incoming.method,
      path:incoming.url||"/",headers,
    },backend=>{
      outgoing.writeHead(backend.statusCode||502,backend.headers);
      backend.pipe(outgoing);
    });
    upstream.on("error",()=>{
      if(!outgoing.headersSent)outgoing.writeHead(502);
      outgoing.end();
    });
    incoming.pipe(upstream);
  });
  await new Promise<void>((resolve,reject)=>{
    proxy.once("error",reject);
    proxy.listen(publicPort,"127.0.0.1",()=>resolve());
  });
  try{
    await page.setViewportSize({width:1280,height:844});
    await page.goto(publicOrigin+"/?view=MyPlanPreview&scope=personal");
    await expect(page.getByTestId("target-my-plan")).toBeVisible();
    const fab=page.locator('[data-target-private-capture-fab="desktop"]');
    await fab.click();
    await page.getByTestId("target-capture-task-kind").click();
    await page.getByTestId("target-private-task-area").selectOption({label:store.seed.areaTitle});
    const title="Proxy task "+Date.now();
    await page.getByTestId("target-private-task-form")
      .getByRole("textbox",{name:"Název úkolu"}).fill(title);
    const responsePromise=page.waitForResponse(isPost("/api/target-staging/tasks"));
    await page.getByTestId("target-private-task-save").click();
    const reply=await responsePromise;
    expect(reply.status(),"public-origin write behind proxy must not be rejected as cross-origin").toBe(201);
    // The actual task handler reports its request.url origin only in this
    // isolated E2E configuration; a successful POST alone would not prove the
    // old strict-origin comparison would have failed under the same proxy.
    const nextOrigin=reply.headers()["x-lumi-e2e-next-request-origin"];
    const nextBrowserOrigin=reply.headers()["x-lumi-e2e-next-browser-origin"];
    expect(nextOrigin,"Next must see HTTP after TLS termination").toMatch(/^http:\/\//);
    expect(nextBrowserOrigin,"Next must see the original browser Origin").toBe(publicOrigin);
    expect(nextBrowserOrigin).toBe(proxiedTaskWrites[0]?.origin);
    // Negative control using both values observed by the actual Next handler:
    // the former strict equality would reject this request with 403.
    expect(nextBrowserOrigin!==nextOrigin,
      "the original Origin !== request.url.origin guard must reject this request").toBe(true);
    expect(proxiedTaskWrites).toEqual([{
      host:`localhost:${publicPort}`,
      origin:publicOrigin,
      fetchSite:"same-origin",
      forwardedHeaders:[],
    }]);
    await expect(page.getByTestId("target-private-task-created")).toBeVisible();
    expect(forwardedHosts.length).toBeGreaterThan(0);
    expect(forwardedHosts.every(host=>host===`localhost:${publicPort}`)).toBe(true);
  }finally{
    await new Promise<void>((resolve,reject)=>{
      proxy.close(error=>error?reject(error):resolve());
    });
  }
  }finally{
    rmSync(tlsDir,{recursive:true,force:true});
  }
  });
});

/** #490/#462: full C-3a real-store profile, including an Inbox badge read,
 * must recover an interrupted 200 Area body AUTOMATICALLY after wake.
 * No Retry/Close/reopen action can satisfy this test. */
for(const width of [390,1280]){
  test("C-3a concurrent Inbox wake automatically reauthorizes interrupted Area at "+width+"px",async({page})=>{
    test.setTimeout(90_000);
    if(!store?.seed?.areaTitle)throw Error("Missing isolated private Area fixture");
    await page.setViewportSize({width,height:844});
    await page.addInitScript(()=>{
      const proof={
        armed:false,inboxStarted:0,areaAttempts:0,bodyInterrupted:false,
        taskPosts:0,events:[] as string[],
      };
      (window as typeof window & {__lumiC3aWake?:typeof proof}).__lumiC3aWake=proof;
      const real=window.fetch.bind(window);
      window.fetch=(input,init)=>{
        const raw=typeof input==="string"?input:
          input instanceof URL?input.href:input.url;
        const pathname=new URL(raw,location.href).pathname;
        if(pathname==="/api/target-staging/tasks"&&init?.method==="POST"&&proof.armed)
          proof.taskPosts++;
        if(!proof.armed)return real(input,init);
        if(pathname==="/api/target-staging/inbox"){
          proof.inboxStarted++;
          proof.events.push("inbox:queued");
          // The Inbox's queued read may overlap the wake and private Area
          // recovery, but the server still uses its real isolated store.
          return new Promise<globalThis.Response>((resolve,reject)=>{
            const signal=init?.signal;
            const aborted=()=>{
              clearTimeout(timer);reject(new DOMException("Aborted","AbortError"));
            };
            if(signal?.aborted){reject(new DOMException("Aborted","AbortError"));return;}
            const timer=setTimeout(()=>{
              signal?.removeEventListener("abort",aborted);
              void real(input,init).then(resolve,reject);
            },120);
            signal?.addEventListener("abort",aborted,{once:true});
          });
        }
        if(pathname==="/api/target-staging/session"){
          return real(input,init).then(response=>{
            proof.events.push("session:"+response.status);
            return response;
          });
        }
        if(pathname==="/api/target-staging/notes/create-targets"){
          const attempt=++proof.areaAttempts;
          proof.events.push("area:"+attempt);
          if(attempt===1){
            // 200 HEADERS + partial streamed JSON, then a body failure.
            // The client must discard it, verify the session and start
            // its one automatic fresh GET. Never present partial Area data.
            const body=new ReadableStream<Uint8Array>({
              start(controller){
                controller.enqueue(new TextEncoder().encode('{"areas":['));
                setTimeout(()=>{
                  proof.bodyInterrupted=true;
                  controller.error(new TypeError("C-3a interrupted 200 body"));
                },15);
              },
            });
            return Promise.resolve(new Response(body,{status:200,headers:{
              "content-type":"application/json","cache-control":"no-store",
            }}));
          }
        }
        return real(input,init);
      };
    });
    await page.goto("/?view=Calendar&scope=personal");
    const capture=page.locator('[data-target-private-capture-fab="'+
      (width===390?"mobile":"desktop")+'"]');
    await expect(capture).toBeVisible();
    await capture.click();
    await page.getByTestId("target-capture-task-kind").click();
    const select=page.getByTestId("target-private-task-area");
    await expect(select.locator("option")).toContainText([store.seed.areaTitle],{timeout:15000});
    await select.selectOption({label:store.seed.areaTitle});
    const title=page.getByTestId("target-private-task-form").locator("input");
    await title.fill("Abandoned C-3a private draft");
    await page.evaluate(()=>{
      const proof=(window as typeof window & {__lumiC3aWake?:{armed:boolean}}).__lumiC3aWake!;
      proof.armed=true;
      Object.defineProperty(document,"visibilityState",{configurable:true,value:"hidden"});
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect(page.getByTestId("target-private-task-form")).toHaveCount(0);
    await page.evaluate(()=>{
      Reflect.deleteProperty(document,"visibilityState");
      document.dispatchEvent(new Event("visibilitychange"));
    });
    // No user action after wake: the chooser must itself load a fresh Area.
    await expect(select.locator("option")).toContainText([store.seed.areaTitle],{timeout:25000});
    await expect(select).toHaveValue("");
    const proof=await page.evaluate(()=>(window as typeof window & {
      __lumiC3aWake:{inboxStarted:number;areaAttempts:number;
        bodyInterrupted:boolean;taskPosts:number;events:string[]};
    }).__lumiC3aWake);
    expect(proof.bodyInterrupted).toBe(true);
    expect(proof.areaAttempts,"one interrupted read and one fresh automatic GET").toBe(2);
    expect(proof.inboxStarted,"Inbox badge must also be active during wake").toBeGreaterThan(0);
    const failed=proof.events.indexOf("area:1"),replacement=proof.events.indexOf("area:2");
    expect(failed).toBeGreaterThan(-1);
    expect(replacement).toBeGreaterThan(failed);
    expect(proof.events.slice(failed+1,replacement),
      "a new owner session GET 200 must precede automatic private Area retry")
      .toContain("session:200");
    await select.selectOption({label:store.seed.areaTitle});
    await expect(page.getByTestId("target-private-task-form").locator("input"))
      .toHaveValue("");
    expect(proof.taskPosts,"wake may never replay a private CREATE").toBe(0);
  });
}


/** #490/#475: real Chrome network cancellation is distinct from a synthetic
 * broken response body. The real-store personal profile mounts Inbox alongside
 * Quick Capture. This CDP witness must observe the first Area GET cancelled by
 * the app's own pagehide/AbortController and an automatic, independently
 * completed owner-session → Area read after pageshow. No UI retry is allowed.
 * Only test-owned transport delays and isolated seeded SQLite are used. */
for(const width of [390,1280]){
  test("C-3a client-cancelled Area automatically resumes with Inbox at "+width+"px",async({page})=>{
    test.setTimeout(90_000);
    if(!store?.seed?.areaTitle)throw Error("Missing isolated personal Area fixture");
    await page.setViewportSize({width,height:844});
    const cdp=await page.context().newCDPSession(page);
    await cdp.send("Network.enable");
    type NetworkRead={
      id:string;path:string;method:string;order:number;
      status?:number;finished?:number;failed?:number;
      reason?:string;cancelled?:boolean;disk?:boolean;serviceWorker?:boolean;
    };
    const events:NetworkRead[]=[];
    const pending=new Map<string,NetworkRead>();
    let order=0;
    const areaPath="/api/target-staging/notes/create-targets";
    const sessionPath="/api/target-staging/session";
    const inboxPath="/api/target-staging/inbox";
    const relevant=new Set([areaPath,sessionPath,inboxPath]);
    cdp.on("Network.requestWillBeSent",event=>{
      const pathname=new URL(event.request.url).pathname;
      if(!relevant.has(pathname)||event.request.method!=="GET")return;
      const read:NetworkRead={id:event.requestId,path:pathname,
        method:event.request.method,order:++order};
      events.push(read);pending.set(read.id,read);
    });
    cdp.on("Network.responseReceived",event=>{
      const read=pending.get(event.requestId);
      if(!read)return;
      read.status=event.response.status;
      read.disk=event.response.fromDiskCache;
      read.serviceWorker=event.response.fromServiceWorker;
      order++;
    });
    cdp.on("Network.loadingFinished",event=>{
      const read=pending.get(event.requestId);
      if(read){read.finished=++order;pending.delete(read.id);}
    });
    cdp.on("Network.loadingFailed",event=>{
      const read=pending.get(event.requestId);
      if(read){
        read.failed=++order;read.reason=event.errorText;
        read.cancelled=event.canceled===true;pending.delete(read.id);
      }
    });
    let areaRequests=0,inboxWakeReads=0,overlapWitness=false;
    let waking=false,taskPosts=0;
    await page.route("**/api/target-staging/notes/create-targets",route=>{
      areaRequests++;
      // The first GET is a real browser request, held at the HTTP route.
      // Only the app's pagehide listener/AbortController may cancel it.
      if(areaRequests===1)return;
      return route.continue();
    });
    // The badge always fetches /inbox?limit=1. A pathname-only glob does
    // NOT match its query string in Playwright, so that would falsely report
    // no Inbox contention even while the badge actually loads.
    await page.route(/\/api\/target-staging\/inbox\?(?:.*)$/,async route=>{
      if(!waking)return route.continue();
      inboxWakeReads++;
      // If the Inbox read starts while the cancelled Area has not yet
      // been replaced, the two consumers genuinely contend for the shared
      // target client queue. Delay Inbox's HTTP completion to expose it.
      if(areaRequests===1)overlapWitness=true;
      await new Promise(resolve=>setTimeout(resolve,220));
      await route.continue().catch(()=>{});
    });
    page.on("request",request=>{
      if(request.method()==="POST"&&
        new URL(request.url()).pathname==="/api/target-staging/tasks")taskPosts++;
    });
    try{
      await page.goto("/?view=Calendar&scope=personal");
      const capture=page.locator('[data-target-private-capture-fab="'+
        (width===390?"mobile":"desktop")+'"]');
      await expect(capture).toBeVisible();
      await capture.click();
      await page.getByTestId("target-capture-task-kind").click();
      await expect.poll(()=>areaRequests).toBe(1);
      await expect.poll(()=>events.some(e=>e.path===areaPath&&e.order>0))
        .toBe(true);
      const original=events.find(e=>e.path===areaPath)!;
      expect(original.finished).toBeUndefined();
      expect(original.failed).toBeUndefined();
      await page.evaluate(()=>window.dispatchEvent(
        new PageTransitionEvent("pagehide",{persisted:false})));
      await expect.poll(()=>original.failed,{timeout:10000}).not.toBeUndefined();
      expect(original.cancelled,"the browser must cancel the original GET")
        .toBe(true);
      expect(original.reason,"AbortController cancellation must be real")
        .toBe("net::ERR_ABORTED");
      expect(original.finished).toBeUndefined();
      expect(areaRequests,"no unauthorized Area GET while hidden").toBe(1);
      waking=true;
      await page.evaluate(()=>window.dispatchEvent(
        new PageTransitionEvent("pageshow",{persisted:false})));
      const select=page.getByTestId("target-private-task-area");
      // The only user action above was opening Capture; no Retry, Close, or
      // reopen follows the wake. The chooser must repair itself.
      await expect(select.locator("option").filter({hasText:store.seed.areaTitle}))
        .toHaveCount(1,{timeout:25000});
      await expect.poll(()=>areaRequests).toBe(2);
      await expect.poll(()=>inboxWakeReads).toBeGreaterThan(0);
      expect(overlapWitness,
        "Inbox badge must start while the cancelled Area is awaiting replacement")
        .toBe(true);
      const fresh=events.filter(e=>e.path===areaPath&&e.order>original.order);
      expect(fresh,"exactly one automatic replacement Area GET").toHaveLength(1);
      const replacement=fresh[0];
      await expect.poll(()=>replacement.finished,{timeout:10000})
        .not.toBeUndefined();
      expect(replacement.status).toBe(200);
      expect(replacement.failed).toBeUndefined();
      expect(replacement.disk).toBe(false);
      expect(replacement.serviceWorker).toBe(false);
      const authorized=events.filter(e=>e.path===sessionPath&&
        e.order>original.failed!&&e.finished!==undefined&&
        e.failed===undefined&&e.status===200&&
        e.finished<replacement.order);
      expect(authorized.length,
        "fresh completed owner session HTTP 200 must precede Area replacement")
        .toBeGreaterThan(0);
      await expect(select).toHaveValue("");
      await select.selectOption({label:store.seed.areaTitle});
      await expect(page.getByTestId("target-private-task-form").locator("input"))
        .toHaveValue("");
      expect(taskPosts,"restoring the Area must never issue CREATE").toBe(0);
    }finally{
      await cdp.detach();
    }
  });
}
