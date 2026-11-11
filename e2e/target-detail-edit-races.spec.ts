/** R3-FE-4b: real mounted React races, isolated synthetic target endpoints only.
 * Opt in with LUMI_TARGET_DETAIL_EDITS_E2E=true; no actual staging data is touched. */
import {expect,test} from "./fixtures";
import type {Page,Route} from "@playwright/test";

test.skip(process.env.LUMI_TARGET_DETAIL_EDITS_E2E!=="true",
  "Requires isolated, mocked target detail editing flags");

const revision="a".repeat(64);
const generation="A".repeat(43);
const restoreGeneration="11111111-1111-4111-8111-111111111111";
const note=(title="Original",body="Original text")=>({note:{
  id:"note-1",title,body,projectId:null,areaId:"area1",areaKind:"private",revision:1,
}});
const json=(route:Route,body:unknown,status=200)=>route.fulfill({
  status,headers:{"cache-control":"no-store","content-type":"application/json"},
  body:JSON.stringify(body),
});
async function boot(page:Page,options:{
  onRead?:(route:Route,sequence:number)=>Promise<unknown>|unknown;
  onPreflight?:(route:Route,sequence:number)=>Promise<unknown>|unknown;
  onDelete?:(route:Route)=>Promise<unknown>|unknown;
}={}){
  let reads=0,preflights=0;
  await page.route("**/api/target-staging/session",route=>json(route,{generation}));
  await page.route("**/api/target-staging/global-notes?*",route=>json(route,{
    scope:"all",items:[{kind:"note",item:{
      id:"note-1",title:"Original",projectId:null,areaId:"area1",areaKind:"private",revision:1,
    }}],hasMore:false,nextCursor:null,
  }));
  await page.route("**/api/target-staging/notes/note-1/edit",async route=>{
    preflights++;
    if(options.onPreflight){await options.onPreflight(route,preflights);return;}
    await json(route,{expectedRevision:revision,writeAreaId:"area1",restoreGeneration});
  });
  await page.route("**/api/target-staging/notes/note-1",async route=>{
    if(route.request().method()==="DELETE"){
      if(options.onDelete){await options.onDelete(route);return;}
      await json(route,{ok:true});return;
    }
    reads++;
    if(options.onRead){await options.onRead(route,reads);return;}
    await json(route,note());
  });
  await page.goto("/?view=Notes&noteId=note-1");
  await expect(page.getByTestId("target-detail")).toBeVisible();
  await expect(page.getByTestId("target-detail-edit-delete")).toBeVisible();
}

test("revoked note write role hides mounted edit controls until the new preflight finishes",async({page})=>{
  await page.clock.install();
  let releasePreflight:Route|undefined;
  await boot(page,{
    onRead:async(route,read)=>{await json(route,read===1?note():note("Updated elsewhere"));},
    onPreflight:async(route,request)=>{
      if(request===1){await json(route,{expectedRevision:revision,writeAreaId:"area1",restoreGeneration});return;}
      releasePreflight=route; // Real HTTP handler is held while React renders a new detail.
    },
  });
  await page.clock.fastForward(61_000);
  await expect(page.getByRole("heading",{name:"Updated elsewhere"})).toBeVisible();
  await expect(page.getByTestId("target-detail-edit-delete")).toHaveCount(0);
  await expect(page.getByTestId("target-detail-edit-checking")).toBeVisible();
  await expect.poll(()=>Boolean(releasePreflight)).toBe(true);
  await json(releasePreflight!,{error:"Not found"},404);
  await expect(page.getByTestId("target-detail-edit-readonly")).toBeVisible();
  await expect(page.getByTestId("target-detail-edit-delete")).toHaveCount(0);
});

test("late in-flight detail body cannot overwrite a confirmed delete",async({page})=>{
  await page.clock.install();
  await page.addInitScript(()=>{
    type Pending={enqueue(chunk:Uint8Array):void;close():void};
    const state:{reads:number;pending:Pending|null}={reads:0,pending:null};
    Object.assign(window,{__lumiDeleteRace:state});
    const native=window.fetch.bind(window);
    window.fetch=(async(input:RequestInfo|URL,init?:RequestInit)=>{
      const url=typeof input==="string"?input:input instanceof URL?input.href:input.url;
      if((init?.method??"GET")==="GET"&&
        url.includes("/api/target-staging/notes/note-1")&&!url.endsWith("/edit")){
        state.reads++;
        if(state.reads===2){
          // Fetch resolves (releases the read queue), but JSON still waits for its body.
          return new Response(new ReadableStream<Uint8Array>({
            start(controller){state.pending=controller;},
          }),{status:200,headers:{
            "cache-control":"no-store","content-type":"application/json",
          }});
        }
      }
      return native(input,init);
    }) as typeof fetch;
  });
  await boot(page);
  await page.clock.fastForward(61_000);
  await expect.poll(()=>page.evaluate(()=>
    Boolean((window as typeof window & {__lumiDeleteRace?:{pending:unknown}}).__lumiDeleteRace?.pending))).toBe(true);
  await page.getByTestId("target-detail-edit-delete").click();
  await expect(page.getByTestId("target-detail-edit-confirm")).toBeVisible();
  await page.getByTestId("target-detail-edit-confirm-yes").click();
  await expect(page.getByTestId("target-detail-edit-deleted")).toBeVisible();
  await page.evaluate(old=>{
    const state=(window as typeof window & {__lumiDeleteRace?:{pending?:{
      enqueue(chunk:Uint8Array):void;close():void;
    }}}).__lumiDeleteRace;
    if(!state?.pending)throw Error("Expected deferred GET body");
    state.pending.enqueue(new TextEncoder().encode(JSON.stringify(old)));
    state.pending.close();
  },note("Stale before deletion"));
  await expect(page.getByTestId("target-detail-edit-deleted")).toBeVisible();
  await expect(page.getByTestId("target-detail-error")).toHaveCount(0);
  await expect(page.getByTestId("target-detail-edit-delete")).toHaveCount(0);
});
