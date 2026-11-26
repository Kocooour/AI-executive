/** #397: real-store Undo of a just-created Quick Capture task. No route mocking.
 * Run only with LUMI_TARGET_PERSONAL_ACCEPTANCE_E2E=true (personal-v1 profile,
 * isolated target SQLite); the Playwright testMatch includes this file. */
import {test,expect} from "./fixtures";
import type {Page} from "@playwright/test";

test.skip(process.env.LUMI_TARGET_PERSONAL_ACCEPTANCE_E2E!=="true",
  "requires the isolated real target SQLite and authenticated owner profile");

const store=JSON.parse(process.env.LUMI_E2E_TARGET_STORE||"null") as
  {seed:{areaTitle:string}}|null;

async function capture(page:Page,width:number,title:string):Promise<string>{
  if(!store)throw Error("Real-store harness did not provision a target store");
  await page.locator('[data-target-private-capture-fab="'+(width===390?"mobile":"desktop")+'"]').click();
  await page.getByTestId("target-capture-task-kind").click();
  await page.getByTestId("target-private-task-area").selectOption({label:store.seed.areaTitle});
  await page.getByTestId("target-private-task-form").getByRole("textbox",{name:"Název úkolu"}).fill(title);
  const create=page.waitForResponse(response=>
    response.request().method()==="POST"&&
    new URL(response.url()).pathname==="/api/target-staging/tasks");
  await page.getByTestId("target-private-task-save").click();
  const created=await create;
  expect(created.status()).toBe(201);
  const payload=created.request().postDataJSON() as Record<string,unknown>;
  if(typeof payload.taskId!=="string")throw Error("Real CREATE task ID was not provided");
  return payload.taskId;
}
function observeWrites(page:Page){
  const paths:string[]=[];
  page.on("request",req=>{
    const path=new URL(req.url()).pathname;
    if(path.startsWith("/api/target-staging/")&&req.method()!=="GET")paths.push(req.method()+" "+path);
  });
  return paths;
}

for(const width of [390,1280]){
  test("Quick Capture Undo removes the unchanged task once at "+width+"px",async({page})=>{
    test.setTimeout(120_000);
    await page.setViewportSize({width,height:844});
    const writes=observeWrites(page);
    const title="Undo "+width+" "+Math.random().toString(36).slice(2,9);
    const undated=page.getByRole("region",{name:"Bez data"});
    await page.goto("/?view=MyPlanPreview&scope=personal");
    await expect(page.getByTestId("target-my-plan")).toBeVisible();
    const id=await capture(page,width,title);
    const notice=page.getByTestId("target-private-task-created");
    await expect(notice).toBeVisible();
    await expect(undated.locator('[data-detail-row="task:'+id+'"]')).toHaveCount(1);
    const undo=notice.getByTestId("target-private-task-undo");
    await expect(undo).toBeEnabled();
    await undo.click();
    await expect(notice.getByTestId("target-private-task-undo-result"))
      .toHaveText("Úkol byl odstraněn.");
    await expect(notice).toBeFocused();
    await expect(notice.getByTestId("target-private-task-undo")).toHaveCount(0);
    await expect(notice.getByTestId("target-private-task-open")).toHaveCount(0);
    await expect(undated.locator('[data-detail-row="task:'+id+'"]')).toHaveCount(0);
    // The deletion is durable in the real SQLite store.
    await page.reload();
    await expect(page.getByTestId("target-my-plan")).toBeVisible();
    await expect(page.locator('[data-detail-row="task:'+id+'"]')).toHaveCount(0);
    expect(writes.filter(p=>p==="POST /api/target-staging/tasks")).toHaveLength(1);
    expect(writes.filter(p=>p==="POST /api/target-staging/tasks/"+id+"/delete")).toHaveLength(1);
    expect(page.url()).not.toContain(title);
  });

  test("Quick Capture Undo refuses a task completed after creation at "+width+"px",async({page})=>{
    test.setTimeout(120_000);
    await page.setViewportSize({width,height:844});
    const writes=observeWrites(page);
    const title="Undo změna "+width+" "+Math.random().toString(36).slice(2,9);
    await page.goto("/?view=MyPlanPreview&scope=personal");
    await expect(page.getByTestId("target-my-plan")).toBeVisible();
    const id=await capture(page,width,title);
    const notice=page.getByTestId("target-private-task-created");
    await expect(notice.getByTestId("target-private-task-undo")).toBeEnabled();
    // Completion changes the task revision. Row absence alone is not a
    // commit witness: the plan also conceals its rows while revalidating.
    const completion=page.waitForResponse(response=>
      response.request().method()==="PATCH"&&
      new URL(response.url()).pathname==="/api/target-staging/task-temporal/status"&&
      response.request().postDataJSON()?.taskId===id,{timeout:35_000});
    await page.getByRole("button",{name:"Dokončit úkol: "+title}).click();
    const completed=await completion;
    await expect(page.getByRole("status").filter({hasText:"Dokončení potvrzeno."}),
      "Completion PATCH HTTP "+completed.status()).toBeVisible({timeout:35_000});
    await expect(page.getByRole("button",{name:"Vrátit dokončení (Undo)"})).toBeEnabled();
    await expect(page.locator('[data-detail-row="task:'+id+'"]')).toHaveCount(0);
    // Observe the actual fresh read made by creation Undo, not a mocked
    // response or a permissive assertion accepting an unrelated refusal.
    const preview=page.waitForResponse(response=>{
      const url=new URL(response.url());
      return response.request().method()==="GET"&&
        url.pathname==="/api/target-staging/task-temporal/detail"&&url.searchParams.get("taskId")===id;
    },{timeout:20_000});
    await notice.getByTestId("target-private-task-undo").click();
    const seen=await preview;
    expect(seen.status(),"Creation Undo must read the completed task").toBe(200);
    expect((await seen.json()).task).toMatchObject({id,status:"completed"});
    await expect(notice.getByTestId("target-private-task-undo-result"))
      .toContainText("Úkol se mezitím změnil",{timeout:20_000});
    expect(writes.filter(p=>p.endsWith("/tasks/"+id+"/delete"))).toHaveLength(0);
    // The completed task still exists and its own completion Undo still works.
    await page.getByRole("button",{name:"Vrátit dokončení (Undo)"}).click();
    await expect(page.getByRole("status").filter({hasText:"Obnovení potvrzeno."})).toBeVisible({timeout:35_000});
    await expect(page.locator('[data-detail-row="task:'+id+'"]')).toHaveCount(1,{timeout:25_000});
  });
}
