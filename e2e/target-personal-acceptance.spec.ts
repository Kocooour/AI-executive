/** R3 personal acceptance: ONE browser journey through the REAL target stack.
 * Browser -> real Next route handlers -> real isolated target SQLite, every flag of
 * TARGET_PERSONAL_V1_PROFILE on together (playwright.config.ts creates the store in the run dir).
 * No /api/target-staging request is intercepted or fulfilled here; page.on("request") only observes.
 * Synthetic data, default-off: only LUMI_TARGET_PERSONAL_ACCEPTANCE_E2E=true runs it. */
import {test,expect} from "./fixtures";
import type {Page} from "@playwright/test";

test.skip(process.env.LUMI_TARGET_PERSONAL_ACCEPTANCE_E2E!=="true",
  "personal acceptance needs the real isolated target store; it is opt-in");

type Seed={areaTitle:string;projects:Record<string,{projectId:string;projectTitle:string;taskId:string;taskTitle:string}>};
const store=JSON.parse(process.env.LUMI_E2E_TARGET_STORE||"null") as {seed:Seed}|null;
const targetCalls=(page:Page)=>{
  const calls:{method:string;path:string}[]=[];
  page.on("request",request=>{
    const url=new URL(request.url());
    if(url.pathname.startsWith("/api/target-staging/"))calls.push({method:request.method(),path:url.pathname});
  });
  return calls;
};
const count=(calls:{method:string;path:string}[],method:string,pathname:RegExp)=>
  calls.filter(call=>call.method===method&&pathname.test(call.path)).length;

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
    const main=page.locator("main");
    const detail=page.getByTestId("target-detail");
    const closeDetail=async()=>{
      await detail.getByRole("button",{name:"Zavřít"}).click();
      await expect(detail).toHaveCount(0);
    };
    const planRow=(title:string)=>page.locator('[data-detail-row^="task:"]').filter({hasText:title});

    // 1. The signed-in owner opens My Plan; it renders from the server.
    await page.goto("/?view=MyPlanPreview&scope=personal");
    await expect(page.getByTestId("target-my-plan")).toBeVisible();
    await expect.poll(()=>count(calls,"GET",/\/my-plan\/slice$/)).toBeGreaterThan(0);
    await expect(page.getByTestId("target-my-plan-unavailable")).toHaveCount(0);

    // 2. Global Quick Capture: private task with an explicit Area choice, exactly one POST.
    await page.locator('[data-target-private-capture-fab="'+(width===390?"mobile":"desktop")+'"]').click();
    await page.getByTestId("target-capture-task-kind").click();
    await page.getByTestId("target-private-task-area").selectOption({label:store.seed.areaTitle});
    await page.getByTestId("target-private-task-form").getByRole("textbox",{name:"Název úkolu"}).fill(taskTitle);
    await page.getByTestId("target-private-task-save").click();
    await expect(page.getByTestId("target-private-task-created")).toBeVisible();
    expect(count(calls,"POST",/^\/api\/target-staging\/tasks$/)).toBe(1);

    // 3. A new task has no day yet; the detail sets When = today and it appears in My Plan.
    await page.getByTestId("target-private-task-open").click();
    await expect(detail).toBeVisible();
    await expect(detail).toContainText(taskTitle);
    await detail.getByTestId("target-detail-edit-when-today").click();
    await expect(detail.getByTestId("target-detail-edit-status")).toContainText(/\S/);
    await closeDetail();
    await expect(planRow(taskTitle)).toHaveCount(1);

    // 4. Mark done, then reopen with Undo.
    await page.getByRole("button",{name:"Dokončit úkol: "+taskTitle}).click();
    await expect(planRow(taskTitle)).toHaveCount(0);
    await page.getByRole("button",{name:"Vrátit dokončení (Undo)"}).click();
    await expect(planRow(taskTitle)).toHaveCount(1);

    // 5. When = tomorrow moves it into tomorrow's list.
    await page.getByRole("button",{name:"Naplánovat osobně na zítřek: "+taskTitle}).click();
    const tomorrow=page.locator("section.stagingMyPlanDay").nth(1);
    await expect(tomorrow.locator('[data-detail-row^="task:"]').filter({hasText:taskTitle})).toHaveCount(1);

    // 6. Open the task detail and rename it.
    await planRow(taskTitle).click();
    await expect(detail).toContainText(taskTitle);
    await detail.getByTestId("target-detail-edit-title").click();
    await detail.getByTestId("target-detail-edit-title-input").fill(taskRenamed);
    await detail.getByTestId("target-detail-edit-save").click();
    await expect(detail.getByRole("heading",{name:taskRenamed})).toBeVisible();
    await closeDetail();
    await expect(planRow(taskRenamed)).toHaveCount(1);

    // 7. Projects, scope Osobní: the seeded project; open it, see its task, rename it.
    await page.goto("/?view=Projects&scope=personal");
    const list=page.getByTestId("target-scope-list");
    await expect(list).toContainText(seed.projectTitle);
    await list.locator('[data-detail-row="project:'+seed.projectId+'"]').click();
    await expect(detail).toContainText(seed.taskTitle);
    await detail.getByTestId("target-project-title-edit").getByRole("button",{name:"Upravit název"}).click();
    await detail.getByTestId("target-project-title-edit").getByRole("textbox",{name:"Název projektu"}).fill(projectRenamed);
    await detail.getByTestId("target-project-title-edit").getByRole("button",{name:"Uložit změny"}).click();
    await expect(detail.getByRole("heading",{name:projectRenamed})).toBeVisible();
    await closeDetail();
    await expect(list).toContainText(projectRenamed);
    await expect(list).not.toContainText(seed.projectTitle);

    // 8. Notes: create a private note, open it, edit and save.
    await page.goto("/?view=Notes&scope=personal");
    await expect(page.getByTestId("target-scope-list")).toBeVisible();
    await page.locator('[data-target-private-capture-fab="'+(width===390?"mobile":"desktop")+'"]').click();
    await page.getByTestId("target-capture-note-kind").click();
    await page.getByTestId("target-private-area-select").selectOption({label:store.seed.areaTitle});
    const form=page.getByTestId("target-private-create-form");
    await form.getByRole("textbox",{name:"Název"}).fill(noteTitle);
    await form.getByRole("textbox",{name:"Text poznámky"}).fill("Tělo poznámky "+token);
    await form.getByTestId("target-private-create-save").click();
    await expect(page.getByRole("status").filter({hasText:"Vytvoření potvrzeno."})).toBeVisible();
    await page.getByTestId("target-private-note-areas").getByRole("button",{name:/Zavřít|Hotovo/}).first().click();
    const noteList=page.getByTestId("target-scope-list");
    await expect(noteList).toContainText(noteTitle);
    await noteList.getByRole("button",{name:new RegExp(noteTitle)}).click();
    await expect(detail).toContainText("Tělo poznámky "+token);
    await detail.getByTestId("target-detail-edit-note").click();
    await detail.getByTestId("target-detail-edit-note-title").fill(noteEdited);
    await detail.getByTestId("target-detail-edit-note-body").fill("Upravené tělo "+token);
    await detail.getByTestId("target-detail-edit-save").click();
    await expect(detail.getByRole("heading",{name:noteEdited})).toBeVisible();
    await expect(detail).toContainText("Upravené tělo "+token);
    await closeDetail();

    // 9. Main Search finds the renamed task, project and note by title.
    const search=async()=>{
      const input=page.locator(".searchField input");
      await input.fill(token);
      await input.press("Enter");
      return page.getByTestId("target-main-title-search");
    };
    let results=await search();
    await expect(results).toContainText(taskRenamed);
    await expect(results).toContainText(projectRenamed);
    await expect(results).toContainText(noteEdited);

    // 10. Full reload: everything is served from the server, not from client state.
    const before=calls.length;
    await page.goto("/?view=MyPlanPreview&scope=personal");
    await expect(planRow(taskRenamed)).toHaveCount(1);
    expect(calls.slice(before).some(call=>call.method==="GET"&&/\/my-plan\/slice$/.test(call.path))).toBe(true);
    const clientState=await page.evaluate(async()=>{
      const names=await indexedDB.databases();
      return JSON.stringify([Object.entries(localStorage),Object.entries(sessionStorage),names.map(db=>db.name)]);
    });
    expect(clientState).not.toContain(taskRenamed);
    await page.goto("/?view=Projects&scope=personal");
    await expect(page.getByTestId("target-scope-list")).toContainText(projectRenamed);
    await page.goto("/?view=Notes&scope=personal");
    await expect(page.getByTestId("target-scope-list")).toContainText(noteEdited);
    results=await search();
    await expect(results).toContainText(taskRenamed);
    await expect(results).toContainText(projectRenamed);
    await expect(results).toContainText(noteEdited);

    // 11. Delete the task and the note; they disappear from My Plan / Notes / Search.
    await page.goto("/?view=MyPlanPreview&scope=personal");
    await planRow(taskRenamed).click();
    await detail.getByTestId("target-detail-edit-delete").click();
    await detail.getByTestId("target-detail-edit-confirm-yes").click();
    await expect(detail.getByTestId("target-detail-edit-deleted")).toBeVisible();
    await closeDetail();
    await page.getByRole("button",{name:"Obnovit"}).click();
    await expect(planRow(taskRenamed)).toHaveCount(0);
    await page.goto("/?view=Notes&scope=personal");
    await page.getByTestId("target-scope-list").getByRole("button",{name:new RegExp(noteEdited)}).click();
    await detail.getByTestId("target-detail-edit-delete").click();
    await detail.getByTestId("target-detail-edit-confirm-yes").click();
    await expect(detail.getByTestId("target-detail-edit-deleted")).toBeVisible();
    await closeDetail();
    await expect(page.getByTestId("target-scope-list")).not.toContainText(noteEdited);
    results=await search();
    await expect(results).toContainText(projectRenamed);
    await expect(results).not.toContainText(taskRenamed);
    await expect(results).not.toContainText(noteEdited);

    // 12. Without the owner cookie the server refuses generically and no title stays in the DOM.
    await page.context().clearCookies();
    const refused=await page.request.get("/api/target-staging/my-plan/slice?evaluationDate=2026-01-01&areaFilter=all&limit=50");
    expect(refused.status()).toBe(401);
    expect(await refused.text()).not.toContain(projectRenamed);
    await page.evaluate(()=>window.dispatchEvent(new Event("focus")));
    await page.reload();
    await expect(page.getByText(projectRenamed)).toHaveCount(0);
    await expect(main.getByText(token)).toHaveCount(0);
  });
}
