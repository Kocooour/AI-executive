/** R3 A/3: real target SQLite + Next endpoints, 390/1280 px.
 * No mocked API responses. Only the final scenario drops one REAL 201
 * response after forwarding the POST to the server to exercise recovery.
 * Synthetic fixture IDs for this spec contain ":create:". */
import {test,expect} from "./fixtures";
import type {Page} from "@playwright/test";

test.skip(process.env.LUMI_TARGET_PERSONAL_ACCEPTANCE_E2E!=="true",
  "Requires isolated real target store and full personal profile flags");
const store=JSON.parse(process.env.LUMI_E2E_TARGET_STORE||"null") as
  {seed:{createAreaTitle:string}}|null;
const projectPath="/api/target-staging/projects";
const childPath="/api/target-staging/project-tasks";
const count=(pageCalls:{method:string;path:string}[],method:string,path:string)=>
  pageCalls.filter(c=>c.method===method&&c.path===path).length;
function observe(page:Page){
  const calls:{method:string;path:string}[]=[];
  page.on("request",request=>{
    const path=new URL(request.url()).pathname;
    if(path.startsWith("/api/target-staging/"))
      calls.push({method:request.method(),path});
  });
  return calls;
}
const detailTask=(page:Page)=>page.getByTestId("target-detail");

for(const width of [390,1280]){
  test("A/3: create private project and child task through main UI at "+width+"px",async({page})=>{
    test.setTimeout(150_000);
    if(!store)throw Error("No isolated target fixture");
    await page.setViewportSize({width,height:844});
    const calls=observe(page);
    const nonce="create"+width+"-"+Math.random().toString(36).slice(2,9);
    const projectTitle="Projekt "+nonce,taskTitle="Úkol "+nonce;
    await page.goto("/?view=Projects&scope=personal");
    const list=page.getByTestId("target-scope-list");
    await expect(list).toHaveAttribute("data-state","ready");

    await page.getByTestId("target-project-create-open").click();
    const projectForm=page.getByTestId("target-project-create-form");
    await page.getByTestId("target-project-create-area")
      .selectOption({label:store.seed.createAreaTitle});
    await projectForm.getByRole("textbox",{name:"Název"}).fill(projectTitle);
    const newProject=page.waitForResponse(response=>response.request().method()==="POST"&&
      new URL(response.url()).pathname===projectPath);
    await page.getByTestId("target-project-create-save").click();
    const projectResponse=await newProject;
    expect(projectResponse.status()).toBe(201);
    const projectPayload=projectResponse.request().postDataJSON() as Record<string,string>;
    expect(projectPayload.projectId).toMatch(/^[a-f0-9-]{36}$/);
    expect(projectPayload.areaId).toBe("area:e2e:create:private");
    expect(count(calls,"POST",projectPath)).toBe(1);
    await expect(list).toContainText(projectTitle);
    const projectId=projectPayload.projectId;
    await list.locator('[data-detail-row="project:'+projectId+'"]').click();
    const detail=detailTask(page);
    await expect(detail).toHaveAttribute("data-detail-kind","project");
    await expect(detail).toContainText(projectTitle);

    await detail.getByTestId("target-project-task-create-open").click();
    const taskForm=detail.getByTestId("target-project-task-create-form");
    await taskForm.getByRole("textbox",{name:"Název"}).fill(taskTitle);
    const newTask=page.waitForResponse(response=>response.request().method()==="POST"&&
      new URL(response.url()).pathname===childPath);
    await detail.getByTestId("target-project-task-create-save").click();
    const taskResponse=await newTask;
    expect(taskResponse.status()).toBe(201);
    const taskPayload=taskResponse.request().postDataJSON() as Record<string,string>;
    expect(taskPayload.taskId).toMatch(/^[a-f0-9-]{36}$/);
    expect(taskPayload.projectId).toBe(projectId);
    expect(Object.keys(taskPayload).sort()).toEqual([
      "commandId","projectId","restoreGeneration","taskId","title"]);
    expect(count(calls,"POST",childPath)).toBe(1);
    const taskId=taskPayload.taskId;
    await expect(detail.locator('[data-detail-row="task:'+taskId+'"]')).toBeVisible();
    await detail.locator('[data-detail-row="task:'+taskId+'"]').click();
    await expect(detail).toHaveAttribute("data-detail-kind","task");
    await expect(detail).toContainText(taskTitle);
    await detail.getByTestId("target-detail-edit-when-today").click();
    await expect(detail.getByTestId("target-detail-edit-status"))
      .toContainText("Termín „Kdy“ je uložen.");
    await page.goto("/?view=MyPlanPreview&scope=personal");
    await expect(page.getByTestId("target-my-plan")).toContainText(taskTitle);

    // Neither record came from optimistic state: reload forces fresh SQLite reads.
    await page.reload();
    await expect(page.getByTestId("target-my-plan")).toContainText(taskTitle);
    await page.goto("/?view=Projects&scope=personal");
    await expect(page.getByTestId("target-scope-list")).toContainText(projectTitle);
    await page.getByTestId("target-scope-list")
      .locator('[data-detail-row="project:'+projectId+'"]').click();
    await expect(detail.locator('[data-detail-row="task:'+taskId+'"]')).toBeVisible();

    // Shared scope never exposes project create.
    await page.goto("/?view=Projects&scope=shared");
    await expect(page.getByTestId("target-scope-list")).toHaveAttribute("data-state","ready");
    await expect(page.getByTestId("target-project-create-open")).toHaveCount(0);

    // Drop just the response AFTER the real POST is committed. No response
    // fixture and no API mock: Chromium observes a genuine network failure.
    await page.goto("/?view=Projects&scope=personal");
    await expect(page.getByTestId("target-scope-list")).toHaveAttribute("data-state","ready");
    const uncertainTitle="Nejistý "+nonce;
    await page.getByTestId("target-project-create-open").click();
    await page.getByTestId("target-project-create-area")
      .selectOption({label:store.seed.createAreaTitle});
    await page.getByTestId("target-project-create-form")
      .getByRole("textbox",{name:"Název"}).fill(uncertainTitle);
    let forwarded=0;
    await page.route("**/api/target-staging/projects",async route=>{
      forwarded++;
      const response=await route.fetch();
      expect(response.status()).toBe(201);
      await route.abort("failed");
    },{times:1});
    const initial=count(calls,"POST",projectPath);
    await page.getByTestId("target-project-create-save").click();
    await expect(page.getByTestId("target-structure-unresolved")).toBeVisible();
    expect(forwarded).toBe(1);
    expect(count(calls,"POST",projectPath)-initial).toBe(1);
    await page.getByTestId("target-structure-verify").click();
    await expect(page.getByTestId("target-structure-unresolved")).toHaveCount(0);
    await expect(page.getByTestId("target-scope-list")).toContainText(uncertainTitle);
    expect(count(calls,"POST",projectPath)-initial).toBe(1);
    expect(count(calls,"POST",projectPath+"/create-status")+
      count(calls,"POST",projectPath+"/create-recovery")).toBeGreaterThan(0);
  });
}
