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

for(const width of [390,1280]){
  test("C-3a: real Process/receipt/Undo + detail URL, Back/Forward, Quick Capture at "+width+"px",
  async({page})=>{
    test.setTimeout(180_000);
    if(!store)throw Error("Missing isolated C-3a SQLite store");
    await page.setViewportSize({width,height:844});
    const seeded=store.seed.projects[String(width)];
    await openInbox(page);
    await expect(count(page)).toBeVisible();
    await expect(row(page,seeded.taskId)).toBeVisible();
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
    await expect(row(page,seeded.taskId)).toBeVisible();
    await page.goForward();
    await expect(page.getByTestId("target-detail")).toContainText(seeded.taskTitle);
    await page.reload();
    await expect(page.getByTestId("target-detail")).toContainText(seeded.taskTitle);
    await page.getByTestId("target-detail").locator("button.inspectorClose").click();
    await expect(page.getByTestId("target-detail")).toHaveCount(0);

    // Process changes triage only; the existing task disappears from the
    // authorized count, Undo is linked to the *receipt-confirmed* Process.
    await processAction(page,seeded.taskTitle).click();
    await expect(row(page,seeded.taskId)).toHaveCount(0);
    await expect.poll(()=>opaqueCount(page)).toBe(before-1);
    await page.getByRole("button",{name:"Vrátit do Inboxu (Undo)"}).click();
    await expect(row(page,seeded.taskId)).toBeVisible();
    await expect.poll(()=>opaqueCount(page)).toBe(before);
    await page.reload();
    await expect(row(page,seeded.taskId)).toBeVisible();

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
    await openInbox(page);
    await expect(row(page,taskId)).toContainText(title);
    await expect.poll(()=>opaqueCount(page)).toBe(before+1);
  });
}

test("C-3a: uncertain write never resends its UUID and hides both row and navigation count",
async({page})=>{
  test.setTimeout(90_000);
  if(!store)throw Error("Missing isolated C-3a SQLite store");
  await page.setViewportSize({width:390,height:844});
  const title=store.seed.projects["390"].taskTitle;
  await openInbox(page);
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
  expect(commands).toBe(1);
  expect(receipts).toBeGreaterThanOrEqual(2);
  await page.unroute("**/api/target-staging/inbox/triage",abortWrite);
  await page.reload();
  await expect(processAction(page,title)).toBeVisible();
});
