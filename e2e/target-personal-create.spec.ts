/** R3 A/3: real target SQLite + Next endpoints, 390/1280 px.
 * No mocked API responses. Only the final scenario drops one REAL 201
 * response after forwarding the POST to the server to exercise recovery.
 * Synthetic fixture IDs for this spec contain ":create:". */
import {test,expect} from "./fixtures";
import type {Page} from "@playwright/test";

test.skip(process.env.LUMI_TARGET_PERSONAL_ACCEPTANCE_E2E!=="true",
  "Requires isolated real target store and full personal profile flags");
const store=JSON.parse(process.env.LUMI_E2E_TARGET_STORE||"null") as
  {seed:{createAreaTitle:string;createLargeProjectId:string}}|null;
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
    // Reload discards the original private command, retaining ONLY the opaque
    // tab marker. Recovery must use create-recovery, never resend the create.
    await page.reload();
    await expect(page.getByTestId("target-scope-list")).toHaveAttribute("data-state","ready");
    await page.getByTestId("target-project-create-open").click();
    await expect(page.getByTestId("target-structure-unresolved")).toBeVisible();
    await page.getByTestId("target-structure-verify").click();
    await expect(page.getByTestId("target-structure-unresolved")).toHaveCount(0);
    await expect(page.getByTestId("target-scope-list")).toContainText(uncertainTitle);
    expect(count(calls,"POST",projectPath)-initial).toBe(1);
    expect(count(calls,"POST",projectPath+"/create-recovery")).toBeGreaterThan(0);
  });
}

/** The author-visible success affordance must not depend on the first page of
 * a 35-task project. All tasks are real SQLite rows, not mocked responses. */
for(const width of [390,1280]){
  test("A/3: open newly created child beyond first paginated page at "+width+"px",async({page})=>{
    test.setTimeout(150_000);
    if(!store)throw Error("No isolated target fixture");
    await page.setViewportSize({width,height:844});
    await page.goto("/?view=Projects&scope=personal");
    const list=page.getByTestId("target-scope-list");
    await expect(list).toHaveAttribute("data-state","ready");
    await list.locator('[data-detail-row="project:'+store.seed.createLargeProjectId+'"]').click();
    const detail=detailTask(page);
    await expect(detail).toHaveAttribute("data-detail-kind","project");
    await expect(detail).toContainText("Previously created task 0");
    await detail.getByTestId("target-project-task-create-open").click();
    const title="Page overflow "+width+" "+Math.random().toString(36).slice(2);
    await detail.getByTestId("target-project-task-create-form")
      .getByRole("textbox",{name:"Název"}).fill(title);
    const pending=page.waitForResponse(r=>r.request().method()==="POST"&&
      new URL(r.url()).pathname===childPath);
    await detail.getByTestId("target-project-task-create-save").click();
    const response=await pending;
    expect(response.status()).toBe(201);
    const {taskId,projectId}=response.request().postDataJSON() as Record<string,string>;
    expect(projectId).toBe(store.seed.createLargeProjectId);
    await expect(detail.getByTestId("target-project-task-created-open")).toBeVisible();
    // UUID sorts AFTER the 0-create:000..034 fixture: no row on first page.
    await expect(detail.locator('[data-detail-row="task:'+taskId+'"]')).toHaveCount(0);
    await detail.getByTestId("target-project-task-created-open").click();
    await expect(detail).toHaveAttribute("data-detail-kind","task");
    await expect(detail).toContainText(title);
    await page.reload();
    await expect(detail).toHaveAttribute("data-detail-kind","task");
    await expect(detail).toContainText(title);
  });
  test("A/3: terminally cancel an undelivered project create at "+width+"px",async({page})=>{
    test.setTimeout(150_000);
    if(!store)throw Error("No isolated target fixture");
    await page.setViewportSize({width,height:844});
    await page.goto("/?view=Projects&scope=personal");
    await expect(page.getByTestId("target-scope-list")).toHaveAttribute("data-state","ready");
    await page.getByTestId("target-project-create-open").click();
    await page.getByTestId("target-project-create-area")
      .selectOption({label:store.seed.createAreaTitle});
    await page.getByTestId("target-project-create-form")
      .getByRole("textbox",{name:"Název"}).fill("Undelivered "+width);
    const calls=observe(page),initial=count(calls,"POST",projectPath);
    // Fault injection only: abort BEFORE forwarding the original POST.
    await page.route("**/api/target-staging/projects",route=>{
      if(route.request().method()==="POST")return route.abort("failed");
      return route.continue();
    },{times:1});
    await page.getByTestId("target-project-create-save").click();
    await expect(page.getByTestId("target-structure-unresolved")).toBeVisible();
    expect(count(calls,"POST",projectPath)-initial).toBe(1);
    await page.reload();
    await expect(page.getByTestId("target-scope-list")).toHaveAttribute("data-state","ready");
    await page.getByTestId("target-project-create-open").click();
    await expect(page.getByTestId("target-structure-unresolved")).toBeVisible();
    const cancelled=page.waitForResponse(r=>r.request().method()==="POST"&&
      new URL(r.url()).pathname===projectPath+"/create-cancel");
    await page.getByTestId("target-structure-cancel").click();
    const proof=await cancelled;
    expect(proof.status()).toBe(200);
    expect(await proof.json()).toEqual({status:"cancelled"});
    await expect(page.getByTestId("target-structure-unresolved")).toHaveCount(0);
    // The same tab is now safely free to create with a NEW command UUID.
    await page.getByTestId("target-project-create-area")
      .selectOption({label:store.seed.createAreaTitle});
    const after="After cancellation "+width+" "+Math.random().toString(36).slice(2);
    await page.getByTestId("target-project-create-form")
      .getByRole("textbox",{name:"Název"}).fill(after);
    const created=page.waitForResponse(r=>r.request().method()==="POST"&&
      new URL(r.url()).pathname===projectPath);
    await page.getByTestId("target-project-create-save").click();
    expect((await created).status()).toBe(201);
    await expect(page.getByTestId("target-project-created-open")).toBeVisible();
    await page.getByTestId("target-project-created-open").click();
    await expect(detailTask(page)).toHaveAttribute("data-detail-kind","project");
    await expect(detailTask(page)).toContainText(after);
  });
}

