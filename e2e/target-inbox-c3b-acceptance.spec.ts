/** C-3b exact real-store 390/1280 browser acceptance.
 * Explicit opt-in only; synthetic external consent fence and mock classifier,
 * no production state, credentials or OpenAI network. */
import {test,expect} from "./fixtures";
import {randomUUID} from "node:crypto";
import path from "node:path";
import {DatabaseSync} from "node:sqlite";
import type {Page} from "@playwright/test";
import {settingsSections,waitUntilSynced} from "./helpers";

test.skip(process.env.LUMI_TARGET_INBOX_C3B_E2E!=="true",
  "C-3b acceptance requires explicit isolated test opt-in");
const store=JSON.parse(process.env.LUMI_E2E_TARGET_STORE||"null") as {
  directory:string;restoreGeneration:string;ownerUserId:string;
  seed:{createAreaTitle:string;c3bProjects:Record<string,{
    projectId:string;projectTitle:string;taskId:string;taskTitle:string}>};
}|null;
const readTask=(id:string)=>{
  if(!store)throw Error("missing isolated SQLite");
  const db=new DatabaseSync(path.join(store.directory,"lumi-target.sqlite"),
    {readOnly:true});
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

for(const width of [390,1280]){
  test("C-3b real SQLite: explicit AI consent, Today+project+triage Accept/Undo, reload at "+
    width+"px",async({page})=>{
    test.setTimeout(220_000);
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
    await expect(toggle).not.toBeChecked();
    await toggle.check();
    await expect(toggle).toBeChecked({timeout:15000});

    await openInbox(page);
    const before=Number((await count(page).textContent())?.trim());
    expect(before).toBeGreaterThan(0);
    const suggestion=await locateRow(page,seeded.taskId);
    await expect(suggestion.getByRole("button",{name:"Proč tento návrh?"}))
      .toBeVisible({timeout:25000});
    await suggestion.getByRole("button",{name:"Proč tento návrh?"}).click();
    await expect(suggestion.locator(".targetInboxSuggestionWhy")).toBeVisible();
    const why=await suggestion.locator(".targetInboxSuggestionWhy").innerText();
    expect(why.length).toBeGreaterThan(8);
    await suggestion.getByRole("button",{name:"Přijmout"}).click();

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
    await expect(revokeToggle).toBeChecked({timeout:25000});
    await revokeToggle.uncheck();
    await expect(revokeToggle).not.toBeChecked({timeout:15000});
    if(width===1280){
      await page.goto("/?view=Settings");
      await waitUntilSynced(page);
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
