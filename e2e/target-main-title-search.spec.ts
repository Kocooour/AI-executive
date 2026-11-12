/** R3-FE-05: real rendered main Search, not a regex/helper-only contract.
 * Runs against a throwaway Next.js instance, synthetic legacy IndexedDB rows,
 * and intercepted staging HTTP. CI executes BOTH feature modes at 390/1280px.
 * No production data, external services, persistent flags, or full release E2E.
 */
import {test,expect} from "./fixtures";
import {waitUntilSynced} from "./helpers";
import type {Page,Route} from "@playwright/test";

test.skip(process.env.LUMI_TARGET_MAIN_SEARCH_E2E!=="true",
  "Isolated main title Search browser acceptance is default-off");

const MODE=process.env.LUMI_TARGET_MAIN_SEARCH_MODE??"on";
const LEGACY_TITLE="LOCAL LEGACY school task unseen by server";
const HELD_MARKER="LOCAL HELD-BACK school title NEVER authorized";
const GENERATION="A".repeat(43);
const HEADERS={"content-type":"application/json","cache-control":"no-store"};
const reply=(route:Route,body:unknown,status=200)=>route.fulfill({
  status,headers:HEADERS,body:JSON.stringify(body),
});

type SearchRequest={scope:string;query:string;cursor:string|null;limit:number};
async function interceptSearch(page:Page){
  const requests:SearchRequest[]=[];
  let unavailable=false,sessionCalls=0;
  await page.route("**/api/target-staging/session",route=>{
    sessionCalls++;
    return reply(route,unavailable?{error:"Staging unavailable"}:{generation:GENERATION},
      unavailable?503:200);
  });
  await page.route(/\/api\/target-staging\/title-search(?:\?|$)/,route=>{
    const request=route.request();
    expect(request.method()).toBe("GET");
    const url=new URL(request.url());
    const scope=url.searchParams.get("scope")??"all";
    const query=url.searchParams.get("q")??"";
    const limit=Number(url.searchParams.get("limit"));
    const cursor=url.searchParams.get("cursor");
    requests.push({scope,query,cursor,limit});
    expect(query).toBe("school");
    expect(limit).toBe(25);
    expect(["all","personal","shared"]).toContain(scope);
    const item=(i:number,shared=false)=>({
      kind:"task",id:(shared?"shared-":"school-")+String(i).padStart(2,"0"),
      title:shared?"Authorized shared school":"Server-authorized school "+String(i).padStart(2,"0"),
      areaId:shared?"shared-area":"private-area",
      areaKind:shared?"shared":"private",projectId:null,
    });
    if(scope==="shared"){
      expect(cursor).toBeNull();
      return reply(route,{query,scope,items:[item(1,true)],
        hasMore:false,nextCursor:null});
    }
    if(cursor!==null){
      expect(cursor).toBe("cA.cB");
      return reply(route,{query,scope,items:[item(26),item(27)],
        hasMore:false,nextCursor:null});
    }
    return reply(route,{query,scope,items:Array.from({length:25},(_,i)=>item(i+1)),
      hasMore:true,nextCursor:"cA.cB"});
  });
  return {requests,setUnavailable:(value:boolean)=>{unavailable=value;},
    sessionCalls:()=>sessionCalls};
}

/** Write actual legacy rows to the app's IndexedDB and force a real reload.
 * The deliberately overlong title is held back by lib/sendable.ts; merely
 * inventing an array in the test would not exercise the React/DOM leak. */
async function prepareLegacy(page:Page){
  await page.goto("/?view=Inbox");
  await waitUntilSynced(page);
  await page.evaluate(async({legacyTitle,heldMarker})=>{
    const db=await new Promise<IDBDatabase>((resolve,reject)=>{
      const request=indexedDB.open("ai-executive");
      request.onerror=()=>reject(request.error);
      request.onsuccess=()=>resolve(request.result);
    });
    const now=Date.now();
    const make=(id:string,title:string)=>({
      id,type:"task",title,status:"open",workspaceId:"personal",
      properties:{inbox:true},createdAt:now,updatedAt:now,
    });
    try{
      await new Promise<void>((resolve,reject)=>{
        const tx=db.transaction("entities","readwrite");
        const store=tx.objectStore("entities");
        store.put(make("r3-fe05-legacy-local",legacyTitle));
        store.put(make("r3-fe05-held-back-local",heldMarker+"!".repeat(1010)));
        tx.oncomplete=()=>resolve();
        tx.onerror=()=>reject(tx.error);
        tx.onabort=()=>reject(tx.error);
      });
    }finally{db.close();}
  },{legacyTitle:LEGACY_TITLE,heldMarker:HELD_MARKER});
  await page.reload();
  await expect(page.locator(".taskRow").filter({hasText:LEGACY_TITLE})).toHaveCount(1);
  await expect(page.locator(".heldBackItem")).toContainText(HELD_MARKER);
}