/** A terminal 'settled' fence means CREATE committed, never "cancelled".
 * The UI must recover the original server-authorized ID, not invite duplication. */
for(const width of [390,1280]){
  test("A/3: settled creation opens the original project at "+width+"px",async({page})=>{
    test.setTimeout(150_000);
    if(!store)throw Error("No isolated target fixture");
    await page.setViewportSize({width,height:844});
    await page.goto("/?view=Projects&scope=personal");
    await expect(page.getByTestId("target-scope-list")).toHaveAttribute("data-state","ready");
    const title="Settled project "+width+" "+Math.random().toString(36).slice(2);
    await page.getByTestId("target-project-create-open").click();
    await page.getByTestId("target-project-create-area")
      .selectOption({label:store.seed.createAreaTitle});
    await page.getByTestId("target-project-create-form")
      .getByRole("textbox",{name:"Název"}).fill(title);
    let originalId="";
    await page.route("**/api/target-staging/projects",async route=>{
      const response=await route.fetch();
      expect(response.status()).toBe(201);
      const payload=await response.json() as {id:string};
      originalId=payload.id;
      await route.abort("failed");
    },{times:1});
    await page.getByTestId("target-project-create-save").click();
    await expect(page.getByTestId("target-structure-unresolved")).toBeVisible();
    const settled=page.waitForResponse(r=>r.request().method()==="POST"&&
      new URL(r.url()).pathname===projectPath+"/create-cancel");
    await page.getByTestId("target-structure-cancel").click();
    const proof=await settled;
    expect(proof.status()).toBe(200);
    // The UI's validated 'settled' state + navigable original ID are the
    // authoritative assertions. Reading the POST response body *after*
    // navigation can race with Chromium's Network.getResponseBody eviction.
    await expect(page.getByTestId("target-structure-unresolved")).toHaveCount(0);
    await expect(page.getByText("Původní vytvoření se dokončilo. Položku lze otevřít."))
      .toBeVisible();
    await expect(page.getByTestId("target-project-created-open")).toBeVisible();
    await page.getByTestId("target-project-created-open").click();
    await expect(detailTask(page)).toHaveAttribute("data-detail-kind","project");
    await expect(detailTask(page)).toContainText(title);
    expect(new URL(page.url()).searchParams.get("projectId")).toBe(originalId);
  });
}

