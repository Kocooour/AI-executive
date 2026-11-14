/** R3 personal acceptance: ONE browser journey through the REAL target stack.
 * Browser -> real Next route handlers -> real isolated target SQLite, every flag of
 * TARGET_PERSONAL_V1_PROFILE on together (playwright.config.ts creates the store in the run dir).
 * No /api/target-staging request is intercepted or fulfilled here; page.on("request") only observes.
 * Synthetic data, default-off: only LUMI_TARGET_PERSONAL_ACCEPTANCE_E2E=true runs it. */
import {test,expect} from "./fixtures";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { readFile } from "node:fs/promises";
import type {Page,Response} from "@playwright/test";
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


// GET /api/store excludes lifecycle tables. Compare relevant legacy SQLite rows
// directly as well, so an unintended Attention/session/action write is detected.
const legacyDbRows = () => {
  if (!process.env.LUMI_E2E_RUN_DIR) throw new Error("Missing isolated E2E run directory");
  const db = new DatabaseSync(path.join(process.env.LUMI_E2E_RUN_DIR, "data", "store.sqlite"), { readOnly: true });
  try {
    const tables = [
      "metadata", "entities", "relations", "tombstones",
      "attention_states", "attention_history", "work_sessions",
      "work_session_intervals", "work_session_commands", "work_session_events",
      "ai_proposals", "ai_action_history",
    ];
    const available = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as { name: string }[]).map(row => row.name));
    return JSON.stringify(Object.fromEntries(tables.filter(name => available.has(name)).map(name => [
      name, db.prepare(`SELECT * FROM ${name}`).all().map(row => JSON.stringify(row)).sort(),
    ])));
  } finally {
    db.close();
  }
};