async function assertNoLegacyOnSearch(page:Page){
  await expect(page.locator(".heldBackItem")).toHaveCount(0);
  await expect(page.locator(".taskRow")).toHaveCount(0);
  await expect(page.getByText(LEGACY_TITLE,{exact:false})).toHaveCount(0);
  await expect(page.getByText(HELD_MARKER,{exact:false})).toHaveCount(0);
}

for(const width of [390,1280]){
  test("ON: legacy titles absent before submit, after Enter, paging and scope at "+
    width+"px",async({page})=>{
    test.skip(MODE!=="on","This case requires the target Search feature ON");
    await page.setViewportSize({width,height:844});
    const http=await interceptSearch(page);
    await prepareLegacy(page);
    const input=page.locator(".searchField input");
    await input.fill("school"); // Focus navigates to Search, never fetches.
    const search=page.getByTestId("target-main-title-search");
    await expect(search).toBeVisible();
    await expect(page.getByTestId("target-scope-switcher")).toBeVisible();
    await assertNoLegacyOnSearch(page);
    await expect(search.locator(".targetMainSearchItems li")).toHaveCount(0);
    expect(http.requests).toHaveLength(0); // no prefetch on focus/typing

    await input.press("Enter");
    await expect(search.locator(".targetMainSearchItems li")).toHaveCount(25);
    await expect(search).toContainText("Server-authorized school 01");
    expect(http.requests).toEqual([{scope:"all",query:"school",cursor:null,limit:25}]);
    await assertNoLegacyOnSearch(page);
    await search.getByRole("button",{name:"Načíst další"}).click();
    await expect(search.locator(".targetMainSearchItems li")).toHaveCount(27);
    await expect(search).toContainText("Server-authorized school 27");
    expect(http.requests[1]).toEqual({scope:"all",query:"school",cursor:"cA.cB",limit:25});
    await assertNoLegacyOnSearch(page);

    // A scope change must immediately drop ALL previous result rows/counts;
    // it must not silently make another request or use local task filtering.
    await page.locator('[data-scope-option="personal"]').click();
    await expect(page).toHaveURL(/scope=personal/);
    await expect(search.locator(".targetMainSearchItems li")).toHaveCount(0);
    expect(http.requests).toHaveLength(2);
    await assertNoLegacyOnSearch(page);
    await search.getByRole("button",{name:"Vyhledat"}).click();
    await expect(search.locator(".targetMainSearchItems li")).toHaveCount(25);
    expect(http.requests.at(-1)?.scope).toBe("personal");
    await page.locator('[data-scope-option="shared"]').click();
    await expect(page).toHaveURL(/scope=shared/);
    await expect(search.locator(".targetMainSearchItems li")).toHaveCount(0);
    await search.getByRole("button",{name:"Vyhledat"}).click();
    await expect(search.locator(".targetMainSearchItems li")).toHaveCount(1);
    await expect(search).toContainText("Authorized shared school");
    await assertNoLegacyOnSearch(page);

    // Same login generation, but the verification endpoint fails. The
    // displayed titles must vanish and Enter remain blocked until retry.
    const before=http.requests.length;
    http.setUnavailable(true);
    await page.waitForTimeout(1100); // runtime focus-refresh throttle is 1000ms
    await page.evaluate(()=>window.dispatchEvent(new Event("focus")));
    await expect.poll(http.sessionCalls).toBeGreaterThan(1);
    await expect(search.getByRole("button",{name:"Ověřit přístup"})).toBeVisible();
    await expect(search.locator(".targetMainSearchItems li")).toHaveCount(0);
    await expect(search.getByRole("button",{name:"Vyhledat"})).toBeDisabled();
    await input.press("Enter");
    expect(http.requests).toHaveLength(before);
    await assertNoLegacyOnSearch(page);
    http.setUnavailable(false);
    await search.getByRole("button",{name:"Ověřit přístup"}).click();
    await expect(search.getByRole("button",{name:"Vyhledat"})).toBeEnabled();
    await expect(search.locator(".targetMainSearchItems li")).toHaveCount(0);
    expect(http.requests).toHaveLength(before); // never automatic search after recovery
  });

  test("OFF: the same local tasks and held-back titles remain in legacy Search at "+
    width+"px",async({page})=>{
    test.skip(MODE!=="off","This case requires the target Search feature OFF");
    await page.setViewportSize({width,height:844});
    const http=await interceptSearch(page);
    await prepareLegacy(page);
    const input=page.locator(".searchField input");
    await input.fill("school");
    await expect(page.getByTestId("target-main-title-search")).toHaveCount(0);
    await expect(page.locator(".searchResults")).toContainText(LEGACY_TITLE);
    await expect(page.locator(".heldBackItem")).toContainText(HELD_MARKER);
    await expect(page.getByTestId("target-scope-switcher")).toHaveCount(0);
    expect(http.requests).toHaveLength(0);
    expect(http.sessionCalls()).toBe(0); // feature flag cannot mount target runtime
  });
}
