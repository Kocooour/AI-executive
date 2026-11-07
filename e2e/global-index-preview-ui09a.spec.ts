import { expect, test } from "./fixtures";
import type { Page } from "@playwright/test";

// UI-09a only: intercept the real mounted React view's fetch in an isolated
// Chromium context. This synthetic adapter deliberately IGNORES AbortSignal,
// allowing us to release an old actor's response after its GET was cancelled.
type DeferredGet={url:string;resolve:(response:Response)=>void};
type GlobalIndexMock={
  requests:DeferredGet[];
  visibility:"visible"|"hidden";
  online:boolean;
};
declare global {
  interface Window { __globalIndexPrivacyMock?:GlobalIndexMock; }
}
type Scope="all"|"personal"|"shared";
type Kind="private"|"shared";
const title=(name:string,id:string,kind:Kind="private")=>({
  kind:"project",item:{id,title:name,areaId:kind+"-area",areaKind:kind},
});
const result=(scope:Scope,items:ReturnType<typeof title>[],hasMore=false,nextCursor:string|null=null)=>({
  scope,items,hasMore,nextCursor,
});

async function setup(page:Page){
  await page.addInitScript(()=>{
    const mock:GlobalIndexMock={requests:[],visibility:"visible",online:true};
    Object.defineProperty(window,"__globalIndexPrivacyMock",{
      configurable:true,value:mock,
    });
    Object.defineProperty(document,"visibilityState",{
      configurable:true,get:()=>mock.visibility,
    });
    Object.defineProperty(navigator,"onLine",{
      configurable:true,get:()=>mock.online,
    });
    const actualFetch=window.fetch.bind(window);
    window.fetch=((input:RequestInfo|URL,init?:RequestInit)=>{
      const url=typeof input==="string"?input:input instanceof URL?input.href:input.url;
      if(!url.startsWith("/api/target-staging/global-index?"))
        return actualFetch(input,init);
      return new Promise<Response>(resolve=>{mock.requests.push({url,resolve});});
    }) as typeof window.fetch;
  });
  await page.goto("/target-staging/global-index/preview");
  await expect(page.getByRole("heading",{name:"Pracovní přehled"})).toBeVisible();
}
async function requests(page:Page,count:number){
  await expect.poll(()=>page.evaluate(()=>
    window.__globalIndexPrivacyMock?.requests.length??0)).toBe(count);
}
async function send(page:Page,n:number,body:unknown,status=200){
  await page.evaluate(({n,body,status})=>{
    const request=window.__globalIndexPrivacyMock?.requests[n-1];
    if(!request)throw new Error("Missing synthetic GET #"+n);
    request.resolve(new Response(JSON.stringify(body),{
      status,headers:{"content-type":"application/json","cache-control":"no-store"},
    }));
  },{n,body,status});
}
async function visibility(page:Page,hidden:boolean){
  await page.evaluate(isHidden=>{
    const mock=window.__globalIndexPrivacyMock;
    if(!mock)throw new Error("Privacy mock missing");
    mock.visibility=isHidden?"hidden":"visible";
    document.dispatchEvent(new Event("visibilitychange"));
  },hidden);
}
async function online(page:Page,isOnline:boolean){
  await page.evaluate(active=>{
    const mock=window.__globalIndexPrivacyMock;
    if(!mock)throw new Error("Privacy mock missing");
    mock.online=active;
    window.dispatchEvent(new Event(active?"online":"offline"));
  },isOnline);
}

test("UI-09a: scope change wipes DOM and ignores the aborted old actor's late page",async({page})=>{
  await setup(page);
  await requests(page,1);
  await send(page,1,result("all",[title("Tajný osobní původní","a")]));
  await expect(page.getByText("Tajný osobní původní")).toBeVisible();

  await page.getByRole("button",{name:"Osobní"}).click();
  await requests(page,2);
  await expect(page.getByText("Tajný osobní původní")).toHaveCount(0);
  await page.getByRole("button",{name:"Sdílené"}).click();
  await requests(page,3);
  await send(page,3,result("shared",[title("Nový ověřený sdílený","b","shared")]));
  await expect(page.getByText("Nový ověřený sdílený")).toBeVisible();

  // The prior fetch adapter ignores abort, and resolves AFTER the newer page.
  await send(page,2,result("personal",[title("Zpožděný soukromý titul","z")]));
  await expect(page.getByText("Zpožděný soukromý titul")).toHaveCount(0);
  await expect(page.getByText("Tajný osobní původní")).toHaveCount(0);
  await expect(page.getByText("Nový ověřený sdílený")).toBeVisible();
  await expect(page.getByRole("button",{name:"Sdílené"})).toHaveAttribute("aria-pressed","true");
});

