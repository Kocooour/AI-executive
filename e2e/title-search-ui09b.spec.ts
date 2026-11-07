/**
 * UI-09b scoped browser regression. Execute only with
 * LUMI_TITLE_SEARCH_PREVIEW_E2E=true in the isolated synthetic Playwright server.
 * Intercept the title-search GET: no real target data or identities are queried.
 */
import {type Route} from "@playwright/test";
import {test,expect} from "./fixtures";

test.skip(process.env.LUMI_TITLE_SEARCH_PREVIEW_E2E!=="true",
  "Isolated title-search preview browser test requires explicit opt-in");

const preview="/target-staging/title-search/preview";
const endpoint="**/api/target-staging/title-search?*";
const rows=".stagingTitleSearchItem";
const status=".stagingTitleSearchResultStatus";

type Scope="all"|"personal"|"shared";
function items(start:number,count:number,areaKind:"private"|"shared"="private"){
  return Array.from({length:count},(_,offset)=>{
    const number=start+offset;
    return {
      kind:"task" as const,id:`item-${String(number).padStart(3,"0")}`,
      title:`Syntetický název ${number}`,areaId:`area-${areaKind}`,
      areaKind,projectId:null,
    };
  });
}
async function fulfill(
  route:Route,
  result:{items:ReturnType<typeof items>;nextCursor?:string|null;status?:number},
){
  const code=result.status??200;
  const url=new URL(route.request().url());
  const scope=url.searchParams.get("scope") as Scope;
  const body=code===200?{
    query:url.searchParams.get("q"),scope,items:result.items,
    hasMore:result.nextCursor!==undefined&&result.nextCursor!==null,
    nextCursor:result.nextCursor??null,
  }:{error:code===401?"Not authorized":"Stale"};
  await route.fulfill({
    status:code,
    headers:{"cache-control":"no-store","content-type":"application/json; charset=utf-8"},
    body:JSON.stringify(body),
  });
}
async function performSearch(page:import("@playwright/test").Page,query="syntetický"){
  await page.getByRole("searchbox",{name:"Hledaný název"}).fill(query);
  await page.getByRole("button",{name:"Vyhledat"}).click();
}

test("explicit search and paging preserve focus while all old titles remain concealed",async({page})=>{
  let calls=0;
  const pending:{route?:Route}={};
  await page.route(endpoint,route=>{
    calls++;
    const url=new URL(route.request().url());
    if(url.searchParams.has("cursor")){pending.route=route;return;}
    return fulfill(route,{items:items(1,25),nextCursor:"YQ.Yg"});
  });
  await page.goto(preview);
  await expect(page.getByRole("heading",{name:"Hledání v názvech"})).toBeVisible();
  expect(calls).toBe(0); // neither initial render nor input edits make requests
  await page.getByRole("searchbox",{name:"Hledaný název"}).fill("syntetický");
  expect(calls).toBe(0);
  await page.getByRole("button",{name:"Vyhledat"}).click();
  await expect(page.locator(rows)).toHaveCount(25);
  const loadMore=page.getByRole("button",{name:"Načíst další výsledky"});
  await loadMore.focus();
  await loadMore.press("Enter");
  await expect.poll(()=>pending.route!==undefined).toBe(true);
  await expect(page.locator(rows)).toHaveCount(0);
  await expect(page.locator(status)).toHaveText("Načítám autorizované výsledky…");
  await expect(page.locator(status)).toBeFocused();
  await pending.route!.fulfill({
    status:200,
    headers:{"cache-control":"no-store","content-type":"application/json"},
    body:JSON.stringify({
      query:"syntetický",scope:"all",items:items(26,25),
      hasMore:false,nextCursor:null,
    }),
  });
  await expect(page.locator(rows)).toHaveCount(50);
  await expect(page.locator(status)).toContainText("Zobrazeno 50");
  await expect(page.locator(status)).toBeFocused();
  await expect(loadMore).toHaveCount(0);
  expect(calls).toBe(2);
});

