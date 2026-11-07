/** UI-09c scoped browser privacy tests, synthetic API only. Not full release E2E. */
import {type Route} from "@playwright/test";
import {test,expect} from "./fixtures";

test.skip(process.env.LUMI_PROJECT_TASKS_PREVIEW_E2E!=="true",
  "Run only on private synthetic opt-in project-task preview");

const routePath="/target-staging/projects/family/preview";
const endpoint="**/api/target-staging/projects/*/tasks?*";
const items=".stagingProjectItem";
const status=".stagingProjectTasks [role=status]";
const project={id:"family",title:"Rodinný projekt",areaId:"private-area",areaKind:"private"};
const task=(id:string)=>({
  id,title:"Úkol "+id,projectId:"family",areaId:"private-area",
  effectiveAreaId:"private-area",areaKind:"private",
});
const body=(ids:string[],nextCursor:string|null=null)=>({
  project,tasks:ids.map(task),hasMore:nextCursor!==null,nextCursor,
});
const response=(route:Route,data:unknown,statusCode=200)=>
  route.fulfill({
    status:statusCode,
    headers:{"cache-control":"no-store","content-type":"application/json"},
    body:JSON.stringify(data),
  });

test("explicit first read, hidden titles while paging, and preserved focus",async({page})=>{
  let calls=0;
  const pending:{route?:Route}={};
  await page.route(endpoint,route=>{
    calls++;
    const params=new URL(route.request().url()).searchParams;
    if(params.has("cursor")){pending.route=route;return;}
    return response(route,body(Array.from({length:25},(_,i)=>
      String(i+1).padStart(3,"0")),"YQ.Yg"));
  });
  await page.goto(routePath);
  await expect(page.getByRole("heading",{name:"Úkoly projektu"})).toBeVisible();
  expect(calls).toBe(0);
  await page.getByRole("button",{name:"Ověřit a načíst projekt"}).click();
  await expect(page.locator(items)).toHaveCount(25);
  await expect(page.getByRole("heading",{name:"Rodinný projekt"})).toBeVisible();
  await expect(page.locator("main")).not.toContainText("private-area");
  const load=page.getByRole("button",{name:"Načíst další úkoly"});
  await load.focus();
  await load.press("Enter");
  await expect.poll(()=>pending.route!==undefined).toBe(true);
  await expect(page.locator(items)).toHaveCount(0);
  await expect(page.locator(".stagingProjectTasks [role=status]").first()).toBeFocused();
  await response(pending.route!,body(Array.from({length:25},(_,i)=>
    String(i+26).padStart(3,"0"))));
  await expect(page.locator(items)).toHaveCount(50);
  await expect(page.locator(".stagingProjectTasks [role=status]").first()).toBeFocused();
  expect(calls).toBe(2);
});

for(const code of [401,404,409]){
  test("project error "+code+" removes all older titles",async({page})=>{
    let count=0;
    await page.route(endpoint,route=>{
      count++;
      if(count===1)return response(route,body(["a"]));
      return response(route,{error:"Unavailable"},code);
    });
    await page.goto(routePath);
    await page.getByRole("button",{name:"Ověřit a načíst projekt"}).click();
    await expect(page.locator(items)).toHaveCount(1);
    await page.getByRole("button",{name:"Ověřit a načíst projekt"}).click();
    await expect(page.locator(items)).toHaveCount(0);
    await expect(page.locator(".stagingProjectError")).toBeVisible();
    await expect(page.getByRole("heading",{name:"Rodinný projekt"})).toHaveCount(0);
    expect(count).toBe(2);
  });
}

test("window hide and delayed response never restore an old authorized title",async({page})=>{
  let calls=0;
  const waiting:Route[]=[];
  await page.route(endpoint,route=>{calls++;waiting.push(route);});
  await page.goto(routePath);
  await page.getByRole("button",{name:"Ověřit a načíst projekt"}).click();
  await expect.poll(()=>waiting.length).toBe(1);
  await page.evaluate(()=>window.dispatchEvent(new Event("pagehide")));
  await response(waiting[0],body(["a"])).catch(()=>{});
  await expect(page.locator(items)).toHaveCount(0);
  await page.getByRole("button",{name:"Ověřit a načíst projekt"}).click();
  await expect.poll(()=>waiting.length).toBe(2);
  await response(waiting[1],body(["a"]));
  await expect(page.locator(items)).toHaveCount(1);
  await page.evaluate(()=>window.dispatchEvent(new Event("offline")));
  await expect(page.locator(items)).toHaveCount(0);
  await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent("pageshow",{persisted:true})));
  await expect(page.locator(items)).toHaveCount(0);
  expect(calls).toBe(2);
});

test("malformed project permissions are rejected before rendering",async({page})=>{
  await page.route(endpoint,route=>response(route,{
    ...body(["a"]),tasks:[{...task("a"),assigneeUserId:"foreign-identity"}],
  }));
  await page.goto(routePath);
  await page.getByRole("button",{name:"Ověřit a načíst projekt"}).click();
  await expect(page.locator(items)).toHaveCount(0);
  await expect(page.locator(".stagingProjectError")).toContainText("Odpověď neprošla kontrolou");
});