for(const width of [390,1280]){
  test("A/3: recovering child from another context preserves parent "+width,async({page})=>{
    test.setTimeout(180_000);
    if(!store)throw Error("Missing isolated store");
    await page.setViewportSize({width,height:844});
    const a=store.seed.createLargeProjectId,home="/?view=Projects&scope=personal";
    const detail=detailTask(page),list=page.getByTestId("target-scope-list");
    const calls=observe(page);
    await page.goto(home);
    await expect(list).toHaveAttribute("data-state","ready");
    let bUrl="";
    if(width===390){
      await page.getByTestId("target-project-create-open").click();
      await page.getByTestId("target-project-create-area")
        .selectOption({label:store.seed.createAreaTitle});
      const bTitle="Second project "+Math.random();
      await page.getByTestId("target-project-create-form").getByRole("textbox",{name:"Název"}).fill(bTitle);
      await page.getByTestId("target-project-create-save").click();
      await expect(page.getByTestId("target-project-created-open")).toBeVisible();
      await page.getByTestId("target-project-created-open").click();
      await expect(detail).toContainText(bTitle);
      bUrl=page.url();
      expect(new URL(bUrl).searchParams.get("projectId")).not.toBe(a);
      await page.goto(home);
      await expect(list).toHaveAttribute("data-state","ready");
    }
    await list.locator('[data-detail-row="project:'+a+'"]').click();
    await expect(detail).toHaveAttribute("data-detail-kind","project");
    await detail.getByTestId("target-project-task-create-open").click();
    const title="Cross-project task "+width+" "+Math.random();
    await detail.getByTestId("target-project-task-create-form")
      .getByRole("textbox",{name:"Název"}).fill(title);
    let taskId="",forwarded=0;
    await page.route("**/api/target-staging/project-tasks",async route=>{
      const body=route.request().postDataJSON() as {projectId:string;taskId:string};
      expect(body.projectId).toBe(a);
      const response=await route.fetch();
      expect(response.status()).toBe(201);
      taskId=body.taskId;
      await route.abort("failed");
      // The original CREATE is fully committed and the reply has been dropped.
      // The marker can appear BEFORE the async route handler finishes.
      forwarded++;
    },{times:1});
    await detail.getByTestId("target-project-task-create-save").click();
    await expect(detail.getByTestId("target-structure-unresolved")).toBeVisible();
    await expect.poll(()=>forwarded,{timeout:20_000}).toBe(1);
    expect(count(calls,"POST",childPath)).toBe(1);
    // Only now is it safe to navigate away without aborting the real POST.
    await page.goto(width===390?bUrl:home);
    if(width===390){
      await expect(detail).toHaveAttribute("data-detail-kind","project");
      await detail.getByTestId("target-project-task-create-open").click();
    }else{
      await expect(list).toHaveAttribute("data-state","ready");
      await page.getByTestId("target-project-create-open").click();
    }
    await expect(page.getByTestId("target-structure-unresolved")).toBeVisible();
    await page.getByTestId(width===390?"target-structure-verify":"target-structure-cancel").click();
    await expect(page.getByTestId("target-structure-unresolved")).toHaveCount(0);
    await page.getByTestId("target-project-task-created-open").click();
    await expect(detail).toHaveAttribute("data-detail-kind","task");
    await expect(detail).toContainText(title);
    const taskUrl=page.url();
    expect(taskUrl).toContain(taskId);
    expect(new URL(taskUrl).searchParams.get("projectId")).toBe(a);
    expect(forwarded).toBe(1);
    expect(count(calls,"POST",childPath)).toBe(1);
    await detail.locator(".targetDetailParent .targetDetailLink").click();
    await expect(detail).toHaveAttribute("data-detail-kind","project");
    expect(new URL(page.url()).searchParams.get("projectId")).toBe(a);
    await page.goto(taskUrl);
    await expect(detail).toHaveAttribute("data-detail-kind","task");
    await detail.locator("button.inspectorClose").click();
    await expect(detail).toHaveAttribute("data-detail-kind","project");
    expect(new URL(page.url()).searchParams.get("projectId")).toBe(a);
  });
}
