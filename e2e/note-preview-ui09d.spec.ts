/** Focused UI-09d Chromium tests. All GETs are mocked; never touch real notes. */
import {expect,test} from "./fixtures";
import type {Route} from "@playwright/test";

test.skip(process.env.LUMI_NOTE_PREVIEW_E2E!=="true","UI-09d requires isolated note preview opt-in");

const preview="/target-staging/notes/note-1/preview";
const endpoint="**/api/target-staging/notes/note-1";
const article=".stagingNoteContent";
const alert=".stagingNoteError[role=alert]";
const dto=(body="Sensitive body")=>({
  note:{id:"note-1",title:"Přístupná poznámka",body,projectId:null,
    areaId:"secret-area-id",areaKind:"shared",revision:9},
});
async function fulfill(route:Route,payload:unknown,status=200){
  await route.fulfill({
    status,
    headers:{"content-type":"application/json","cache-control":"no-store"},
    body:JSON.stringify(payload),
  });
}
test("read is explicit, displays authorized body as text only and never exposes ACL metadata",async({page})=>{
  let calls=0;
  await page.route(endpoint,route=>{calls++;return fulfill(route,dto('<img src=x onerror=alert(1)>'));});
  await page.goto(preview);
  await expect(page.getByRole("heading",{name:"Detail poznámky"})).toBeVisible();
  await expect(page.locator(article)).toHaveCount(0);
  expect(calls).toBe(0);
  await page.getByRole("button",{name:"Načíst poznámku"}).click();
  await expect(page.locator(article)).toBeVisible();
  await expect(page.locator(article)).toContainText("Přístupná poznámka");
  await expect(page.locator(".stagingNoteBody")).toHaveText('<img src=x onerror=alert(1)>');
  await expect(page.locator(article+" img")).toHaveCount(0);
  await expect(page.locator(article)).not.toContainText("secret-area-id");
  await expect(page.locator(article)).toContainText("Sdílená oblast");
  expect(calls).toBe(1);
});
for(const code of [401,404,409]){
  test(`refused read ${code} hides note and does not reveal existence`,async({page})=>{
    await page.route(endpoint,route=>fulfill(route,{error:"private details"},code));
    await page.goto(preview);
    await page.getByRole("button",{name:"Načíst poznámku"}).click();
    await expect(page.locator(article)).toHaveCount(0);
    await expect(page.locator(alert)).toContainText(code===401?"Přístup zanikl":
      code===404?"Poznámka není dostupná":"změnily");
    await expect(page.locator(alert)).not.toContainText("private details");
  });
}
test("pagehide, offline, blur, focus, BFCache and hidden state purge private content",async({page})=>{
  let calls=0;
  await page.route(endpoint,route=>{calls++;return fulfill(route,dto());});
  await page.goto(preview);
  const events=["pagehide","offline","blur","focus","pageshow","hidden"];
  for(const event of events){
    await page.getByRole("button",{name:"Načíst poznámku"}).click();
    await expect(page.locator(article)).toBeVisible();
    await page.evaluate(kind=>{
      if(kind==="hidden"){
        const previous=Object.getOwnPropertyDescriptor(document,"visibilityState");
        Object.defineProperty(document,"visibilityState",{configurable:true,value:"hidden"});
        document.dispatchEvent(new Event("visibilitychange"));
        if(previous)Object.defineProperty(document,"visibilityState",previous);
        else Reflect.deleteProperty(document,"visibilityState");
      }else if(kind==="pageshow"){
        window.dispatchEvent(new PageTransitionEvent("pageshow",{persisted:true}));
      }else window.dispatchEvent(new Event(kind));
    },event);
    await expect(page.locator(article)).toHaveCount(0);
  }
  expect(calls).toBe(events.length);
});
test("aborted late response cannot repopulate content after window loses focus",async({page})=>{
  const pending:{route?:Route}={};
  await page.route(endpoint,route=>{pending.route=route;});
  await page.goto(preview);
  await page.getByRole("button",{name:"Načíst poznámku"}).click();
  await expect.poll(()=>pending.route!==undefined).toBe(true);
  await page.evaluate(()=>window.dispatchEvent(new Event("blur")));
  await pending.route!.fulfill({
    status:200,headers:{"content-type":"application/json","cache-control":"no-store"},
    body:JSON.stringify(dto()),
  }).catch(()=>{});
  await expect(page.locator(article)).toHaveCount(0);
  await expect(page.getByRole("button",{name:"Načíst poznámku"})).toBeEnabled();
});
test("invalid DTO or cache directive fail closed in actual browser",async({page})=>{
  await page.route(endpoint,route=>route.fulfill({
    status:200,headers:{"content-type":"application/json","cache-control":"private"},
    body:JSON.stringify(dto("Must not appear")),
  }));
  await page.goto(preview);
  await page.getByRole("button",{name:"Načíst poznámku"}).click();
  await expect(page.locator(article)).toHaveCount(0);
  await expect(page.locator(alert)).toContainText("neprošla kontrolou");
});
