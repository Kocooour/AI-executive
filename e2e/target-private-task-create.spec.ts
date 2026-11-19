/** R3-FE-6: isolated real-React task Quick Capture at 390/1280 px.
 * All staging HTTP is synthetic Playwright interception; the server uses
 * disposable E2E credentials and never writes real personal task data.
 * Real SQLite/HTTP ACL and idempotency are covered by separate backend tests. */
import {test,expect} from "./fixtures";
import type {Page,Route} from "@playwright/test";

test.skip(process.env.LUMI_PRIVATE_TASK_CREATE_E2E!=="true",
  "private task Quick Capture is default-off, only isolated browser QA opts in");

const generation="A".repeat(43);
const restore="123e4567-e89b-42d3-a456-426614174000";
const headers={"content-type":"application/json","cache-control":"no-store"};
const reply=(route:Route,body:unknown,status=200)=>route.fulfill({
  status,headers,body:JSON.stringify(body),
});
type Cmd={taskId:string;commandId:string;areaId:string;restoreGeneration:string;title:string};
async function setup(page:Page,create:(route:Route,cmd:Cmd)=>Promise<void>,
  receipt:()=>string=()=>"not_recorded"){
  const posted:Cmd[]=[];
  await page.route("**/api/target-staging/session",route=>reply(route,{generation}));
  await page.route("**/api/target-staging/note-index/global**",route=>{
    const scope=new URL(route.request().url()).searchParams.get("scope");
    return reply(route,{scope,notes:[],hasMore:false,nextCursor:null});
  });
  await page.route("**/api/target-staging/notes/create-targets",route=>
    reply(route,{areas:[{id:"private-a",title:"Rodina"}]}));
  await page.route("**/api/target-staging/notes/create-preview",route=>
    reply(route,{restoreGeneration:restore}));
  await page.route("**/api/target-staging/tasks/create-status",route=>{
    expect(route.request().postDataJSON()).toEqual(posted[0]); // exact original command
    return reply(route,{status:receipt()});
  });
  await page.route("**/api/target-staging/tasks/create-recovery",route=>{
    const cmd=route.request().postDataJSON();
    expect(Object.keys(cmd)).toEqual(["commandId"]);
    expect(cmd.commandId).toBe(posted[0].commandId);
    const status=receipt();
    return reply(route,status==="committed"
      ?{status,taskId:posted[0].taskId}:{status});
  });
  await page.route("**/api/target-staging/tasks",async route=>{
    const cmd=route.request().postDataJSON() as Cmd;
    expect(Object.keys(cmd).sort()).toEqual([
      "areaId","commandId","restoreGeneration","taskId","title"]);
    expect(cmd.areaId).toBe("private-a");
    expect(cmd.restoreGeneration).toBe(restore);
    expect(route.request().headers()["x-lumi-target-protocol"]).toBe("1");
    posted.push(cmd);
    await create(route,cmd);
  });
  await page.route("**/api/target-staging/my-plan/slice?**",route=>{
    const url=new URL(route.request().url());
    const evaluationDate=url.searchParams.get("evaluationDate");
    const areaFilter=url.searchParams.get("areaFilter")||"all";
    return reply(route,{evaluationDate,areaFilter,
      today:{tasks:[],hasMore:false},tomorrow:{tasks:[],hasMore:false},
      hasMore:false,nextCursor:null});
  });
  await page.route("**/api/target-staging/task-temporal/**",route=>
    reply(route,{error:"not-available"},404));
  return posted;
}
function fab(page:Page,width:number){
  return page.locator('[data-target-private-capture-fab="'+(width===390?"mobile":"desktop")+'"]');
}
async function openAndFill(page:Page,width:number,title="Citlivý nový úkol"){
  await fab(page,width).click();
  await expect(page.getByTestId("target-private-quick-capture")).toBeVisible();
  await page.getByTestId("target-capture-task-kind").click();
  const modal=page.getByTestId("target-private-task-capture");
  await expect(modal).toBeVisible();
  await page.getByTestId("target-private-task-area").selectOption("private-a");
  await page.getByTestId("target-private-task-form").getByRole("textbox",{name:"Název úkolu"}).fill(title);
  return modal;
}
/** C31: a live wake must never keep an old private Area or draft, even
 * when the first fresh Area GET after reauthorization is interrupted. */