// C13: the real target profile must expose legacy Home/Inbox/Today for reading
// without ever turning the historical local-first store into a migration source.
for (const width of [390, 1280]) {
  test("target mode leaves legacy Home, Inbox and Today read-only at " + width + "px", async ({ page }) => {
    test.setTimeout(90_000);
    if (!store) throw new Error("Requires the real isolated target store");
    await page.setViewportSize({ width, height: 844 });
    const unexpectedWrites: string[] = [];
    const attentionReads: string[] = [];
    let seeding = false;
    page.on("request", request => {
      const url = new URL(request.url());
      const pathname = url.pathname;
      if (request.method() === "GET" && pathname === "/api/attention")
        attentionReads.push(url.searchParams.get("readOnly") || "missing");
      // Target staging uses POST-shaped reads; all other API mutation
      // verbs are forbidden here, including Attention and work sessions.
      if (!seeding && ["POST", "PUT", "PATCH", "DELETE"].includes(request.method()) &&
          pathname.startsWith("/api/") && !pathname.startsWith("/api/target-staging/"))
        unexpectedWrites.push(request.method() + " " + pathname);
    });
    // Even a brand-new browser in target mode may read the old server copy,
    // but it may not seed IndexedDB or upload a synthesized baseline.
    await page.goto("/?view=Home");
    await expect(page.getByTestId("legacy-read-only-notice")).toBeVisible();
    expect(unexpectedWrites, "target startup must not write to any legacy API").toEqual([]);

    // Seed only through the ordinary real legacy HTTP route. It is the sole
    // allowed PUT in this scenario and is excluded from observed UI requests.
    const token = "legacy-c13-" + width + "-" + Date.now();
    const homeTitle = token + "-home";
    const inboxTitle = token + "-inbox";
    const overdueTitle = token + "-overdue";
    const now = Date.now();
    seeding = true;
    try {
      const seedStatus = await page.evaluate(async ({ homeTitle, inboxTitle, overdueTitle, now }) => {
        const current = await fetch("/api/store", { cache: "no-store" }).then(response => response.json());
        const task = (id: string, title: string, properties: Record<string, unknown>) => ({
          id, title, type: "task", status: "open", workspaceId: "personal",
          properties, createdAt: now, updatedAt: now,
        });
        const response = await fetch("/api/store", {
          method: "PUT", headers: { "content-type": "application/json" },
          body: JSON.stringify({
            baseRevision: current.revision, restoreGeneration: current.restoreGeneration,
            entities: [...current.entities,
              // Ordinary Home task must stay in the Today list. A separate overdue
              // task exercises Attention without being deduplicated out of that list.
              task("c13:" + homeTitle, homeTitle, { today: true }),
              task("c13:" + inboxTitle, inboxTitle, { inbox: true }),
              task("c13:" + overdueTitle, overdueTitle, { deadline: "2020-01-01" })],
            relations: current.relations, deletedIds: [], revivedIds: [],
          }),
        });
        return response.status;
      }, { homeTitle, inboxTitle, overdueTitle, now });
      expect(seedStatus).toBe(200);
    } finally {
      seeding = false;
    }
    const before = await (await page.request.get("/api/store")).body();
    const beforeDb = legacyDbRows();

    for (const [view, title] of [["Home", homeTitle], ["Inbox", inboxTitle], ["Today", homeTitle]] as const) {
      await page.goto("/?view=" + view);
      const banner = page.getByTestId("legacy-read-only-notice");
      await expect(banner).toBeVisible();
      await expect(banner).toContainText("jen pro čtení");
      await expect(banner.getByRole("button", { name: "Otevřít Můj plán" })).toBeVisible();

      const row = view === "Home"
        ? page.locator(".homeTaskList article").filter({ hasText: title }).first()
        : page.locator(".taskRow").filter({ hasText: title }).first();
      await expect(row).toBeVisible();
      await expect(row.locator("button.check")).toBeDisabled();
      if (view === "Home") {
        // A separate overdue task must appear in Attention: it previously caused
        // GET /api/attention to INSERT lifecycle rows as a side effect.
        await expect(page.locator(".attentionItem").filter({ hasText: overdueTitle })).toBeVisible();
        // Its Home row is intentionally absent; only the ordinary Today task
        // is available to open and inspect in the list below Attention.
        await expect(page.locator(".homeTaskList article").filter({ hasText: overdueTitle })).toHaveCount(0);
        // A sibling running an older client can announce a changed IndexedDB
        // snapshot. This tab must continue showing the server's historical data.
        const sibling = await page.context().newPage();
        try {
          await sibling.goto("/?view=Home");
          await expect(sibling.locator(".homeTaskList article").filter({ hasText: title })).toBeVisible();
          await sibling.evaluate(() => {
            const channel = new BroadcastChannel("ai-executive-tabs");
            channel.postMessage({ type: "changed", from: "older-legacy-tab" });
            channel.close();
          });
          await page.waitForTimeout(250);
          await expect(row).toBeVisible();
        } finally {
          await sibling.close();
        }
      }
      await row.click();
      const inspector = page.locator("aside.inspectorDetail");
      await expect(inspector).toBeVisible();
      await expect(inspector.locator(".titleEdit")).toHaveValue(title);
      await expect(inspector.locator(".titleEdit")).toHaveJSProperty("readOnly", true);
      if (width === 390) await expect(inspector.locator(".taskPreviewCheck")).toBeDisabled();
      await expect(inspector.locator(".taskDetailMoreList select")).toBeDisabled();
      await expect(inspector.locator(".taskDetailEssentials input[type=date]").first()).toBeDisabled();
      await expect(inspector.locator(".taskDetailMoreActions button.danger")).toBeDisabled();
      // Disclosure and navigation still work; they do not mutate old data.
      await inspector.locator(".taskDetailMoreToggle").click();
      await expect(inspector.locator(".taskDetailMoreOptions select").first()).toBeDisabled();
      await inspector.locator(".inspectorClose").click();
      await expect(inspector).toHaveCount(0);
    }
    // One live navigation path to the target, without making the old data editable.
    await page.getByTestId("legacy-read-only-notice")
      .getByRole("button", { name: "Otevřít Můj plán" }).click();
    await expect(page.getByTestId("target-my-plan")).toBeVisible();
    expect(unexpectedWrites, "no browser-requested legacy API mutation").toEqual([]);
    expect(attentionReads.length, "real Attention reads were exercised").toBeGreaterThan(0);
    expect(attentionReads, "all Attention reads must use the non-mutating projection")
      .toEqual(attentionReads.map(() => "1"));
    const after = await (await page.request.get("/api/store")).body();
    expect(after.equals(before), "legacy store GET response bytes must stay unchanged").toBe(true);
    expect(legacyDbRows(), "canonical legacy SQLite tables must stay unchanged").toBe(beforeDb);
  });
}

