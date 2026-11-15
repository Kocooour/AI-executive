/** R3-A3: focused real-store My Plan acceptance. No route mocking.
 * Run only with LUMI_TARGET_PERSONAL_ACCEPTANCE_E2E=true and a Playwright
 * testMatch that includes target-personal-my-plan.spec.ts. */
import {test,expect} from "./fixtures";
import type {Page} from "@playwright/test";

test.skip(process.env.LUMI_TARGET_PERSONAL_ACCEPTANCE_E2E!=="true",
  "requires the isolated real target SQLite and authenticated owner profile");

const store=JSON.parse(process.env.LUMI_E2E_TARGET_STORE||"null") as
  {seed:{areaTitle:string}}|null;
const privateTaskId=(response:{request():{postDataJSON():unknown}}):string=>{
  const payload=response.request().postDataJSON() as Record<string,unknown>;
  if(typeof payload.taskId!=="string"||
    !/^[0-9a-f]{8}-[0-9a-f-]{27}$/.test(payload.taskId))
    throw Error("Real CREATE task ID was not provided");
  return payload.taskId;
};

for(const width of [390,1280]){
  test("private undated capture → plan → complete → Undo at "+width+"px",async({page}:{page:Page})=>{
    test.setTimeout(120_000);
    if(!store)throw Error("Real-store harness did not provision a target store");
    await page.setViewportSize({width,height:844});
    const title="Bez data "+width+" "+Math.random().toString(36).slice(2,9);
    const fab=page.locator('[data-target-private-capture-fab="'+(width===390?"mobile":"desktop")+'"]');
    const undated=page.getByRole("region",{name:"Bez data"});
    const today=page.getByRole("region",{name:/^Dnes a dřívější/});
    const taskRow=(id:string)=>page.locator('[data-detail-row="task:'+id+'"]');

    // Observe real requests, but never route/fulfill/mutate them.
    const paths:string[]=[];
    page.on("request",req=>{
      const path=new URL(req.url()).pathname;
      if(path.startsWith("/api/target-staging/"))paths.push(req.method()+" "+path);
    });
    await page.goto("/?view=MyPlanPreview&scope=personal");
    await expect(page.getByTestId("target-my-plan")).toBeVisible();
    await expect(undated).toBeVisible();
    await fab.click();
    await page.getByTestId("target-capture-task-kind").click();
    await page.getByTestId("target-private-task-area").selectOption({label:store.seed.areaTitle});
    await page.getByTestId("target-private-task-form").getByRole("textbox",{name:"Název úkolu"}).fill(title);
    const create=page.waitForResponse(response=>
      response.request().method()==="POST"&&
      new URL(response.url()).pathname==="/api/target-staging/tasks");
    await page.getByTestId("target-private-task-save").click();
    const created=await create;
    expect(created.status()).toBe(201);
    const id=privateTaskId(created);
    await expect(page.getByTestId("target-private-task-created")).toBeVisible();
    await page.getByRole("button",{name:"Skrýt"}).click();
    await expect(undated.locator('[data-detail-row="task:'+id+'"]')).toHaveCount(1);
    await expect(today.locator('[data-detail-row="task:'+id+'"]')).toHaveCount(0);

    // A full reload must serve the same task from the real SQLite store.
    await page.reload();
    await expect(page.getByTestId("target-my-plan")).toBeVisible();
    await expect(undated.locator('[data-detail-row="task:'+id+'"]')).toHaveCount(1);
    await page.getByRole("button",{name:"Naplánovat osobně na dnešek: "+title}).click();
    await expect(today.locator('[data-detail-row="task:'+id+'"]')).toHaveCount(1);
    await expect(undated.locator('[data-detail-row="task:'+id+'"]')).toHaveCount(0);
    await page.getByRole("button",{name:"Dokončit úkol: "+title}).click();
    await expect(taskRow(id)).toHaveCount(0);
    await page.getByRole("button",{name:"Vrátit dokončení (Undo)"}).click();
    await expect(today.locator('[data-detail-row="task:'+id+'"]')).toHaveCount(1);
    await expect(undated.locator('[data-detail-row="task:'+id+'"]')).toHaveCount(0);
    expect(paths.filter(p=>p==="POST /api/target-staging/tasks")).toHaveLength(1);
    expect(paths.some(p=>p==="GET /api/target-staging/my-plan/slice")).toBe(true);
    expect(paths.some(p=>p==="PATCH /api/target-staging/task-temporal/status")).toBe(true);
  });
}
