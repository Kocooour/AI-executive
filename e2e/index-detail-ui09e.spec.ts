/** UI-09e only: mock all item data, test two real destination pages. */
import {test,expect} from "./fixtures";
const index="/target-staging/global-index/preview";
const indexApi="**/api/target-staging/global-index?*";
const indexPage={
  scope:"all" as const,
  items:[
    {kind:"note",item:{id:"n-3",title:"Ověřená poznámka",areaId:"area-shared",areaKind:"shared",projectId:null,revision:4}},
    {kind:"project",item:{id:"p-1",title:"Ověřený projekt",areaId:"area-private",areaKind:"private"}},
    {kind:"task",item:{id:"t-2",title:"Úkol bez detailu",areaId:"area-private",areaKind:"private",projectId:null,status:"open",dueOn:null}},
  ],
  hasMore:false,nextCursor:null,
};
async function setupIndex(page:import("@playwright/test").Page){
  let indexGets=0;
  await page.route(indexApi,route=>{
    indexGets++;
    return route.fulfill({status:200,headers:{"content-type":"application/json","cache-control":"no-store"},body:JSON.stringify(indexPage)});
  });
  return ()=>indexGets;
}

test.skip(process.env.LUMI_INDEX_DETAIL_PREVIEW_E2E!=="true",
  "Cross-preview links require explicit isolated opt-in");
test("UI-09e links need an explicit fresh detail GET, and tasks have no link",async({page})=>{
  let noteGets=0,projectGets=0;
  const indexGets=await setupIndex(page);
  await page.route("**/api/target-staging/notes/n-3",route=>{
    noteGets++;
    return route.fulfill({status:200,headers:{
      "content-type":"application/json","cache-control":"no-store",
    },body:JSON.stringify({note:{
      id:"n-3",title:"Ověřená poznámka",body:"Výhradně ověřený obsah",
      areaId:"area-shared",areaKind:"shared",projectId:null,revision:4,
    }})});
  });
  await page.route("**/api/target-staging/projects/p-1/tasks?*",route=>{
    projectGets++;
    return route.fulfill({status:200,headers:{
      "content-type":"application/json","cache-control":"no-store",
    },body:JSON.stringify({
      project:{id:"p-1",title:"Ověřený projekt",areaId:"area-private",areaKind:"private"},
      tasks:[],hasMore:false,nextCursor:null,
    })});
  });

  await page.goto(index);
  const note=page.getByRole("link",{name:"Otevřít poznámku: Ověřená poznámka"});
  const project=page.getByRole("link",{name:"Otevřít projekt: Ověřený projekt"});
  await expect(note).toHaveAttribute("href","/target-staging/notes/n-3/preview");
  await expect(project).toHaveAttribute("href","/target-staging/projects/p-1/preview");
  await expect(page.getByText("Úkol bez detailu")).toBeVisible();
  await expect(page.getByRole("link",{name:/Úkol bez detailu/})).toHaveCount(0);
  expect(indexGets()).toBe(1);
  expect(noteGets).toBe(0);
  expect(projectGets).toBe(0);

  await note.click();
  await expect(page).toHaveURL(/\/target-staging\/notes\/n-3\/preview$/);
  await expect(page.getByRole("heading",{name:"Detail poznámky"})).toBeVisible();
  await expect(page.locator(".stagingNoteBody")).toHaveCount(0);
  expect(noteGets).toBe(0); // navigation never itself requests note body
  await page.getByRole("button",{name:"Načíst poznámku"}).click();
  await expect(page.locator(".stagingNoteBody")).toHaveText("Výhradně ověřený obsah");
  expect(noteGets).toBe(1);

  await page.goto(index); // independent newly authorized index read
  await expect(page.getByRole("link",{name:"Otevřít projekt: Ověřený projekt"})).toBeVisible();
  expect(indexGets()).toBe(2);
  await page.getByRole("link",{name:"Otevřít projekt: Ověřený projekt"}).click();
  await expect(page).toHaveURL(/\/target-staging\/projects\/p-1\/preview$/);
  await expect(page.getByRole("heading",{name:"Úkoly projektu"})).toBeVisible();
  await expect(page.getByText("Ověřený projekt")).toHaveCount(0);
  expect(projectGets).toBe(0);
  await page.getByRole("button",{name:"Ověřit a načíst projekt"}).click();
  await expect(page.getByRole("heading",{name:"Ověřený projekt"})).toBeVisible();
  expect(projectGets).toBe(1);
});
test("UI-09e revoked note detail stays absent after following a legitimate index link",async({page})=>{
  await setupIndex(page);
  await page.route("**/api/target-staging/notes/n-3",route=>
    route.fulfill({status:404,headers:{"cache-control":"no-store","content-type":"application/json"},
      body:JSON.stringify({error:"Not found"})}));
  await page.goto(index);
  await page.getByRole("link",{name:"Otevřít poznámku: Ověřená poznámka"}).click();
  await page.getByRole("button",{name:"Načíst poznámku"}).click();
  await expect(page.locator(".stagingNoteBody")).toHaveCount(0);
  await expect(page.locator(".stagingNoteError[role=alert]")).toContainText("Poznámka není dostupná");
});