for(const width of [390,1280]){
  test("C31 retries one interrupted post-wake Area GET at "+width+"px",async({page})=>{
    await page.setViewportSize({width,height:844});
    const writes=await setup(page,(route,cmd)=>
      reply(route,{ok:true,taskId:cmd.taskId},201));
    const calls:string[]=[];
    let areaRequests=0;
    await page.route("**/api/target-staging/session",route=>{
      calls.push("session");
      return reply(route,{generation});
    });
    await page.route("**/api/target-staging/notes/create-targets",route=>{
      const attempt=++areaRequests;
      calls.push("area:"+attempt);
      // 1: initial catalog; 2: first read after wake fails on transport;
      // 3: only after another successful, direct session verification.
      if(attempt===2)return route.abort("failed");
      return reply(route,{areas:[attempt===1
        ?{id:"private-a",title:"Rodina"}
        :{id:"private-b",title:"Nová Oblast"}]});
    });
    await page.goto("/?view=Calendar&scope=personal");
    await openAndFill(page,width,"Abandoned private task title");
    await page.evaluate(()=>{
      Object.defineProperty(document,"visibilityState",{
        configurable:true,value:"hidden",
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    // The hide must synchronously clear both the selected Area and draft.
    await expect(page.getByTestId("target-private-task-form")).toHaveCount(0);
    await page.evaluate(()=>{
      Reflect.deleteProperty(document,"visibilityState");
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect.poll(()=>areaRequests).toBe(3);
    const area=page.getByTestId("target-private-task-area");
    await expect(area.locator('option[value="private-b"]')).toHaveCount(1);
    await expect(area.locator('option[value="private-a"]')).toHaveCount(0);
    await expect(area).toHaveValue("");
    const aborted=calls.indexOf("area:2"),retried=calls.indexOf("area:3");
    expect(aborted).toBeGreaterThan(-1);
    expect(retried).toBeGreaterThan(aborted);
    expect(calls.slice(aborted+1,retried)).toContain("session");
    await area.selectOption("private-b");
    await expect(page.getByTestId("target-private-task-form")
      .getByRole("textbox",{name:"Název úkolu"})).toHaveValue("");
    expect(writes).toHaveLength(0);
  });
}
/** The native release gate checks direct HTTP session + Area completion in
 * Chrome CDP. The focused Quick Capture test instead intercepts and fulfills
 * the Area response with Playwright: CDP may report loadingFailed after HTTP
 * 200 even when the component consumed the entire synthetic JSON body.
 * For the synthetic Area, assert one HTTP 200 response AND the valid rendered
 * catalog. Still require a fully finished direct CDP session GET 200 before
 * the Area request; the real-network BFCache release gate stays unchanged. */
async function captureAreaWakeHttp(page:Page){
  type Read={requestId:string;path:string;requestOrder:number;
    status?:number;finishedOrder?:number;failedOrder?:number;
    errorText?:string;cancelled?:boolean};
  const cdp=await page.context().newCDPSession(page);
  await cdp.send("Network.enable");
  const reads:Read[]=[];
  const pending=new Map<string,Read>();
  let order=0;
  const sessionPath="/api/target-staging/session";
  const areaPath="/api/target-staging/notes/create-targets";
  cdp.on("Network.requestWillBeSent",event=>{
    if(event.request.method!=="GET")return;
    const url=new URL(event.request.url);
    if(url.pathname!==sessionPath&&url.pathname!==areaPath)return;
    const read={requestId:event.requestId,path:url.pathname,requestOrder:++order};
    reads.push(read);
    pending.set(event.requestId,read);
  });
  cdp.on("Network.responseReceived",event=>{
    const read=pending.get(event.requestId);
    if(read){read.status=event.response.status;order++;}
  });
  cdp.on("Network.loadingFinished",event=>{
    const read=pending.get(event.requestId);
    if(read){read.finishedOrder=++order;pending.delete(event.requestId);}
  });
  cdp.on("Network.loadingFailed",event=>{
    const read=pending.get(event.requestId);
    if(read){
      read.failedOrder=++order;
      read.errorText=event.errorText;
      read.cancelled=event.canceled===true;
      pending.delete(event.requestId);
    }
  });
  return {
    mark:()=>order,
    async firstPendingAreaRequest(){
      // Wait for CDP to record the same held GET that Playwright intercepted.
      // Do not classify a later request as the original.
      await expect.poll(()=>reads.filter(read=>read.path===areaPath).length)
        .toBe(1);
      const original=reads.find(read=>read.path===areaPath)!;
      expect(original.finishedOrder).toBeUndefined();
      expect(original.failedOrder).toBeUndefined();
      return original.requestId;
    },
    async assertClientCancelledBeforeWake(originalId:string){
      const original=reads.find(read=>read.requestId===originalId);
      expect(original?.path).toBe(areaPath);
      await expect.poll(()=>original?.failedOrder,{timeout:10000})
        .not.toBeUndefined();
      // Only a browser-initiated cancellation proves that suspend() aborted
      // its own request; a test-issued route.abort("failed") is not evidence.
      expect(original?.cancelled,"AbortController must cancel the original GET")
        .toBe(true);
      expect(original?.errorText,"Chromium must report the client abort")
        .toBe("net::ERR_ABORTED");
      expect(original?.finishedOrder).toBeUndefined();
      return original!.failedOrder!;
    },
    async assertOneAuthorizedReplacement(mark:number,priorCancelOrder?:number){
      try{
        await expect.poll(()=>reads.filter(read=>read.path===areaPath&&
          read.requestOrder>mark&&read.status===200).length,
        {timeout:10000}).toBe(1);
      }catch(error){
        const timeline=reads.map(read=>[
          read.path===sessionPath?"session":"area",
          "start="+read.requestOrder,"status="+(read.status??"-"),
          "finish="+(read.finishedOrder??"-"),
          "failed="+(read.failedOrder??"-"),
          "id="+read.requestId,
        ].join(" ")).join(" | ");
        throw new Error("No replacement synthetic Area HTTP 200: mark="+mark+
          "; "+timeline,{cause:error});
      }
      const areas=reads.filter(read=>read.path===areaPath&&read.requestOrder>mark);
      expect(areas,"exactly one new direct private Area GET").toHaveLength(1);
      const area=areas[0];
      // The option assertion in every caller proves the complete, validated
      // synthetic JSON body was read; do not confuse a mock CDP cancellation
      // after HTTP 200 with a real incomplete Area catalog. The native gate
      // alone demands Network.loadingFinished for an unmocked Area GET.
      expect(area.status).toBe(200);
      if(priorCancelOrder!==undefined){
        expect(priorCancelOrder,"the original request must be cancelled first")
          .toBeLessThan(area.requestOrder);
      }
      const authorized=reads.filter(read=>read.path===sessionPath&&
        read.requestOrder>mark&&read.status===200&&
        read.finishedOrder!==undefined&&read.finishedOrder<area.requestOrder&&
        read.failedOrder===undefined);
      // Keep the strict transport invariant; print the CDP timeline if it
      // fails so a missing session can be distinguished from delayed CDP
      // loadingFinished, a pre-wake request or a missing route altogether.
      const timeline=reads.map(read=>[
        read.path===sessionPath?"session":"area",
        "start="+read.requestOrder,"status="+(read.status??"-"),
        "finish="+(read.finishedOrder??"-"),
        "failed="+(read.failedOrder??"-"),
        "cancelled="+(read.cancelled??"-"),
        "id="+read.requestId,
      ].join(" ")).join(" | ");
      expect(authorized.length,
        "completed direct session GET 200 must precede replacement Area GET; "+
        "mark="+mark+"; "+timeline).toBeGreaterThan(0);
    },
    close:()=>cdp.detach(),
  };
}

/** A modal mounted on a suspended runtime misses the matching wake hook
 * hide event; runtime resume must still perform exactly one verified read. */
for(const width of [390,1280]){
  test("C31 recovers suspended-on-register Area reader at "+width+"px",async({page})=>{
    await page.setViewportSize({width,height:844});
    const writes=await setup(page,(route,cmd)=>
      reply(route,{ok:true,taskId:cmd.taskId},201));
    const http=await captureAreaWakeHttp(page);
    let areaReads=0;
    await page.route("**/api/target-staging/notes/create-targets",route=>{
      areaReads++;
      return reply(route,{areas:[{id:"private-b",title:"Fresh private Area"}]});
    });
    await page.goto("/?view=Calendar&scope=personal");
    await expect(fab(page,width)).toBeVisible();
    await page.evaluate(()=>window.dispatchEvent(
      new PageTransitionEvent("pagehide",{persisted:false})));
    await fab(page,width).click();
    await page.getByTestId("target-capture-task-kind").click();
    await expect(page.getByTestId("target-private-task-capture")).toBeVisible();
    await expect(page.getByTestId("target-private-task-form")).toHaveCount(0);
    expect(areaReads,"suspended runtime cannot authorize an Area read").toBe(0);
    const from=http.mark();
    // Non-persisted pageshow is not a wake for the newly mounted hook.
    await page.evaluate(()=>window.dispatchEvent(
      new PageTransitionEvent("pageshow",{persisted:false})));
    const area=page.getByTestId("target-private-task-area");
    await expect(area.locator('option[value="private-b"]')).toHaveCount(1);
    await http.assertOneAuthorizedReplacement(from);
    await page.waitForTimeout(250); // detect delayed second wake nonce
    expect(areaReads).toBe(1);
    await expect(area).toHaveValue("");
    await area.selectOption("private-b");
    await expect(page.getByTestId("target-private-task-form")
      .getByRole("textbox",{name:"Název úkolu"})).toHaveValue("");
    expect(writes,"suspend/resume must not create a task").toHaveLength(0);
    await http.close();
  });
}

/** C31: an A-session wake that authorizes generation B must invalidate
 * its old replacement ticket. Hold the B catalog while both wake callbacks
 * settle, so a delayed stale nonce would cancel/duplicate the new B GET. */
for(const width of [390,1280]){
  test("C31 rotating A to B on wake loads one new Area at "+width+"px",async({page})=>{
    await page.setViewportSize({width,height:844});
    const writes=await setup(page,(route,cmd)=>
      reply(route,{ok:true,taskId:cmd.taskId},201));
    let verifiedGeneration=generation;
    await page.route("**/api/target-staging/session",route=>
      reply(route,{generation:verifiedGeneration}));
    const http=await captureAreaWakeHttp(page);
    let areaReads=0;
    let releaseNewArea!:()=>void;
    const newAreaHeld=new Promise<void>(resolve=>{releaseNewArea=resolve;});
    await page.route("**/api/target-staging/notes/create-targets",async route=>{
      const attempt=++areaReads;
      if(attempt===1)return reply(route,{areas:[
        {id:"private-a",title:"Old A Area"}]});
      if(attempt===2){
        await newAreaHeld;
        return reply(route,{areas:[{id:"private-b",title:"New B Area"}]});
      }
      // A duplicate is never a valid replacement; detect it with areaReads.
      return reply(route,{areas:[{id:"private-c",title:"Unexpected duplicate"}]});
    });
    await page.goto("/?view=Calendar&scope=personal");
    await openAndFill(page,width,"Old A draft must disappear");
    expect(areaReads).toBe(1);
    await page.evaluate(()=>window.dispatchEvent(
      new PageTransitionEvent("pagehide",{persisted:false})));
    await expect(page.getByTestId("target-private-task-form")).toHaveCount(0);
    verifiedGeneration="B".repeat(43);
    const from=http.mark();
    await page.evaluate(()=>window.dispatchEvent(
      new PageTransitionEvent("pageshow",{persisted:false})));
    try{
      await expect.poll(()=>areaReads).toBe(2);
      // B's response is intentionally held. An A wake callback that later
      // consumes its stale ticket would abort B and issue Area GET number 3.
      await page.waitForTimeout(400);
      expect(areaReads,"a stale A wake must not restart B's in-flight read").toBe(2);
    }finally{
      releaseNewArea();
    }
    const area=page.getByTestId("target-private-task-area");
    await expect(area.locator('option[value="private-b"]')).toHaveCount(1);
    await expect(area.locator('option[value="private-a"]')).toHaveCount(0);
    await expect(area.locator('option[value="private-c"]')).toHaveCount(0);
    await http.assertOneAuthorizedReplacement(from);
    await page.waitForTimeout(250);
    expect(areaReads,"exactly one successful B Area GET, no duplicate").toBe(2);
    await expect(area).toHaveValue("");
    await area.selectOption("private-b");
    await expect(page.getByTestId("target-private-task-form")
      .getByRole("textbox",{name:"Název úkolu"})).toHaveValue("");
    expect(writes,"generation rotation and wake must never CREATE").toHaveLength(0);
    await http.close();
  });
}

/** Opening while already offline/hidden must arm the wake hook even
 * though the first reader effect cannot register a runtime disposable.
 * Neither condition may allow a stale catalog or an unverified Area GET. */
for(const width of [390,1280]){
  for(const state of ["offline","hidden"] as const){
    test("C31 revalidates Area editor mounted "+state+" at "+width+"px",async({page})=>{
      await page.setViewportSize({width,height:844});
      const writes=await setup(page,(route,cmd)=>
        reply(route,{ok:true,taskId:cmd.taskId},201));
      const http=await captureAreaWakeHttp(page);
      let areaReads=0;
      await page.route("**/api/target-staging/notes/create-targets",route=>{
        areaReads++;
        return reply(route,{areas:[{id:"private-b",title:"Reverified private Area"}]});
      });
      await page.goto("/?view=Calendar&scope=personal");
      await expect(fab(page,width)).toBeVisible();
      await fab(page,width).click();
      const taskKind=page.getByTestId("target-capture-task-kind");
      await expect(taskKind).toBeVisible();
      // The real global Quick Capture shell closes on offline/visibility
      // events. Enter the offline/hidden state during the task-kind click,
      // before React mounts the chooser, without first closing the shell.
      // This tests the chooser's initially-unavailable mount, not the shell.
      await taskKind.evaluate((node,state)=>{
        node.addEventListener("click",()=>{
          if(state==="offline"){
            Object.defineProperty(navigator,"onLine",{
              configurable:true,value:false,
            });
          }else{
            Object.defineProperty(document,"visibilityState",{
              configurable:true,value:"hidden",
            });
          }
        },{capture:true,once:true});
      },state);
      await taskKind.click();
      await expect(page.getByTestId("target-private-task-capture")).toBeVisible();
      await expect(page.getByTestId("target-private-task-form")).toHaveCount(0);
      expect(areaReads,"initially offline/hidden editor must not read Areas").toBe(0);
      const from=http.mark();
      await page.evaluate(state=>{
        if(state==="offline"){
          Reflect.deleteProperty(navigator,"onLine");
          window.dispatchEvent(new Event("online"));
        }else{
          Reflect.deleteProperty(document,"visibilityState");
          document.dispatchEvent(new Event("visibilitychange"));
        }
      },state);
      const area=page.getByTestId("target-private-task-area");
      await expect(area.locator('option[value="private-b"]')).toHaveCount(1);
      await http.assertOneAuthorizedReplacement(from);
      await page.waitForTimeout(250);
      expect(areaReads,"the wake may read the new private catalog only once").toBe(1);
      await expect(area).toHaveValue("");
      await area.selectOption("private-b");
      await expect(page.getByTestId("target-private-task-form")
        .getByRole("textbox",{name:"Název úkolu"})).toHaveValue("");
      expect(writes,"visibility/network resume must never CREATE").toHaveLength(0);
      await http.close();
    });
  }
}

/** A held read is aborted during a real runtime suspend; revalidation must
 * finish before exactly one replacement GET, with no stale catalog/draft. */
for(const width of [390,1280]){
  test("C31 replaces a suspended in-flight Area read at "+width+"px",async({page})=>{
    await page.setViewportSize({width,height:844});
    const writes=await setup(page,(route,cmd)=>
      reply(route,{ok:true,taskId:cmd.taskId},201));
    const http=await captureAreaWakeHttp(page);
    let requests=0;
    await page.route("**/api/target-staging/notes/create-targets",route=>{
      requests++;
      // Leave the first transport pending: only the actual client-side
      // AbortController can cancel it, never an artificial test route.abort().
      if(requests===1)return;
      return reply(route,{areas:[{id:"private-b",title:"Fresh private Area"}]});
    });
    await page.goto("/?view=Calendar&scope=personal");
    await fab(page,width).click();
    await page.getByTestId("target-capture-task-kind").click();
    await expect.poll(()=>requests).toBe(1);
    const firstAreaRequestId=await http.firstPendingAreaRequest();
    const from=http.mark();
    await page.evaluate(()=>window.dispatchEvent(
      new PageTransitionEvent("pagehide",{persisted:false})));
    await expect(page.getByTestId("target-private-task-form")).toHaveCount(0);
    // Assert the original GET was cancelled by the browser BEFORE waking or
    // allowing any replacement request. This is the missing C31 P2 witness.
    const cancelledAt=await http.assertClientCancelledBeforeWake(firstAreaRequestId);
    expect(requests).toBe(1);
    await page.evaluate(()=>window.dispatchEvent(
      new PageTransitionEvent("pageshow",{persisted:false})));
    const area=page.getByTestId("target-private-task-area");
    await expect(area.locator('option[value="private-b"]')).toHaveCount(1);
    await http.assertOneAuthorizedReplacement(from,cancelledAt);
    await page.waitForTimeout(250); // late duplicate nonce must not create GET 3
    expect(requests).toBe(2);
    await expect(area).toHaveValue("");
    await area.selectOption("private-b");
    await expect(page.getByTestId("target-private-task-form")
      .getByRole("textbox",{name:"Název úkolu"})).toHaveValue("");
    expect(writes).toHaveLength(0);
    await http.close();
  });
}

/** A wake without a successful session cannot authorize a private Area just
 * because a generation is still known from before the page was hidden. */
test("C31 failed wake session stays closed until explicit successful reverify",async({page})=>{
  await page.setViewportSize({width:390,height:844});
  const writes=await setup(page,(route,cmd)=>
    reply(route,{ok:true,taskId:cmd.taskId},201));
  let sessionAllowed=true,areaReads=0,sessionDenied=0;
  await page.route("**/api/target-staging/session",route=>{
    if(!sessionAllowed){sessionDenied++;return reply(route,{error:"unavailable"},503);}
    return reply(route,{generation});
  });
  await page.route("**/api/target-staging/notes/create-targets",route=>{
    areaReads++;
    return reply(route,{areas:[areaReads===1
      ?{id:"private-a",title:"Old Area"}
      :{id:"private-b",title:"Fresh Area"}]});
  });
  await page.goto("/?view=Calendar&scope=personal");
  await openAndFill(page,390,"Abandoned draft");
  expect(areaReads).toBe(1);
  sessionAllowed=false;
  await page.evaluate(()=>window.dispatchEvent(
    new PageTransitionEvent("pagehide",{persisted:false})));
  await expect(page.getByTestId("target-private-task-form")).toHaveCount(0);
  await page.evaluate(()=>window.dispatchEvent(
    new PageTransitionEvent("pageshow",{persisted:false})));
  await expect.poll(()=>sessionDenied).toBeGreaterThan(0);
  await page.waitForTimeout(300);
  expect(areaReads,"no Area may read with only stale session evidence").toBe(1);
  const modal=page.getByTestId("target-private-task-capture");
  await expect(modal.getByText("Oblasti nelze ověřit.",{exact:false})).toBeVisible();
  sessionAllowed=true;
  await modal.getByRole("button",{name:"Zkusit znovu"}).click();
  const area=page.getByTestId("target-private-task-area");
  await expect(area.locator('option[value="private-b"]')).toHaveCount(1);
  await expect(area).toHaveValue("");
  await area.selectOption("private-b");
  await expect(page.getByTestId("target-private-task-form")
    .getByRole("textbox",{name:"Název úkolu"})).toHaveValue("");
  expect(areaReads).toBe(2);
  expect(writes).toHaveLength(0);
});

/** The original C31 failure happened AFTER HTTP 200 response headers,
 * while reader.read() consumed the body. Synthetic Fetch Response 200 below
 * provides one partial JSON chunk then errors the stream (not the fetch).
 * The unaffected requests still hit the isolated HTTP mock. */
test("C31 recovers from HTTP 200 followed by interrupted Area response body",async({page})=>{
  await page.setViewportSize({width:390,height:844});
  const writes=await setup(page,(route,cmd)=>
    reply(route,{ok:true,taskId:cmd.taskId},201));
  let completedAreaGets=0;
  await page.route("**/api/target-staging/notes/create-targets",route=>{
    completedAreaGets++;
    return reply(route,{areas:[completedAreaGets===1
      ?{id:"private-a",title:"Old private Area"}
      :{id:"private-b",title:"Fresh private Area"}]});
  });
  await page.addInitScript(()=>{
    const evidence={areaAttempts:0,events:[] as string[],
      returned200:false,firstChunkDelivered:false,bodyInterrupted:false};
    Object.assign(window,{__lumiC31BodyEvidence:evidence});
    const original=window.fetch.bind(window);
    window.fetch=(input,init)=>{
      const raw=typeof input==="string"?input:
        input instanceof URL?input.href:input.url;
      const path=new URL(raw,location.href).pathname;
      if(path==="/api/target-staging/session"){
        evidence.events.push("session:start");
        return original(input,init).then(response=>{
          evidence.events.push("session:"+response.status);
          return response;
        });
      }
      if(path!=="/api/target-staging/notes/create-targets")
        return original(input,init);
      const attempt=++evidence.areaAttempts;
      evidence.events.push("area:"+attempt);
      if(attempt!==2)return original(input,init);
      // Fetch resolves successfully with HTTP 200 and correct no-store
      // headers; the first body read succeeds, the next one rejects.
      const body=new ReadableStream<Uint8Array>({
        start(controller){
          controller.enqueue(new TextEncoder().encode('{"areas":['));
          evidence.firstChunkDelivered=true;
          setTimeout(()=>{
            evidence.bodyInterrupted=true;
            controller.error(new TypeError("C31 interrupted response body"));
          },20);
        },
      });
      const response=new Response(body,{status:200,headers:{
        "content-type":"application/json","cache-control":"no-store",
      }});
      evidence.returned200=response.status===200;
      return Promise.resolve(response);
    };
  });
  await page.goto("/?view=Calendar&scope=personal");
  await openAndFill(page,390,"Discard this private title");
  await page.evaluate(()=>{
    Object.defineProperty(document,"visibilityState",{
      configurable:true,value:"hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(page.getByTestId("target-private-task-form")).toHaveCount(0);
  await page.evaluate(()=>{
    Reflect.deleteProperty(document,"visibilityState");
    document.dispatchEvent(new Event("visibilitychange"));
  });
  const area=page.getByTestId("target-private-task-area");
  await expect(area.locator('option[value="private-b"]')).toHaveCount(1);
  await expect(area.locator('option[value="private-a"]')).toHaveCount(0);
  await expect(area).toHaveValue("");
  const proof=await page.evaluate(()=>(window as typeof window & {
    __lumiC31BodyEvidence:{areaAttempts:number;events:string[];
      returned200:boolean;firstChunkDelivered:boolean;bodyInterrupted:boolean};
  }).__lumiC31BodyEvidence);
  expect(proof.areaAttempts,"exactly one retry").toBe(3);
  expect(proof.returned200,"response headers arrived before body error").toBe(true);
  expect(proof.firstChunkDelivered).toBe(true);
  expect(proof.bodyInterrupted).toBe(true);
  const failed=proof.events.indexOf("area:2"),retried=proof.events.indexOf("area:3");
  expect(proof.events.slice(failed+1,retried)).toContain("session:200");
  expect(completedAreaGets,"one original and one fresh completed HTTP GET").toBe(2);
  await area.selectOption("private-b");
  await expect(page.getByTestId("target-private-task-form")
    .getByRole("textbox",{name:"Název úkolu"})).toHaveValue("");
  expect(writes,"recovery must not create a task").toHaveLength(0);
});
/** A live read deadline (including a stalled 200 body) must not become a
 * permanent unavailable state after wake; it needs a NEW fetch signal. */
test("C31 post-wake Area timeout retries under fresh authorization",async({page})=>{
  test.setTimeout(40000);
  await page.setViewportSize({width:390,height:844});
  const writes=await setup(page,(route,cmd)=>
    reply(route,{ok:true,taskId:cmd.taskId},201));
  const calls:string[]=[];
  let areaRequests=0;
  let held:Route|null=null;
  await page.route("**/api/target-staging/session",route=>{
    calls.push("session");
    return reply(route,{generation});
  });
  await page.route("**/api/target-staging/notes/create-targets",route=>{
    const attempt=++areaRequests;
    calls.push("area:"+attempt);
    if(attempt===2){
      held=route; // simulate a GET whose body never finishes
      return;
    }
    return reply(route,{areas:[attempt===1
      ?{id:"private-a",title:"Původní Oblast"}
      :{id:"private-b",title:"Ověřená Oblast"}]});
  });
  await page.goto("/?view=Calendar&scope=personal");
  await openAndFill(page,390,"Abandoned draft");
  await page.evaluate(()=>{
    Object.defineProperty(document,"visibilityState",{
      configurable:true,value:"hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(page.getByTestId("target-private-task-form")).toHaveCount(0);
  await page.evaluate(()=>{
    Reflect.deleteProperty(document,"visibilityState");
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(()=>areaRequests,{timeout:25000}).toBe(3);
  const retryFrom=calls.indexOf("area:2"),retryTo=calls.indexOf("area:3");
  expect(calls.slice(retryFrom+1,retryTo)).toContain("session");
  const area=page.getByTestId("target-private-task-area");
  await expect(area.locator('option[value="private-b"]')).toHaveCount(1);
  await expect(area.locator('option[value="private-a"]')).toHaveCount(0);
  await expect(area).toHaveValue("");
  await area.selectOption("private-b");
  await expect(page.getByTestId("target-private-task-form")
    .getByRole("textbox",{name:"Název úkolu"})).toHaveValue("");
  expect(writes).toHaveLength(0);
  if(held)await (held as Route).abort("failed").catch(()=>{});
});
for(const width of [390,1280]){
  test("exact single POST, server confirmation, and authorized detail at "+width+"px",async({page})=>{
    await page.setViewportSize({width,height:844});
    const writes=await setup(page,(route,cmd)=>reply(route,{ok:true,taskId:cmd.taskId},201));
    await page.goto("/?view=Calendar&scope=shared");
    const modal=await openAndFill(page,width);
    await page.getByTestId("target-private-task-save").click();
    await expect(modal).toHaveCount(0);
    const notice=page.getByTestId("target-private-task-created");
    await expect(notice).toBeVisible();
    expect(writes).toHaveLength(1);
    const taskId=writes[0].taskId;
    const persisted=await page.evaluate(()=>
      JSON.stringify([sessionStorage.getItem("lumi-private-task-create-unresolved-v1"),
        Object.entries(localStorage)]));
    expect(persisted).not.toContain("Citlivý nový úkol");
    expect(persisted).not.toContain(writes[0].areaId);
    await notice.getByTestId("target-private-task-open").click();
    await expect(page).toHaveURL(/view=MyPlanPreview/);
    await expect(page).toHaveURL(/scope=personal/);
    await expect(page).toHaveURL(new RegExp("taskId="+taskId));
    await expect(page.getByTestId("target-detail")).toBeVisible();
  });
}
test("close/reopen during uncertain POST unlocks only on exact committed receipt",async({page})=>{
  await page.setViewportSize({width:390,height:844});
  let hold:Route|null=null,status="not_recorded";
  const writes=await setup(page,async route=>{hold=route;},()=>status);
  await page.goto("/?view=Calendar");
  const modal=await openAndFill(page,390);
  await page.getByTestId("target-private-task-save").click();
  await expect.poll(()=>hold!==null).toBe(true);
  await modal.getByRole("button",{name:"Zavřít"}).click();
  await expect(modal).toHaveCount(0);
  await fab(page,390).click();
  await page.getByTestId("target-capture-task-kind").click();
  const reopened=page.getByTestId("target-private-task-capture");
  await expect(reopened).toBeVisible();
  await expect(page.getByTestId("target-private-task-receipt")).toHaveCount(0);
  if(!hold)throw Error("task CREATE not dispatched");
  await reply(hold,{error:"unavailable"},503);
  const verify=page.getByTestId("target-private-task-receipt");
  await expect(verify).toBeEnabled();
  await verify.click();
  await expect(page.getByTestId("target-private-task-unresolved")).toBeVisible();
  expect(writes).toHaveLength(1);
  status="committed";
  await verify.click();
  await expect(reopened).toHaveCount(0);
  await expect(page.getByTestId("target-private-task-created")).toBeVisible();
  expect(writes).toHaveLength(1);
});
test("close before successful POST still announces the saved task without another write",async({page})=>{
  await page.setViewportSize({width:1280,height:844});
  let hold:Route|null=null;
  const writes=await setup(page,async route=>{hold=route;});
  await page.goto("/?view=Calendar");
  const modal=await openAndFill(page,1280);
  await page.getByTestId("target-private-task-save").click();
  await expect.poll(()=>hold!==null).toBe(true);
  await modal.getByRole("button",{name:"Zavřít"}).click();
  if(!hold)throw Error("task CREATE not dispatched");
  await reply(hold,{ok:true,taskId:writes[0].taskId},201);
  await expect(page.getByTestId("target-private-task-created")).toBeVisible();
  expect(writes).toHaveLength(1);
});
for(const width of [390,1280]){
test("reload recovery exposes authorized task detail without retrying CREATE at "+width+"px",async({page})=>{
  await page.setViewportSize({width,height:844});
  let receipt="not_recorded";
  const writes=await setup(page,route=>reply(route,{error:"unavailable"},503),()=>receipt);
  await page.goto("/?view=Calendar&scope=shared");
  await openAndFill(page,width);
  await page.getByTestId("target-private-task-save").click();
  await expect(page.getByTestId("target-private-task-unresolved")).toBeVisible();
  const stored=await page.evaluate(()=>sessionStorage.getItem("lumi-private-task-create-unresolved-v1"));
  expect(stored).toContain(writes[0].commandId);
  expect(stored).not.toContain(writes[0].title);
  await page.reload();
  await fab(page,width).click();
  await page.getByTestId("target-capture-task-kind").click();
  await expect(page.getByTestId("target-private-task-unresolved")).toBeVisible();
  await expect(page.getByTestId("target-private-task-form")).toHaveCount(0);
  const verify=page.getByTestId("target-private-task-receipt");
  await expect(verify).toBeEnabled();
  await verify.click();
  await expect(page.getByTestId("target-private-task-unresolved")).toBeVisible();
  receipt="committed";
  await verify.click();
  const notice=page.getByTestId("target-private-task-created");
  await expect(notice).toBeVisible();
  await expect(page.getByTestId("target-private-task-capture")).toHaveCount(0);
  expect(writes).toHaveLength(1);
  const persisted=await page.evaluate(()=>sessionStorage.getItem(
    "lumi-private-task-create-unresolved-v1"));
  expect(persisted).toBe(null);
  await notice.getByTestId("target-private-task-open").click();
  await expect(page).toHaveURL(/view=MyPlanPreview/);
  await expect(page).toHaveURL(/scope=personal/);
  await expect(page).toHaveURL(new RegExp("taskId="+writes[0].taskId));
  await expect(page.getByTestId("target-detail")).toBeVisible();
});
}
test("preflight timeout restores a retryable Area selection without CREATE",async({page})=>{
  test.setTimeout(45000);
  await page.setViewportSize({width:390,height:844});
  const writes=await setup(page,(route,cmd)=>reply(route,{ok:true,taskId:cmd.taskId},201));
  let timeoutRoute:Route|null=null;
  await page.route("**/api/target-staging/notes/create-preview",route=>{timeoutRoute=route;});
  await page.goto("/?view=Calendar");
  await openAndFill(page,390);
  await page.getByTestId("target-private-task-save").click();
  await expect.poll(()=>timeoutRoute!==null).toBe(true);
  await expect(page.getByTestId("target-private-task-area")).toHaveValue("",{timeout:15000});
  await expect(page.getByTestId("target-private-task-area")).toBeEnabled();
  expect(writes).toHaveLength(0);
  await (timeoutRoute as Route|null)?.abort("failed").catch(()=>{});
});
test("receipt timeout re-enables exact verification; never retries CREATE",async({page})=>{
  test.setTimeout(45000);
  await page.setViewportSize({width:1280,height:844});
  const writes=await setup(page,route=>reply(route,{error:"unavailable"},503));
  let timeoutRoute:Route|null=null;
  await page.route("**/api/target-staging/tasks/create-status",route=>{timeoutRoute=route;});
  await page.goto("/?view=Calendar");
  await openAndFill(page,1280);
  await page.getByTestId("target-private-task-save").click();
  const verify=page.getByTestId("target-private-task-receipt");
  await expect(verify).toBeEnabled();
  await verify.click();
  await expect.poll(()=>timeoutRoute!==null).toBe(true);
  await expect(verify).toBeEnabled({timeout:15000});
  expect(writes).toHaveLength(1);
  await (timeoutRoute as Route|null)?.abort("failed").catch(()=>{});
});

for(const width of [390,1280]){
  test("manual durable cancellation after rejected CREATE restores capture at "+width+"px",
    async({page})=>{
    await page.setViewportSize({width,height:844});
    let attempts=0,cancellations=0;
    const writes=await setup(page,(route,cmd)=>{
      attempts++;
      return attempts===1?reply(route,{error:"Too many requests"},429):
        reply(route,{ok:true,taskId:cmd.taskId},201);
    });
    await page.route("**/api/target-staging/tasks/create-cancel",route=>{
      cancellations++;
      const body=route.request().postDataJSON();
      expect(Object.keys(body)).toEqual(["commandId"]);
      expect(body.commandId).toBe(writes[0].commandId);
      return reply(route,{status:"cancelled"});
    });
    await page.goto("/?view=Calendar");
    const modal=await openAndFill(page,width);
    await page.getByTestId("target-private-task-save").click();
    const unresolved=page.getByTestId("target-private-task-unresolved");
    await expect(unresolved).toBeVisible();
    const marker=await page.evaluate(()=>
      sessionStorage.getItem("lumi-private-task-create-unresolved-v1"));
    expect(marker).toContain(writes[0].commandId);
    expect(marker).not.toContain(writes[0].title);
    await page.getByTestId("target-private-task-receipt").click();
    await expect(unresolved).toBeVisible(); // not_recorded is never release
    const cancel=page.getByTestId("target-private-task-cancel");
    await expect(cancel).toBeEnabled();
    await cancel.click();
    await expect(unresolved).toHaveCount(0);
    await expect(page.getByTestId("target-private-task-area")).toBeEnabled();
    expect(await page.evaluate(()=>
      sessionStorage.getItem("lumi-private-task-create-unresolved-v1"))).toBe(null);
    expect(cancellations).toBe(1);
    await page.getByTestId("target-private-task-area").selectOption("private-a");
    await page.getByTestId("target-private-task-form").getByRole("textbox",
      {name:"Název úkolu"}).fill("Nový úkol po zrušení");
    await page.getByTestId("target-private-task-save").click();
    await expect(modal).toHaveCount(0);
    await expect(page.getByTestId("target-private-task-created")).toBeVisible();
    expect(writes).toHaveLength(2);
    expect(writes[1].commandId).not.toBe(writes[0].commandId);
  });
}
/** A server may COMMIT the cancel fence even when the first HTTP response
 * is lost after visibility/offline suspension. UI must allow the same UUID
 * to be verified again; it must never release on a local abort alone. */
for(const [width,mode] of [[390,"visibility"],[1280,"offline"]] as const){
  test("interrupted cancellation wake keeps fence and safely retries at "+
    width+"px ("+mode+")",async({page})=>{
    await page.setViewportSize({width,height:844});
    const writes=await setup(page,route=>reply(route,
      {error:"Too many requests"},429));
    let cancelRequests=0,firstCancel:Route|null=null;
    await page.route("**/api/target-staging/tasks/create-cancel",route=>{
      cancelRequests++;
      expect(route.request().postDataJSON()).toEqual({
        commandId:writes[0].commandId,
      });
      if(cancelRequests===1){
        // Simulate a durable server cancellation whose first response is lost.
        firstCancel=route;
        return;
      }
      return reply(route,{status:"cancelled"});
    });
    await page.goto("/?view=Calendar");
    await openAndFill(page,width);
    await page.getByTestId("target-private-task-save").click();
    const unresolved=page.getByTestId("target-private-task-unresolved");
    await expect(unresolved).toBeVisible();
    const cancel=page.getByTestId("target-private-task-cancel");
    await expect(cancel).toBeEnabled();
    const marker=await page.evaluate(()=>
      sessionStorage.getItem("lumi-private-task-create-unresolved-v1"));
    expect(marker).toContain(writes[0].commandId);
    expect(marker).not.toContain(writes[0].title);
    await cancel.click();
    await expect.poll(()=>cancelRequests).toBe(1);
    await expect(cancel).toBeDisabled();
    // Trigger the same visibility/offline handlers used by useTargetWake.
    if(mode==="visibility"){
      await page.evaluate(()=>{
        Object.defineProperty(document,"visibilityState",{
          configurable:true,value:"hidden",
        });
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await page.evaluate(()=>{
        Reflect.deleteProperty(document,"visibilityState");
        document.dispatchEvent(new Event("visibilitychange"));
      });
    }else{
      await page.evaluate(()=>{
        Object.defineProperty(navigator,"onLine",{
          configurable:true,value:false,
        });
        window.dispatchEvent(new Event("offline"));
      });
      await page.evaluate(()=>{
        Reflect.deleteProperty(navigator,"onLine");
        window.dispatchEvent(new Event("online"));
      });
    }
    await expect(unresolved).toBeVisible();
    await expect(cancel).toBeEnabled({timeout:15000});
    const stillPending=await page.evaluate(()=>
      sessionStorage.getItem("lumi-private-task-create-unresolved-v1"));
    expect(stillPending).toBe(marker);
    expect(writes).toHaveLength(1);
    // The identical UUID is safe to retry only because server cancellation is
    // idempotent under the pinned SQLite write lock.
    await cancel.click();
    await expect(unresolved).toHaveCount(0);
    await expect(page.getByTestId("target-private-task-area")).toBeEnabled();
    expect(cancelRequests).toBe(2);
    expect(await page.evaluate(()=>
      sessionStorage.getItem("lumi-private-task-create-unresolved-v1"))).toBe(null);
    // A delayed response from the aborted first request cannot undo the proof.
    if(firstCancel)await (firstCancel as Route).fulfill({
      status:200,headers,body:JSON.stringify({status:"cancelled"}),
    }).catch(()=>{});
    expect(writes).toHaveLength(1);
  });
}

/** The original CREATE committed but was then deleted or lost Area access:
 * detail-guarded status and recovery must fail, while the immutable
 * actor+command receipt remains a content-free terminal proof. */
for(const [width,reload] of [[390,false],[1280,true]] as const){
  test("committed then inaccessible CREATE safely releases capture at "+
    width+"px"+(reload?" after reload":""),async({page})=>{
    await page.setViewportSize({width,height:844});
    let creates=0,settlements=0,checks=0;
    const writes=await setup(page,(route,cmd)=>{
      creates++;
      return creates===1?reply(route,{error:"Staging unavailable"},503):
        reply(route,{ok:true,taskId:cmd.taskId},201);
    });
    await page.route("**/api/target-staging/tasks/create-status",route=>{
      checks++;
      return reply(route,{error:"Not found"},404);
    });
    await page.route("**/api/target-staging/tasks/create-recovery",route=>{
      checks++;
      expect(route.request().postDataJSON()).toEqual({
        commandId:writes[0].commandId,
      });
      return reply(route,{error:"Not found"},404);
    });
    await page.route("**/api/target-staging/tasks/create-cancel",route=>{
      settlements++;
      expect(route.request().postDataJSON()).toEqual({
        commandId:writes[0].commandId,
      });
      expect(route.request().postData()).not.toContain(writes[0].title);
      return reply(route,{status:"settled"});
    });
    await page.goto("/?view=Calendar");
    let modal=await openAndFill(page,width);
    await page.getByTestId("target-private-task-save").click();
    const unresolved=page.getByTestId("target-private-task-unresolved");
    await expect(unresolved).toBeVisible();
    const marker=await page.evaluate(()=>
      sessionStorage.getItem("lumi-private-task-create-unresolved-v1"));
    expect(marker).toContain(writes[0].commandId);
    expect(marker).not.toContain(writes[0].title);
    if(reload){
      await page.reload();
      await fab(page,width).click();
      await page.getByTestId("target-capture-task-kind").click();
      modal=page.getByTestId("target-private-task-capture");
      await expect(modal).toBeVisible();
    }
    await page.getByTestId("target-private-task-receipt").click();
    await expect(page.getByTestId("target-private-task-cancel")).toBeEnabled();
    expect(checks).toBe(1);
    expect(await page.evaluate(()=>
      sessionStorage.getItem("lumi-private-task-create-unresolved-v1"))).toBe(marker);
    await page.getByTestId("target-private-task-cancel").click();
    await expect(unresolved).toHaveCount(0);
    await expect(modal).toContainText("Původní zápis byl proveden");
    expect(await page.evaluate(()=>
      sessionStorage.getItem("lumi-private-task-create-unresolved-v1"))).toBe(null);
    expect(settlements).toBe(1);
    await expect(page.getByTestId("target-private-task-created")).toHaveCount(0);
    await expect(page.getByTestId("target-private-task-area")).toBeEnabled();
    await page.getByTestId("target-private-task-area").selectOption("private-a");
    await page.getByTestId("target-private-task-form").getByRole("textbox",
      {name:"Název úkolu"}).fill("Nový úkol po terminálním potvrzení");
    await page.getByTestId("target-private-task-save").click();
    await expect(page.getByTestId("target-private-task-created")).toBeVisible();
    expect(writes).toHaveLength(2);
    expect(writes[1].commandId).not.toBe(writes[0].commandId);
    expect(writes[1].taskId).not.toBe(writes[0].taskId);
  });
}
/** Integrates merged #391 Search with this default-off private task capture.
 * Both feature flags are ON only in this isolated synthetic browser profile.
 * No automatic local task insertion, Search request or production write. */
for(const width of [390,1280]){
  test("authorized Search and private task Quick Capture coexist at "+width+"px",
    async({page})=>{
    await page.setViewportSize({width,height:844});
    const writes=await setup(page,(route,cmd)=>
      reply(route,{ok:true,taskId:cmd.taskId},201));
    const searches:{query:string;scope:string}[]=[];
    await page.route(/\/api\/target-staging\/title-search(?:\?|$)/,route=>{
      const url=new URL(route.request().url());
      const query=url.searchParams.get("q")??"";
      const scope=url.searchParams.get("scope")??"";
      searches.push({query,scope});
      expect(route.request().method()).toBe("GET");
      expect(query).toBe("integration");
      expect(scope).toBe("personal");
      const items=writes.length===1?[{
        kind:"task",id:writes[0].taskId,title:"Integration private task",
        areaId:"private-a",areaKind:"private",projectId:null,
      }]:[];
      return reply(route,{query,scope,items,hasMore:false,nextCursor:null});
    });
    await page.goto("/?view=Calendar&scope=personal");
    const input=page.locator(".searchField input");
    await input.fill("integration");
    const search=page.getByTestId("target-main-title-search");
    await expect(search).toBeVisible();
    await expect(search.locator(".targetMainSearchItems li")).toHaveCount(0);
    expect(searches).toHaveLength(0); // no implicit fetch on typing/focus
    await openAndFill(page,width,"Integration private task");
    await page.getByTestId("target-private-task-save").click();
    await expect(page.getByTestId("target-private-task-created")).toBeVisible();
    expect(writes).toHaveLength(1);
    await expect(search).toBeVisible();
    await expect(search.locator(".targetMainSearchItems li")).toHaveCount(0);
    expect(searches).toHaveLength(0); // CREATE must not trigger Search
    await search.getByRole("button",{name:"Vyhledat"}).click();
    await expect(search.locator(".targetMainSearchItems li")).toHaveCount(1);
    await expect(search).toContainText("Integration private task");
    await expect(search.locator('[data-area-kind="private"]')).toHaveCount(1);
    await expect(page.locator(".taskRow")).toHaveCount(0);
    expect(searches).toEqual([{query:"integration",scope:"personal"}]);
  });
}
