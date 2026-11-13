/** Milestone A/3 Search-to-detail acceptance on a REAL isolated target SQLite.
 * Requires the personal acceptance store profile. Never intercepts or mocks
 * /api/target-staging: access checks and writes are real route-handler calls.
 * Config's testMatch must include this file for the opt-in real-store run.
 */
import {test,expect} from "./fixtures";
import {DatabaseSync} from "node:sqlite";
import {realpathSync} from "node:fs";
import path from "node:path";

test.skip(process.env.LUMI_TARGET_PERSONAL_ACCEPTANCE_E2E!=="true",
  "Search-open acceptance requires the isolated personal-v1 target store");

type Seed={
  areaId:string;
  searchProjects:Record<string,{
    projectId:string;projectTitle:string;taskId:string;taskTitle:string;
  }>;
  revokeProjects:Record<string,{
    areaId:string;projectId:string;projectTitle:string;
  }>;
};
const store=JSON.parse(process.env.LUMI_E2E_TARGET_STORE||"null") as {
  directory:string;ownerUserId:string;seed:Seed;
}|null;

// Only the isolated personal-v1 store created by Playwright can be changed.
// This test never opens a production database or intercepts a target API.
function removeTestViewerMembership(areaId:string):void{
  if(!store||!process.env.LUMI_E2E_RUN_DIR)throw new Error("Missing isolated test store");
  const run=realpathSync(process.env.LUMI_E2E_RUN_DIR);
  if(realpathSync(store.directory)!==path.join(run,"target-store")||
    store.ownerUserId!=="e2e-owner")throw new Error("Refusing non-test ACL mutation");
  const db=new DatabaseSync(path.join(store.directory,"lumi-target.sqlite"));
  try{
    db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000");
    const result=db.prepare(
      "DELETE FROM area_members WHERE area_id=? AND user_id=? AND role='viewer'"
    ).run(areaId,store.ownerUserId);
    expect(result.changes).toBe(1);
  }finally{db.close();}
}

// Paginated Search needs >25 real authorized rows. Seed a unique private
// project set only for this isolated, serial real-store browser scenario. No
// target HTTP endpoints are intercepted and no production paths are accessed.
function seedPagingProjects(width:number):void{
  if(!store||!process.env.LUMI_E2E_RUN_DIR)throw new Error("Missing isolated test store");
  const run=realpathSync(process.env.LUMI_E2E_RUN_DIR);
  if(realpathSync(store.directory)!==path.join(run,"target-store")||
    store.ownerUserId!=="e2e-owner")throw new Error("Refusing non-test paging seed");
  const db=new DatabaseSync(path.join(store.directory,"lumi-target.sqlite"));
  try{
    db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000");
    const area=db.prepare(
      "SELECT id FROM areas WHERE id=? AND kind='private' AND owner_user_id=?"
    ).get(store.seed.areaId,store.ownerUserId);
    if(!area)throw new Error("Missing authorized private test Area");
    const insert=db.prepare("INSERT INTO projects(id,area_id,title) VALUES (?,?,?)");
    db.exec("BEGIN");
    try{
      for(let n=1;n<=27;n++){
        const suffix=String(n).padStart(2,"0");
        insert.run(`project:e2e:paging:${width}:${suffix}`,store.seed.areaId,
          `Paging ${width} return ${suffix}`);
      }
      db.exec("COMMIT");
    }catch(error){db.exec("ROLLBACK");throw error;}
  }finally{db.close();}
}