for (const width of [390, 1280]) {
  test("local unsent legacy edit remains visible and exportable without server writes at " + width + "px", async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width, height: 844 });
    const writes: string[] = [];
    page.on("request", request => {
      const pathname = new URL(request.url()).pathname;
      if (["PUT", "POST", "PATCH", "DELETE"].includes(request.method()) &&
          pathname.startsWith("/api/") && !pathname.startsWith("/api/target-staging/"))
        writes.push(request.method() + " " + pathname);
    });
    await page.goto("/?view=Home");
    await expect(page.getByTestId("legacy-read-only-notice")).toBeVisible();
    const original = await (await page.request.get("/api/store")).body();
    const originalDb = legacyDbRows();
    const title = "Neodeslaná změna C13 " + width + " " + Date.now();
    // Simulate a device that was edited offline BEFORE target mode started:
    // insert a changed record and its old sync base only into IndexedDB.
    await page.evaluate(async (title) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("ai-executive");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const old = { id: "local-unsent-c13", type: "task", title: "Původní koncept",
        status: "open", workspaceId: "personal", properties: { inbox: true },
        createdAt: 1, updatedAt: 1 };
      const next = { ...old, title, updatedAt: 2 };
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(["entities", "baseEntities"], "readwrite");
        tx.objectStore("baseEntities").put(old);
        tx.objectStore("entities").put(next);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
      localStorage.setItem("ai-executive-pending-sync", "1");
    }, title);
    await page.reload();
    // The 390px v1 shell restores My Plan from the canonical bare URL after
    // reload. The device-copy warning belongs on historical views only; use
    // an explicit Home deep link instead of asserting against My Plan.
    await page.goto("/?view=Home");
    await expect(page.getByTestId("legacy-read-only-notice")).toBeVisible();
    const notice = page.getByTestId("legacy-pending-rescue");
    await expect(notice).toBeVisible();
    await expect(notice).toContainText("neodeslaly");
    await expect(notice).toContainText("1");
    // Open the second tab BEFORE preparing, so its startup events cannot
    // themselves invalidate the prepared copy. The subsequent IndexedDB edit
    // changes only the data, without a storage or BroadcastChannel notification.
    const secondTab = await page.context().newPage();
    secondTab.on("request", request => {
      const pathname = new URL(request.url()).pathname;
      if (["PUT", "POST", "PATCH", "DELETE"].includes(request.method()) &&
          pathname.startsWith("/api/") && !pathname.startsWith("/api/target-staging/"))
        writes.push("tab2 " + request.method() + " " + pathname);
    });
    // Use a same-origin JSON document rather than mounting a second Lumi app.
    // Mounting that app emits cross-tab change messages during startup, which
    // would invalidate the export independently of the silent IndexedDB edit.
    await secondTab.goto("/api/store");
    await page.bringToFront();
    await page.waitForTimeout(350); // let any focus inspection settle before preparing
    await notice.getByTestId("legacy-pending-prepare").click();
    await expect(notice.getByTestId("legacy-pending-download")).toBeVisible();

    // Two-tab regression: IndexedDB changes do not necessarily send
    // BroadcastChannel or localStorage notifications. A focus/periodic
    // recheck must invalidate the prepared file even at the SAME item count.
    const updatedTitle = title + " (z druhé záložky)";
    await secondTab.evaluate(async (updatedTitle) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("ai-executive");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("entities", "readwrite");
        const objectStore = tx.objectStore("entities");
        const req = objectStore.get("local-unsent-c13");
        req.onsuccess = () => {
          if (!req.result) return;
          objectStore.put({ ...req.result, title: updatedTitle, updatedAt: 3 });
        };
        req.onerror = () => reject(req.error);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    }, updatedTitle);
    // Do NOT close the sibling tab, dispatch focus or send a channel event.
    // The download button must discover a silent IndexedDB edit itself, even
    // before the periodic 30-second refresh fires. Without this check, the
    // stale prepared blob would download despite containing the old title.
    const downloads: string[] = [];
    page.on("download", item => downloads.push(item.suggestedFilename()));
    await expect(notice.getByTestId("legacy-pending-download")).toBeVisible();
    await notice.getByTestId("legacy-pending-download").click();
    await expect(notice.getByTestId("legacy-pending-download")).toHaveCount(0);
    await expect(notice.getByRole("alert")).toBeVisible();
    expect(downloads).toEqual([]);
    await secondTab.close();
    await notice.getByTestId("legacy-pending-prepare").click();
    await expect(notice.getByTestId("legacy-pending-download")).toBeVisible();
    const downloadReady = page.waitForEvent("download");
    await notice.getByTestId("legacy-pending-download").click();
    const saved = await downloadReady;
    const savedPath = await saved.path();
    if (!savedPath) throw new Error("Local device copy was not downloaded");
    const bundle = JSON.parse(await readFile(savedPath, "utf-8"));
    expect(bundle.format).toBe("lumi-legacy-device-copy");
    expect(bundle.automaticReplayAllowed).toBe(false);
    expect(bundle.local.entities.some((item: {title: string}) => item.title === updatedTitle)).toBe(true);
    expect(bundle.local.entities.some((item: {title: string}) => item.title === title)).toBe(false);
    await page.goto("/?view=Inbox");
    await expect(page.getByTestId("legacy-pending-rescue")).toBeVisible();
    await page.goto("/?view=Today");
    await expect(page.getByTestId("legacy-pending-rescue")).toBeVisible();
    expect(writes).toEqual([]);
    expect((await (await page.request.get("/api/store")).body()).equals(original)).toBe(true);
    expect(legacyDbRows()).toBe(originalDb);
  });
}
