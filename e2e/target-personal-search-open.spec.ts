/** Milestone A/3 Search-to-detail acceptance on a REAL isolated target SQLite.
 * Requires the personal acceptance store profile. Never intercepts or mocks
 * /api/target-staging: access checks and writes are real route-handler calls.
 * Config's testMatch must include this file for the opt-in real-store run.
 */
import {test,expect} from "./fixtures";

test.skip(process.env.LUMI_TARGET_PERSONAL_ACCEPTANCE_E2E!=="true",
  "Search-open acceptance requires the isolated personal-v1 target store");

type Seed={projects:Record<string,{
  projectId:string;projectTitle:string;taskId:string;taskTitle:string;
}>};
const store=JSON.parse(process.env.LUMI_E2E_TARGET_STORE||"null") as {seed:Seed}|null;

for(const width of [390,1280]){
  test("real-store Search opens all three authorized kinds and returns focus at "+width+"px",
    async({page})=>{
      test.setTimeout(180_000);
      if(!store)throw new Error("The isolated target store was not created");
      const seed=store.seed.projects[String(width)];
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
}