for(const width of [390,1280]){
  test("real-store Search opens all three authorized kinds and returns focus at "+width+"px",
    async({page})=>{
      test.setTimeout(180_000);
      if(!store)throw new Error("The isolated target store was not created");
      const seed=store.seed.searchProjects[String(width)];
      const token="search-open-"+width+"-"+Math.random().toString(36).slice(2,8);
      const noteTitle="Seed poznámka "+token;
      const taskEdited="Seed úkol upravený "+token;
      const target=page.getByTestId("target-detail");
      await page.setViewportSize({width,height:844});

      // Use the actual authorized Quick Capture API to create the note. Seed
      // already contains a private project and child task for this viewport.
      await page.goto("/?view=Notes&scope=personal");
      await expect(page.getByTestId("target-scope-list")).toHaveAttribute("data-state","ready");
      const fab=page.locator('[data-target-private-capture-fab="'+(width===390?"mobile":"desktop")+'"]');
      await fab.click();
      await page.getByTestId("target-capture-note-kind").click();
      await page.getByTestId("target-private-area-select").selectOption({label:"Rodina"});
      const form=page.getByTestId("target-private-create-form");
      await form.getByRole("textbox",{name:"Název"}).fill(noteTitle);
      await form.getByRole("textbox",{name:"Text poznámky"}).fill("Soukromé tělo "+token);
      const post=page.waitForResponse(response=>
        response.request().method()==="POST"&&
        new URL(response.url()).pathname==="/api/target-staging/notes");
      await form.getByTestId("target-private-create-save").click();
      const saved=await post;
      expect(saved.status()).toBe(201);
      const noteId=(saved.request().postDataJSON() as Record<string,string>).noteId;
      await expect(page.getByTestId("target-private-note-areas")).toHaveCount(0);

      const input=page.locator(".searchField input");
      await input.fill("Seed");
      const search=page.getByTestId("target-main-title-search");
      await expect(search).toBeVisible();
      await input.press("Enter");
      await expect(search).toContainText(seed.projectTitle);
      await expect(search).toContainText(seed.taskTitle);
      await expect(search).toContainText(noteTitle);

      const cases=[
        {kind:"project",id:seed.projectId,title:seed.projectTitle},
        {kind:"task",id:seed.taskId,title:seed.taskTitle},
        {kind:"note",id:noteId,title:noteTitle},
      ] as const;
      for(const entry of cases){
        const row=search.locator('[data-detail-row="'+entry.kind+':'+entry.id+'"]');
        await expect(row).toBeVisible();
        await expect(row).toHaveJSProperty("tagName","BUTTON");
        await row.focus();
        await row.press("Enter");
        await expect(target).toBeVisible();
        await expect(target).toContainText(entry.title);
        await expect(page).toHaveURL(new RegExp(entry.kind==="task"?"taskId=":
          entry.kind==="project"?"projectId=":"noteId="));
        if(entry.kind==="task"){
          await target.getByTestId("target-detail-edit-title").click();
          await target.getByTestId("target-detail-edit-title-input").fill(taskEdited);
          await target.getByTestId("target-detail-edit-save").click();
          await expect(target.getByRole("heading",{name:taskEdited})).toBeVisible();
        }
        await target.locator("button.inspectorClose").click();
        await expect(target).toHaveCount(0);
        await expect(page).toHaveURL(/view=Search/);
        await expect(row).toBeFocused(); // keyed return, even across view remounts
      }
      // A fresh explicit Search re-reads the server, never reuses stale titles.
      await input.press("Enter");
      await expect(search).toContainText(taskEdited);
      await expect(search).not.toContainText(seed.taskTitle);
    });

  test("real-store revocation between Search and detail click denies content and restores neutral focus at "+width+"px",
    async({page})=>{
      test.setTimeout(180_000);
      if(!store)throw new Error("The isolated target store was not created");
      const revoked=store.seed.revokeProjects[String(width)];
      await page.setViewportSize({width,height:844});
      await page.goto("/?view=Search&scope=shared");
      const input=page.locator(".searchField input");
      await input.fill("Revocable confidential");
      const search=page.getByTestId("target-main-title-search");
      await expect(search.getByRole("button",{name:"Vyhledat"})).toBeEnabled();
      await input.press("Enter");
      const row=search.locator('[data-detail-row="project:'+revoked.projectId+'"]');
      await expect(row).toBeVisible();
      await expect(row).toContainText(revoked.projectTitle);

      // An external admin revokes this actor's VIEWER membership in the actual
      // isolated SQLite database after the authorized Search HTTP response.
      // The shared Area retains its distinct administrator; no target API is
      // intercepted or mocked. The browser deliberately clicks the stale row.
      removeTestViewerMembership(revoked.areaId);
      await row.press("Enter");
      const detail=page.getByTestId("target-detail");
      await expect(detail).toBeVisible();
      await expect(detail.getByTestId("target-detail-error"))
        .toHaveAttribute("data-reason","not-available");
      await expect(detail).toContainText("Tato položka není dostupná.");
      await expect(detail).not.toContainText(revoked.projectTitle);
      await expect(detail.locator(".targetDetailContent")).toHaveCount(0);

      // Close in the SAME foreground window: no blur, visibility change,
      // auth refresh or forced runtime ACL tick may erase the Search bridge for
      // the implementation. The detail's real not-available answer must purge
      // that cached result itself before ordinary Close/Back.
      await detail.locator("button.inspectorClose").click();
      await expect(detail).toHaveCount(0);
      await expect(page).toHaveURL(/view=Search/);
      await expect(search).not.toContainText(revoked.projectTitle);
      await expect(search.getByTestId("target-main-search-return")).toBeFocused();

      // Explicit new real HTTP Search must also hide the revoked project.
      const fresh=page.waitForResponse(response=>
        response.request().method()==="GET"&&
        new URL(response.url()).pathname==="/api/target-staging/title-search");
      await input.press("Enter");
      expect((await fresh).status()).toBe(200);
      await expect(search.getByText(revoked.projectTitle,{exact:true})).toHaveCount(0);
      await expect(search.locator('[data-detail-row="project:'+revoked.projectId+'"]'))
        .toHaveCount(0);
    });

  test("restored 25-result Search explicitly refreshes before paging at "+width+"px",
    async({page})=>{
      test.setTimeout(180_000);
      if(!store)throw new Error("The isolated target store was not created");
      seedPagingProjects(width);
      await page.setViewportSize({width,height:844});
      await page.goto("/?view=Search&scope=personal");
      const input=page.locator(".searchField input");
      const search=page.getByTestId("target-main-title-search");
      const list=search.locator(".targetMainSearchItems li");
      await input.fill("Paging "+width+" return");
      await expect(search.getByRole("button",{name:"Vyhledat"})).toBeEnabled();
      await input.press("Enter");
      await expect(list).toHaveCount(25);
      await expect(search.getByRole("button",{name:"Načíst další"})).toBeVisible();

      const first=search.locator('[data-detail-row="project:project:e2e:paging:'+width+':01"]');
      await first.focus();
      await first.press("Enter");
      const detail=page.getByTestId("target-detail");
      await expect(detail).toContainText("Paging "+width+" return 01");
      await detail.locator("button.inspectorClose").click();
      await expect(detail).toHaveCount(0);
      await expect(page).toHaveURL(/view=Search/);
      await expect(list).toHaveCount(25);
      await expect(first).toBeFocused();

      // The old 25 rows are a focus-return snapshot, not a live cursor.
      // First click is explicitly named Refresh, and re-queries authorized page 1.
      await expect(search.getByRole("button",{name:"Načíst další"})).toHaveCount(0);
      const refresh=search.getByRole("button",{name:"Obnovit hledání"});
      await expect(refresh).toBeVisible();
      const fresh=page.waitForResponse(response=>
        response.request().method()==="GET"&&
        new URL(response.url()).pathname==="/api/target-staging/title-search"&&
        !new URL(response.url()).searchParams.has("cursor"));
      await refresh.click();
      expect((await fresh).status()).toBe(200);
      await expect(list).toHaveCount(25);
      await expect(search.getByRole("button",{name:"Obnovit hledání"})).toHaveCount(0);

      // Once re-authorized, the normal Load more button really appends page 2.
      await search.getByRole("button",{name:"Načíst další"}).click();
      await expect(list).toHaveCount(27);
      await expect(search).toContainText("Paging "+width+" return 27");
      await expect(search.getByRole("button",{name:"Načíst další"})).toHaveCount(0);
    });
}
