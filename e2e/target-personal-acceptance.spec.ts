/** R3 personal acceptance: ONE browser journey through the REAL target stack.
 * Browser -> real Next route handlers -> real isolated target SQLite, every flag of
 * TARGET_PERSONAL_V1_PROFILE on together (playwright.config.ts creates the store in the run dir).
 * No /api/target-staging request is intercepted or fulfilled here; page.on("request") only observes.
 * Synthetic data, default-off: only LUMI_TARGET_PERSONAL_ACCEPTANCE_E2E=true runs it. */
import {test,expect} from "./fixtures";
import type {Page,Response} from "@playwright/test";
import {isTargetReadRequest} from "../lib/target-edit-fetch";

test.skip(process.env.LUMI_TARGET_PERSONAL_ACCEPTANCE_E2E!=="true",
  "personal acceptance needs the real isolated target store; it is opt-in");

type Seed={areaTitle:string;projects:Record<string,{projectId:string;projectTitle:string;taskId:string;taskTitle:string}>};
const store=JSON.parse(process.env.LUMI_E2E_TARGET_STORE||"null") as {seed:Seed}|null;
type Calls={method:string;path:string}[]&{peakReads?:number;postReads?:number};
const targetCalls=(page:Page)=>{
  const calls:Calls=[];
  calls.peakReads=0;
  calls.postReads=0;
  let reads=0;
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
      reads++;calls.peakReads=Math.max(calls.peakReads!,reads);
      if(request.method()!=="GET")calls.postReads!++;
    }
  });
  const done=(request:{url():string;method():string})=>{
    if(target(request.url())&&isRead(request.method(),new URL(request.url()).pathname))reads--;
  };
  page.on("requestfinished",done);
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
    // GAP (docs/R3-PERSONAL-ACCEPTANCE.md): completing deletes the planned day, so a reopened task is
    // not listed in My Plan again. The reopened state itself is verified in the project detail.
    await page.goto("/?view=Projects&scope=personal");
    await page.getByTestId("target-scope-list").locator('[data-detail-row="project:'+seed.projectId+'"]').click();
    await detail.locator('[data-detail-row="task:'+seed.taskId+'"]').click();
    await expect(detail.getByTestId("target-detail-edit-status-toggle")).toBeVisible();
    await expect(detail.getByText("Otevřeno",{exact:true})).toBeVisible(); // the status line itself
    await expect(detail.getByText("Dokončeno",{exact:true})).toHaveCount(0);
    await closeDetail();

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
    // Every read of the whole journey stayed within the server's two concurrent read children.
    expect(calls.peakReads).toBeLessThanOrEqual(2);
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