test("UI-09a: hidden, BFCache pagehide and offline wipe real DOM, each resume refetches",async({page})=>{
  await setup(page);
  await requests(page,1);
  await send(page,1,result("all",[title("První soukromý titul","a")]));
  await expect(page.getByText("První soukromý titul")).toBeVisible();

  await visibility(page,true);
  await expect(page.getByText("První soukromý titul")).toHaveCount(0);
  await visibility(page,false);
  await requests(page,2);
  await expect(page.getByText("První soukromý titul")).toHaveCount(0);
  await send(page,2,result("all",[title("Po novém ověření","b")]));
  await expect(page.getByText("Po novém ověření")).toBeVisible();

  await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent("pagehide")));
  await expect(page.getByText("Po novém ověření")).toHaveCount(0);
  await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent("pageshow",{persisted:true})));
  await requests(page,3);
  await send(page,3,result("all",[title("Obnovená BFCache stránka","c")]));
  await expect(page.getByText("Obnovená BFCache stránka")).toBeVisible();

  await online(page,false);
  await expect(page.getByText("Obnovená BFCache stránka")).toHaveCount(0);
  await expect(page.locator(".stagingGlobalIndex .stagingGlobalError[role=alert]")).toContainText("Připojení selhalo");
  await online(page,true);
  await requests(page,4);
  await expect(page.getByText("Obnovená BFCache stránka")).toHaveCount(0);
  await send(page,4,result("all",[title("Nové online ověření","d")]));
  await expect(page.getByText("Nové online ověření")).toBeVisible();
});

test("UI-09a: 409 and 401 during cursor pagination erase previously visible private titles",async({page})=>{
  await setup(page);
  await requests(page,1);
  await send(page,1,result("all",[title("Citlivý titul před 409","a")],true,"YQ.Yg"));
  await expect(page.getByText("Citlivý titul před 409")).toBeVisible();

  const firstPageButton=page.getByRole("button",{name:"Načíst další položky"});
  await firstPageButton.focus();
  await firstPageButton.press("Enter");
  await requests(page,2);
  await expect(page.getByText("Citlivý titul před 409")).toHaveCount(0);
  await expect(page.locator(".stagingGlobalResultStatus")).toBeFocused();
  await expect(page.getByRole("status")).toContainText("Načítám");
  await send(page,2,{error:"Cursor stale"},409);
  await expect(page.locator(".stagingGlobalIndex .stagingGlobalError[role=alert]")).toContainText("Obsah nebo oprávnění");
  await expect(page.getByText("Citlivý titul před 409")).toHaveCount(0);
  await expect(page.locator(".stagingGlobalResultStatus")).toBeFocused();

  await page.getByRole("button",{name:"Znovu ověřit a načíst"}).click();
  await requests(page,3);
  await send(page,3,result("all",[title("Citlivý titul před 401","b")],true,"Yw.ZA"));
  await expect(page.getByText("Citlivý titul před 401")).toBeVisible();
  const secondPageButton=page.getByRole("button",{name:"Načíst další položky"});
  await secondPageButton.focus();
  await secondPageButton.press("Enter");
  await requests(page,4);
  await expect(page.getByText("Citlivý titul před 401")).toHaveCount(0);
  await expect(page.locator(".stagingGlobalResultStatus")).toBeFocused();
  await send(page,4,{error:"Unauthorized"},401);
  await expect(page.locator(".stagingGlobalIndex .stagingGlobalError[role=alert]")).toContainText("Přihlášení nebo přístup zanikl");
  await expect(page.getByText("Citlivý titul před 401")).toHaveCount(0);
  await expect(page.locator(".stagingGlobalResultStatus")).toBeFocused();
});

test("UI-09a: mixed Vše labels are readable and keyboard focus survives successful pagination",async({page})=>{
  await setup(page);
  await requests(page,1);
  await send(page,1,result("all",[
    title("Rodinný osobní projekt","a","private"),
    title("Sdílený týmový projekt","b","shared"),
  ],true,"YQ.Yg"));
  const rows=page.locator(".stagingGlobalItem");
  await expect(rows).toHaveCount(2);
  const personal=rows.filter({hasText:"Rodinný osobní projekt"});
  const shared=rows.filter({hasText:"Sdílený týmový projekt"});
  await expect(personal.locator(".stagingGlobalArea")).toHaveText("Osobní");
  await expect(shared.locator(".stagingGlobalArea")).toHaveText("Sdílené");
  // The labels must be in the accessibility tree, not just border colors.
  await expect(personal).toHaveAttribute("data-area-kind","private");
  await expect(shared).toHaveAttribute("data-area-kind","shared");
  await expect(personal.getByText("Osobní")).toBeVisible();
  await expect(shared.getByText("Sdílené")).toBeVisible();

  const load=page.getByRole("button",{name:"Načíst další položky"});
  await load.focus();
  await load.press("Enter");
  await requests(page,2);
  await expect(rows).toHaveCount(0);
  const liveStatus=page.locator(".stagingGlobalResultStatus");
  await expect(liveStatus).toBeFocused();
  await expect(liveStatus).toHaveText("Načítám autorizovaný přehled…");
  await send(page,2,result("all",[title("Další autorizovaný sdílený","c","shared")]));
  await expect(rows).toHaveCount(3);
  await expect(liveStatus).toBeFocused();
  await expect(liveStatus).toHaveText("Zobrazeno 3 autorizovaných položek.");
  await expect(rows.filter({hasText:"Další autorizovaný sdílený"})
    .locator(".stagingGlobalArea")).toHaveText("Sdílené");
});