for(const code of [401,409]){
  test(`failed continuation ${code} clears all authorized titles and preserves status focus`,async({page})=>{
    await page.route(endpoint,route=>{
      const url=new URL(route.request().url());
      return url.searchParams.has("cursor")
        ?fulfill(route,{items:[],status:code})
        :fulfill(route,{items:items(1,25),nextCursor:"YQ.Yg"});
    });
    await page.goto(preview);
    await performSearch(page);
    await expect(page.locator(rows)).toHaveCount(25);
    const button=page.getByRole("button",{name:"Načíst další výsledky"});
    await button.focus();
    await button.press("Enter");
    await expect(page.locator(rows)).toHaveCount(0);
    await expect(page.locator(status)).toBeFocused();
    await expect(page.getByRole("alert")).toContainText(
      code===401?"Přihlášení nebo přístup zanikl":"neaktuální",
    );
    await expect(page.locator(status)).toBeFocused();
  });
}

test("query and scope changes abort pending requests; late pages cannot restore titles",async({page})=>{
  const pending:Route[]=[];
  await page.route(endpoint,route=>{pending.push(route);});
  await page.goto(preview);
  await performSearch(page,"první");
  await expect.poll(()=>pending.length).toBe(1);
  await expect(page.locator(rows)).toHaveCount(0);
  await page.getByRole("searchbox",{name:"Hledaný název"}).fill("druhý");
  await pending[0].fulfill({
    status:200,headers:{"cache-control":"no-store","content-type":"application/json"},
    body:JSON.stringify({query:"první",scope:"all",items:items(1,1),hasMore:false,nextCursor:null}),
  }).catch(()=>{}); // browsers may reject fulfilling an already aborted request
  await expect(page.locator(rows)).toHaveCount(0);

  await page.getByRole("button",{name:"Vyhledat"}).click();
  await expect.poll(()=>pending.length).toBe(2);
  await page.getByRole("button",{name:"Sdílené"}).click();
  await pending[1].fulfill({
    status:200,headers:{"cache-control":"no-store","content-type":"application/json"},
    body:JSON.stringify({query:"druhý",scope:"all",items:items(2,1),hasMore:false,nextCursor:null}),
  }).catch(()=>{});
  await expect(page.locator(rows)).toHaveCount(0);
  expect(pending).toHaveLength(2); // scope change never silently refetches

  await page.getByRole("button",{name:"Vyhledat"}).click();
  await expect.poll(()=>pending.length).toBe(3);
  await fulfill(pending[2],{items:items(3,1,"shared")});
  await expect(page.locator(rows)).toHaveCount(1);
  await expect(page.locator(rows).first()).toContainText("Sdílené");
  await expect(page.getByRole("button",{name:"Sdílené"})).toHaveAttribute("aria-pressed","true");
  await expect(page.locator(rows).first()).not.toContainText("area-shared");
});

test("page lifecycle, connectivity and BFCache invalidation clear titles without refetch",async({page})=>{
  let calls=0;
  await page.route(endpoint,route=>{
    calls++;
    return fulfill(route,{items:items(1,1)});
  });
  await page.goto(preview);
  for(const event of ["pagehide","pageshow","offline","blur","focus","hidden"] as const){
    await performSearch(page,"obnova");
    await expect(page.locator(rows)).toHaveCount(1);
    await page.evaluate(kind=>{
      if(kind==="hidden"){
        const own=Object.getOwnPropertyDescriptor(document,"visibilityState");
        Object.defineProperty(document,"visibilityState",{configurable:true,value:"hidden"});
        document.dispatchEvent(new Event("visibilitychange"));
        if(own)Object.defineProperty(document,"visibilityState",own);
        else Reflect.deleteProperty(document,"visibilityState");
      }else if(kind==="pageshow"){
        window.dispatchEvent(new PageTransitionEvent("pageshow",{persisted:true}));
      }else if(kind==="pagehide"){
        window.dispatchEvent(new PageTransitionEvent("pagehide"));
      }else{
        window.dispatchEvent(new Event(kind));
      }
    },event);
    await expect(page.locator(rows)).toHaveCount(0);
    await expect(page.getByRole("searchbox",{name:"Hledaný název"})).toHaveValue("");
  }
  expect(calls).toBe(6);
  await page.goto("/");
  await page.goto(preview);
  await expect(page.locator(rows)).toHaveCount(0);
  expect(calls).toBe(6);
});
