/** C15/C17: BFCache privacy witness in a REAL Chrome process.
 * Playwright launches Chromium with --disable-back-forward-cache. Even when
 * overridden, page.goBack() cannot synchronize with a BFCache thaw. This
 * standalone Chrome has neither that switch nor Playwright navigation control.
 * It uses the isolated personal-v1 SQLite server and test-owner session cookie.
 * The strict release gate accepts restoration or a browser-explained miss,
 * but both branches must prove private draft fencing and fresh authorization.
 */
import {spawn} from "node:child_process";
import {existsSync,mkdtempSync,readFileSync} from "node:fs";
import path from "node:path";
import {randomUUID} from "node:crypto";
import {chromium,test,expect} from "@playwright/test";
import {matchingNativeBackReasons,validateNativeBackEvidence} from "./target-personal-native-bfcache-gate";
import {stopNativeChromeAndRemoveProfile,watchNativeChromeClose} from "./native-chrome-cleanup";
import type {NativeBackEvidence,NativeCacheNotUsedEvent} from "./target-personal-native-bfcache-gate";

test.skip(process.env.LUMI_TARGET_PERSONAL_ACCEPTANCE_E2E!=="true",
  "Requires isolated personal-v1 real-store profile");
const dir=process.env.LUMI_E2E_RUN_DIR;
const store=JSON.parse(process.env.LUMI_E2E_TARGET_STORE||"null") as
  {seed?:{areaTitle?:string}}|null;
const origin="http://localhost:"+Number(process.env.E2E_PORT||3100);
const strict=process.env.LUMI_REAL_BFCACHE_E2E==="true";
const pause=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
// Native Chromium is driven by raw CDP, outside Playwright navigation control.
// Every handshake and protocol reply MUST be bounded: otherwise a hung socket
// outlives the waitFor deadlines and Playwright kills the test at 120s without
// any browser evidence or the name of the stalled operation.
const CDP_REPLY_TIMEOUT_MS=12_000;
async function waitFor<T>(label:string,fn:()=>Promise<T|null|undefined|false>,ms=20000):Promise<T>{
  const end=Date.now()+ms;
  let lastError:unknown;
  while(Date.now()<end){
    try{const result=await fn();if(result)return result as T;}
    catch(error){lastError=error;}
    await pause(120);
  }
  throw Error("Native BFCache timeout: "+label+
    (lastError===undefined?"":"; last CDP error: "+String(lastError)));
}
class CDP{
  private seq=0;
  private requests=new Map<number,{resolve:(value:any)=>void;reject:(e:Error)=>void}>();
  private observers=new Map<string,Set<(value:any)=>void>>();
  private constructor(private socket:WebSocket){
    socket.addEventListener("message",event=>{
      const msg=JSON.parse(String(event.data));
      if(typeof msg.method==="string"){
        for(const observer of this.observers.get(msg.method)||[])
          observer(msg.params||{});
      }
      if(typeof msg.id!=="number")return;
      const cb=this.requests.get(msg.id);
      if(!cb)return;
      this.requests.delete(msg.id);
      if(msg.error)cb.reject(Error(msg.error.message));
      else cb.resolve(msg.result||{});
    });
    socket.addEventListener("close",()=>{
      for(const cb of this.requests.values())cb.reject(Error("Chrome CDP disconnected"));
      this.requests.clear();
    });
  }
  static async connect(url:string){
    const ws=new WebSocket(url);
    await new Promise<void>((resolve,reject)=>{
      let finished=false;
      const settle=(error?:Error)=>{
        if(finished)return;
        finished=true;clearTimeout(timer);
        if(error){
          try{ws.close();}catch{/* connecting socket may already be closed */}
          reject(error);
        }else resolve();
      };
      const timer=setTimeout(()=>settle(Error(
        "Chrome CDP WebSocket handshake exceeded "+CDP_REPLY_TIMEOUT_MS+"ms")),
        CDP_REPLY_TIMEOUT_MS);
      ws.addEventListener("open",()=>settle(),{once:true});
      ws.addEventListener("error",()=>settle(Error("Cannot attach to Chrome")),{once:true});
      ws.addEventListener("close",()=>settle(Error("Chrome closed before CDP attached")),{once:true});
    });
    return new CDP(ws);
  }
  send(method:string,params:Record<string,unknown>={}):Promise<any>{
    return new Promise((resolve,reject)=>{
      if(this.socket.readyState!==WebSocket.OPEN){
        reject(Error("Chrome CDP socket not open for "+method));return;
      }
      const id=++this.seq;
      const timer=setTimeout(()=>{
        this.requests.delete(id);
        reject(Error("Chrome CDP reply timed out: "+method+
          " (request "+id+", "+CDP_REPLY_TIMEOUT_MS+"ms)"));
      },CDP_REPLY_TIMEOUT_MS);
      this.requests.set(id,{
        resolve:value=>{clearTimeout(timer);resolve(value);},
        reject:error=>{clearTimeout(timer);reject(error);},
      });
      try{this.socket.send(JSON.stringify({id,method,params}));}
      catch(error){
        this.requests.delete(id);clearTimeout(timer);reject(error);
      }
    });
  }
  async eval<T>(expression:string):Promise<T>{
    const reply=await this.send("Runtime.evaluate",{expression,returnByValue:true});
    if(reply.exceptionDetails)throw Error("Browser expression failed: "+
      JSON.stringify(reply.exceptionDetails).slice(0,500));
    return reply.result?.value as T;
  }
  on(method:string,handler:(value:any)=>void):()=>void{
    const handlers=this.observers.get(method)||new Set<(value:any)=>void>();
    handlers.add(handler);this.observers.set(method,handlers);
    return ()=>handlers.delete(handler);
  }
  close(){this.socket.close();}
}
async function nativeBrowser(width:number){
  console.log("NATIVE_BFCACHE_PHASE "+JSON.stringify({width,phase:"launching isolated Chrome"}));
  if(!dir||!existsSync(dir)||!store?.seed?.areaTitle)
    throw Error("Only an isolated E2E target store may be used");
  const profile=mkdtempSync(path.join(dir,"native-bfcache-"+width+"-"));
  const chrome=spawn(chromium.executablePath(),[
    "--headless=new","--no-sandbox","--no-first-run",
    "--remote-debugging-port=0","--user-data-dir="+profile,
    "--window-size="+width+",844","about:blank",
  ],{stdio:"ignore",detached:process.platform!=="win32"});
  // Observe close immediately after spawn; exit/close may precede teardown.
  const closeWatch=watchNativeChromeClose(chrome);
  try{
    const port=await waitFor("Chrome DevToolsActivePort",async()=>{
      if(chrome.exitCode!==null)throw Error("Chrome exited "+chrome.exitCode);
      const filename=path.join(profile,"DevToolsActivePort");
      return existsSync(filename)?Number(readFileSync(filename,"utf8").split("\n")[0]):null;
    });
    console.log("NATIVE_BFCACHE_PHASE "+JSON.stringify({width,phase:"Chrome DevTools port ready"}));
    const pageSocket=await waitFor("Chrome page target",async()=>{
      // A non-responsive DevTools JSON endpoint must not leave the outer
      // waitFor() loop stuck beyond its own deadline (fetch includes body).
      const pages=await fetch("http://127.0.0.1:"+port+"/json/list",{
        signal:AbortSignal.timeout(5_000),
      }).then(r=>r.json()) as {type:string;webSocketDebuggerUrl?:string}[];
      return pages.find(p=>p.type==="page")?.webSocketDebuggerUrl||null;
    });
    console.log("NATIVE_BFCACHE_PHASE "+JSON.stringify({width,phase:"attaching Chrome CDP"}));
    const cdp=await CDP.connect(pageSocket);
    // Chromium requires the Page domain to be enabled for document-start
    // injection. Without this, missing pageshow instrumentation resembles
    // a BFCache miss and prevents diagnostic collection.
    await cdp.send("Page.enable");
    const state=JSON.parse(readFileSync(path.join(dir,"session.json"),"utf8")) as
      {cookies:{name:string;value:string;path?:string;httpOnly?:boolean;
        secure?:boolean;sameSite?:string}[]};
    if(!state.cookies.length)throw Error("Missing isolated owner cookie");
    for(const cookie of state.cookies){
      const result=await cdp.send("Network.setCookie",{
        url:origin,name:cookie.name,value:cookie.value,path:cookie.path||"/",
        httpOnly:!!cookie.httpOnly,secure:!!cookie.secure,
        ...(cookie.sameSite?{sameSite:cookie.sameSite}:{})
      });
      if(!result.success)throw Error("Owner cookie installation failed");
    }
    await cdp.send("Page.addScriptToEvaluateOnNewDocument",{source:
      "window.__lumiNative={shows:[],docToken:Math.random().toString(36).slice(2)};"+
      "addEventListener('pageshow',e=>window.__lumiNative.shows.push(e.persisted))"});
    console.log("NATIVE_BFCACHE_PHASE "+JSON.stringify({width,phase:"Chrome CDP ready"}));
    return {profile,chrome,closeWatch,cdp};
  }catch(e){
    await stopNativeChromeAndRemoveProfile(chrome,closeWatch,profile);
    throw e;
  }
}
function snapshotExpression(secret:string){
  return "(()=>{const secret="+JSON.stringify(secret)+";"+
    "const nav=performance.getEntriesByType('navigation')[0];"+
    "const select=document.querySelector('[data-testid=\"target-private-task-area\"]');"+
    "const inputs=[...document.querySelectorAll('input,textarea')];"+
    "const offset=window.__lumiBeforeLeave;"+
    "const reads=performance.getEntriesByType('resource').slice("+
    "(Number.isInteger(offset)?offset:0)).map(x=>new URL(x.name).pathname);"+
    "return {url:location.href,shows:window.__lumiNative?.shows??[],"+
    "observerInstalled:!!window.__lumiNative,documentToken:window.__lumiNative?.docToken??null,"+
    "persisted:window.__lumiNative?.shows?.includes(true)===true,"+
    "navigationType:nav?.type??'missing',"+
    "notRestoredReasons:nav?.notRestoredReasons?"+
    "{reasons:nav.notRestoredReasons.reasons??null,"+
    "children:nav.notRestoredReasons.children?.map(x=>({reasons:x.reasons??null,url:x.url??null}))??null}:"+
    "null,"+
    "userAgent:navigator.userAgent,titleVisible:inputs.some(x=>x.value.includes(secret))||"+
    "document.documentElement.outerHTML.includes(secret),"+
    "area:select?.value??null,reads:reads.filter(x=>x.startsWith('/api/target-staging/')),"+
    "storageLeak:JSON.stringify([Object.entries(localStorage),Object.entries(sessionStorage)]).includes(secret)}"+
    "})()";
}
for(const width of [390,1280]){
  test("native Chrome actual BFCache witness "+width+"px",async()=>{
    test.setTimeout(120000);
    const {profile,chrome,closeWatch,cdp}=await nativeBrowser(width);
    let phase="before initial navigation";
    const enter=(next:string)=>{
      phase=next;
      // The raw native CDP client is not represented in Playwright traces.
      // Emit only the stage and viewport, never private task text or cookies.
      console.log("NATIVE_BFCACHE_PHASE "+JSON.stringify({width,phase}));
    };
    enter(phase);
    let secret="";
    let preBack: {shows:boolean[];docToken:string}|null=null;
    let initialPageShowObserved=false;
    let postBackObserved=false;
    let evaluatedBranch:"restored"|"not_restored"|null=null;
    let topFrameId:string|null=null;
    let returnedLoaderId:string|null=null;
    let backReasonStartIndex:number|null=null;
    const cacheNotUsed:NativeCacheNotUsedEvent[]=[];
    // Record actual HTTP completions rather than inferring authorization from
    // PerformanceResourceTiming names (which have no method/status). Register
    // before navigation: wake requests can race a post-Back CDP snapshot.
    type NativeRead={
      requestId:string;path:string;method:string;requestOrder:number;
      responseOrder?:number;status?:number;finishedOrder?:number;
      failed?:boolean;failureReason?:string;cancelled?:boolean;
      fromServiceWorker?:boolean;fromDiskCache?:boolean;
      fromPrefetchCache?:boolean;cacheServed?:boolean
    };
    const reads:NativeRead[]=[];
    const pendingReads=new Map<string,NativeRead>();
    // Observe every task CREATE from before the first app navigation through
    // teardown, not just after a successful BFCache restore. Otherwise an
    // automatic replay during pagehide/pageshow/wake can escape detection.
    // Never retain POST bodies, private titles, URL queries or auth headers.
    const taskCreatePosts:{phase:string;path:string}[]=[];
    let networkOrder=0;
    let backReadMark:number|null=null;
    const targetReadPaths=new Set([
      "/api/target-staging/session",
      "/api/target-staging/notes/create-targets",
    ]);
    const unsubscribeRequest=cdp.on("Network.requestWillBeSent",event=>{
      const e=event as {requestId:string;request:{url:string;method:string}};
      const url=new URL(e.request.url);
      if(url.origin!==origin)return;
      if(e.request.method==="POST"&&url.pathname==="/api/target-staging/tasks")
        taskCreatePosts.push({phase,path:url.pathname});
      if(!targetReadPaths.has(url.pathname))return;
      const read:NativeRead={requestId:e.requestId,path:url.pathname,
        method:e.request.method,requestOrder:++networkOrder};
      reads.push(read);
      pendingReads.set(e.requestId,read);
    });
    const unsubscribeCached=cdp.on("Network.requestServedFromCache",event=>{
      const read=pendingReads.get((event as {requestId:string}).requestId);
      if(read)read.cacheServed=true;
    });
    const unsubscribeResponse=cdp.on("Network.responseReceived",event=>{
      const e=event as {requestId:string;response:{
        status:number;fromServiceWorker?:boolean;fromDiskCache?:boolean;
        fromPrefetchCache?:boolean
      }};
      const read=pendingReads.get(e.requestId);
      if(!read)return;
      read.status=e.response.status;
      read.fromServiceWorker=e.response.fromServiceWorker===true;
      read.fromDiskCache=e.response.fromDiskCache===true;
      read.fromPrefetchCache=e.response.fromPrefetchCache===true;
      read.responseOrder=++networkOrder;
    });
    const unsubscribeFinished=cdp.on("Network.loadingFinished",event=>{
      const read=pendingReads.get((event as {requestId:string}).requestId);
      if(!read)return;
      read.finishedOrder=++networkOrder;
      pendingReads.delete(read.requestId);
    });
    const unsubscribeFailed=cdp.on("Network.loadingFailed",event=>{
      const failure=event as {requestId:string;errorText?:string;canceled?:boolean};
      const read=pendingReads.get(failure.requestId);
      if(!read)return;
      read.failed=true;
      // Transport metadata only; never include private response content.
      read.failureReason=failure.errorText;
      read.cancelled=failure.canceled===true;
      pendingReads.delete(read.requestId);
    });
    const successfulRead=(path:string,afterOrder:number|null|undefined=backReadMark)=>reads.find(read=>
      afterOrder!=null&&read.requestOrder>afterOrder&&
      read.path===path&&read.method==="GET"&&read.status===200&&
      read.fromServiceWorker===false&&read.fromDiskCache===false&&
      read.fromPrefetchCache===false&&read.cacheServed!==true&&
      read.responseOrder!==undefined&&read.finishedOrder!==undefined&&!read.failed);
    const unsubscribeNotUsed=cdp.on("Page.backForwardCacheNotUsed",event=>{
      const data=event as {frameId?:string;loaderId?:string;
        notRestoredExplanations?:{reason:string;type:string}[]};
      // Record frame AND loader identity. The explanation for an old page
      // navigation, or for a child frame, cannot certify the current Back.
      cacheNotUsed.push({frameId:data.frameId,loaderId:data.loaderId,
        reasons:(data.notRestoredExplanations||[])
          .map(reason=>({reason:reason.reason,type:reason.type}))});
    });
    function backObservation(browser:Record<string,unknown>):NativeBackEvidence{
      return {
        initialPageShowObserved,postBackPageShowObserved:postBackObserved,
        persisted:typeof browser.persisted==="boolean"?browser.persisted:null,
        originalDocumentToken:preBack?.docToken??null,
        returnedDocumentToken:typeof browser.documentToken==="string"?browser.documentToken:null,
        topFrameId,returnedLoaderId,backReasonStartIndex,cacheNotUsed,
      };
    }
    async function evidence(status:"observed"|"wake-authorized"|"completed"|"failure",error?:unknown){
      let browser:Record<string,unknown>;
      try{browser=await cdp.eval<Record<string,unknown>>(snapshotExpression(secret));}
      catch(snapshotError){browser={snapshotError:String(snapshotError)};}
      const record={status,phase,width,
        checkedOutSha:process.env.LUMI_TESTED_CHECKOUT_SHA??null,
        postBackObserved,initialPageShowObserved,evaluatedBranch,
        topFrameId,returnedLoaderId,backReasonStartIndex,
        preBack,cacheNotUsed,
        recordedNotRestoredReasonCount:matchingNativeBackReasons(
          backObservation(browser)).length,browser,
        taskCreatePostCount:taskCreatePosts.length,
        taskCreatePostStages:taskCreatePosts.map(post=>post.phase),
        // Only endpoint paths and outcomes; never include request bodies, task
        // names, URLs with query strings, cookies or authorization headers.
        freshHttpReads:reads.filter(read=>backReadMark!==null&&
          read.requestOrder>backReadMark).map(read=>({
          path:read.path,method:read.method,status:read.status??null,
          responseOrder:read.responseOrder??null,requestOrder:read.requestOrder,
          finished:read.finishedOrder!==undefined,failed:read.failed===true,
          failureReason:read.failureReason??null,cancelled:read.cancelled??null,
          fromServiceWorker:read.fromServiceWorker??null,
          fromDiskCache:read.fromDiskCache??null,
          fromPrefetchCache:read.fromPrefetchCache??null,
          cacheServed:read.cacheServed===true,
        })),
        ...(error===undefined?{}:{error:String(error)})};
      console.log("NATIVE_REAL_BFCACHE_EVIDENCE "+JSON.stringify(record));
      await test.info().attach("native-bfcache-"+width+"-"+status+".json",{
        body:Buffer.from(JSON.stringify(record,null,2)),contentType:"application/json"});
      return browser;
    }
    try{
      if(strict)expect(process.env.LUMI_TESTED_CHECKOUT_SHA,
        "Strict native evidence requires the verified checkout SHA").toMatch(/^[a-f0-9]{40}$/);
      await cdp.send("Network.enable");
      await cdp.send("Emulation.setDeviceMetricsOverride",{
        width,height:844,deviceScaleFactor:1,mobile:width===390});
      await cdp.send("Page.navigate",{url:origin+"/?view=Calendar&scope=personal"});
      // This is a prerequisite, not a BFCache hit: the initial navigation
      // must fire the genuine (persisted:false) pageshow before drafting.
      enter("awaiting initial native pageshow");
      await waitFor("initial browser-fired pageshow",()=>cdp.eval<boolean>(
        "window.__lumiNative?.shows?.includes(false)===true"));
      initialPageShowObserved=true;
      const fab='[data-target-private-capture-fab="'+(width===390?"mobile":"desktop")+'"]';
      await waitFor("authenticated global capture",()=>cdp.eval<boolean>(
        "!!document.querySelector("+JSON.stringify(fab)+")"));
      await cdp.eval("document.querySelector("+JSON.stringify(fab)+").click()");
      await waitFor("task chooser",()=>cdp.eval<boolean>(
        "!!document.querySelector('[data-testid=\"target-capture-task-kind\"]')"));
      await cdp.eval("document.querySelector('[data-testid=\"target-capture-task-kind\"]').click()");
      const areaTitle=JSON.stringify(store!.seed!.areaTitle);
      await waitFor("authorized Area catalog",()=>cdp.eval<boolean>(
        "Array.from(document.querySelector('[data-testid=\"target-private-task-area\"]')?.options||[]).some(x=>x.textContent==="+areaTitle+")"));
      await cdp.eval("(()=>{const s=document.querySelector('[data-testid=\"target-private-task-area\"]');"+
        "s.value=Array.from(s.options).find(x=>x.textContent==="+areaTitle+").value;"+
        "s.dispatchEvent(new Event('change',{bubbles:true}))})()");
      await waitFor("private task form",()=>cdp.eval<boolean>(
        "!!document.querySelector('[data-testid=\"target-private-task-form\"]')"));
      secret="C15 private "+width+" "+randomUUID();
      await cdp.eval("(()=>{const x=document.querySelector('[data-testid=\"target-private-task-form\"] input');"+
        "Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(x,"+
        JSON.stringify(secret)+");x.dispatchEvent(new Event('input',{bubbles:true}))})()");
      await waitFor("React-bound draft",()=>cdp.eval<boolean>(
        "document.querySelector('[data-testid=\"target-private-task-form\"] input')?.value==="+JSON.stringify(secret)));
      await cdp.eval("window.__lumiBeforeLeave=performance.getEntriesByType('resource').length;"+
        "window.__lumiShowsBeforeLeave=window.__lumiNative?.shows.length??0");
      preBack=await cdp.eval<{shows:boolean[];docToken:string}>(
        "({shows:[...window.__lumiNative.shows],docToken:window.__lumiNative.docToken})");
      enter("navigating away to robots.txt");
      // Both navigations are native browser actions; no Playwright goBack and
      // no synthetic PageTransitionEvent. Keep the private response no-store.
      await cdp.eval("location.assign('/robots.txt');true");
      await waitFor("robots.txt",()=>cdp.eval<boolean>("location.pathname==='/robots.txt'"));
      // Frame identity is stable for same-tab Back; loader identity is not.
      // Save the event boundary BEFORE history.back() so earlier CDP misses
      // cannot satisfy this navigation's strict evidence requirement.
      const beforeBackFrame=(await cdp.send("Page.getFrameTree"))
        .frameTree?.frame as {id?:string}|undefined;
      if(!beforeBackFrame?.id)throw Error("No top-level frame before native Back");
      topFrameId=beforeBackFrame.id;
      backReasonStartIndex=cacheNotUsed.length;
      // Only requests begun after this marker may certify a fresh wake.
      backReadMark=networkOrder;
      enter("native history.back");
      await cdp.eval("history.back();true");
      await waitFor("native browser back",()=>cdp.eval<boolean>(
        "location.search.includes('view=Calendar')"));
      // A navigation can commit to the destination before its pageshow
      // actually fires. An earlier snapshot saw shows:[] and incorrectly
      // classified that in-flight navigation as a BFCache miss.
      enter("awaiting actual post-Back pageshow");
      await waitFor("actual browser-fired pageshow after Back",()=>cdp.eval<boolean>(
        "!!window.__lumiNative?.shows.length && ("+
        "window.__lumiShowsBeforeLeave===undefined || "+
        "window.__lumiNative.shows.length>window.__lumiShowsBeforeLeave)"));
      postBackObserved=true;
      const afterBackFrame=(await cdp.send("Page.getFrameTree"))
        .frameTree?.frame as {id?:string;loaderId?:string}|undefined;
      expect(afterBackFrame?.id,"Back changed top-level frame identity")
        .toBe(topFrameId);
      returnedLoaderId=afterBackFrame?.loaderId??null;
      enter("asserting native Back privacy and authorization");
      const first=await evidence("observed");
      expect(first.titleVisible,"Private draft remains in DOM").toBe(false);
      expect(first.storageLeak,"Private draft persisted to browser storage").toBe(false);
      expect(["",null],"Old private Area remains selected").toContain(first.area);
      expect(taskCreatePosts,"Abandoned draft CREATE before/during native Back")
        .toHaveLength(0);
      // The native CDP event may arrive just after the pageshow observer.
      // In strict mode wait specifically for a reason associated with the
      // post-Back top-level frame AND the returned loader, never stale events.
      if(strict&&first.persisted===false)
        await waitFor("CDP reasons for the returned top-level Back loader",async()=>
          matchingNativeBackReasons(backObservation(first)).length>0);
      evaluatedBranch=validateNativeBackEvidence(backObservation(first),{strict});
      expect(evaluatedBranch).toBe(first.persisted?"restored":"not_restored");
      // The original document token survives an actual cache restoration but
      // MUST change on a cache miss. The two paths share the privacy invariants.
      if(first.persisted){
        // The genuinely resumed document must be the exact private editor
        // document we left, rather than a fresh navigation or SPA transition.
        expect(first.documentToken,"BFCache returned a different document")
          .toBe(preBack?.docToken);
        // A resource name is insufficient: require a *new* completed GET 200
        // from the real HTTP origin for BOTH endpoints. A 401/403/500,
        // aborted request or SW response must not count as authorization.
        // The successful session response must complete BEFORE the Area
        // request starts, and all of this precedes the next user action.
        const authorized=await waitFor("fresh authorized GET 200 session then Area",async()=>{
          const session=successfulRead("/api/target-staging/session");
          const area=successfulRead("/api/target-staging/notes/create-targets");
          return session&&area&&session.finishedOrder!<area.requestOrder
            ?{session,area}:null;
        });
        expect(authorized.session.finishedOrder).toBeLessThan(
          authorized.area.requestOrder);
        const awake=await cdp.eval<any>(snapshotExpression(secret));
        expect(awake.titleVisible).toBe(false);
        expect(["",null]).toContain(awake.area);
        await evidence("wake-authorized");
        expect(taskCreatePosts,"Automatic CREATE during BFCache wake/revalidation")
          .toHaveLength(0);
        // Before any new action we have proved a fresh authorized session and
        // Area lookup. Only now may the user reselect the private Area. Neither
        // the abandoned text nor an executable old CREATE may be revived.
        const label=JSON.stringify(store!.seed!.areaTitle);
        await waitFor("refreshed authorized private Area",()=>cdp.eval<boolean>(
          "Array.from(document.querySelector('[data-testid=\"target-private-task-area\"]')?.options||[]).some(x=>x.textContent==="+label+")"));
        await cdp.eval("(()=>{const s=document.querySelector('[data-testid=\"target-private-task-area\"]');"+
          "s.value=Array.from(s.options).find(x=>x.textContent==="+label+").value;"+
          "s.dispatchEvent(new Event('change',{bubbles:true}))})()");
        await waitFor("new empty composer",()=>cdp.eval<boolean>(
          "!!document.querySelector('[data-testid=\"target-private-task-form\"] input')"));
        const postRestoreTitle=await cdp.eval<string>(
          "document.querySelector('[data-testid=\"target-private-task-form\"] input').value");
        expect(postRestoreTitle,"Old React draft reappeared after Area reselect").toBe("");
        expect(taskCreatePosts,"Automatic CREATE after private Area reselect")
          .toHaveLength(0);
        enter("attempting empty-composer save after BFCache restore");
        await cdp.eval("document.querySelector('[data-testid=\"target-private-task-save\"]').click()");
        await pause(300);
        expect(taskCreatePosts,"Blank restored composer must not submit CREATE")
          .toHaveLength(0);
      }else{
        // Cache-Control: no-store is retained: an explained native cache miss
        // is acceptable in strict mode, but an unexplained miss is not.
        expect(first.documentToken,"A BFCache miss must create a new document")
          .not.toBe(preBack?.docToken);
        // Strict validation already required a matching browser CDP reason
        // for this precise Back/loader (or rejected the unexplained miss).
        // Prove a newly completed direct HTTP GET 200 for the owner session
        // BEFORE any new editor action; cached, failed and SW reads are excluded.
        const session=await waitFor("fresh authorized session after native Back",async()=>
          successfulRead("/api/target-staging/session"));
        expect(taskCreatePosts,"Automatic CREATE during cache-miss reload")
          .toHaveLength(0);
        enter("reopening private editor after newly authorized reload");
        await waitFor("private capture after reload",()=>cdp.eval<boolean>(
          "!!document.querySelector("+JSON.stringify(fab)+")"));
        await cdp.eval("document.querySelector("+JSON.stringify(fab)+").click()");
        await waitFor("fresh task chooser after reload",()=>cdp.eval<boolean>(
          "!!document.querySelector('[data-testid=\"target-capture-task-kind\"]')"));
        await cdp.eval("document.querySelector('[data-testid=\"target-capture-task-kind\"]').click()");
        // A new document does not load Area choices until the user opens the
        // task editor. A 200 response whose body was cancelled by a competing
        // mobile wake is NOT an authorization witness. The normal path must
        // finish; recovery is permitted only via the visible user Retry action
        // and a NEW completed session + Area GET, never a stale/cached body.
        const areaPath="/api/target-staging/notes/create-targets";
        const firstArea=await waitFor("complete private Area GET or explicit retry after transport abort",async()=>{
          const complete=successfulRead(areaPath);
          if(complete)return {kind:"complete" as const,read:complete};
          const interrupted=reads.some(read=>
            backReadMark!==null&&read.requestOrder>backReadMark&&
            read.path===areaPath&&read.method==="GET"&&read.status===200&&
            read.failed===true&&read.cancelled===true);
          if(!interrupted)return null;
          const retryReady=await cdp.eval<boolean>(
            "!!document.querySelector('[data-testid=target-private-task-retry]')");
          return retryReady?{kind:"retry" as const}:null;
        });
        let areaRead:NativeRead;
        if(firstArea.kind==="retry"){
          enter("explicitly recovering a cancelled private Area response");
          expect(taskCreatePosts,"No task CREATE before explicit Area retry").toHaveLength(0);
          const cancelledSnapshot=await cdp.eval<any>(snapshotExpression(secret));
          expect(cancelledSnapshot.titleVisible,"Abandoned draft during cancelled read").toBe(false);
          expect(["",null],"Old Area during cancelled read").toContain(cancelledSnapshot.area);
          // This is a real user retry, never automatic client authorization.
          // The retry button itself verifies a fresh session before re-reading.
          const beforeRetry=networkOrder;
          await cdp.eval("document.querySelector('[data-testid=target-private-task-retry]').click()");
          const retriedSession=await waitFor("completed owner session GET after explicit retry",async()=>
            successfulRead("/api/target-staging/session",beforeRetry));
          areaRead=await waitFor("completed private Area GET after reauthorization",async()=>
            successfulRead(areaPath,retriedSession.finishedOrder));
          expect(retriedSession.finishedOrder,"Retry Area read must follow new session authorization")
            .toBeLessThan(areaRead.requestOrder);
        }else areaRead=firstArea.read;
        expect(session.finishedOrder,"Session authorization must precede private Area access")
          .toBeLessThan(areaRead.requestOrder);
        const label=JSON.stringify(store!.seed!.areaTitle);
        await waitFor("new authorized private Area choices",()=>cdp.eval<boolean>(
          "Array.from(document.querySelector('[data-testid=\"target-private-task-area\"]')?.options||[]).some(x=>x.textContent==="+label+")"));
        const fresh=await cdp.eval<any>(snapshotExpression(secret));
        expect(fresh.titleVisible,"Old private text resurfaced after reopening").toBe(false);
        expect(["",null],"Old Area selection resurfaced after reopening").toContain(fresh.area);
        expect(taskCreatePosts,"Reopening must not replay abandoned CREATE").toHaveLength(0);
        await evidence("wake-authorized");
        await cdp.eval("(()=>{const s=document.querySelector('[data-testid=\"target-private-task-area\"]');"+
          "s.value=Array.from(s.options).find(x=>x.textContent==="+label+").value;"+
          "s.dispatchEvent(new Event('change',{bubbles:true}))})()");
        await waitFor("new empty task composer after cache miss",()=>cdp.eval<boolean>(
          "!!document.querySelector('[data-testid=\"target-private-task-form\"] input')"));
        const newTitle=await cdp.eval<string>(
          "document.querySelector('[data-testid=\"target-private-task-form\"] input').value");
        expect(newTitle,"Abandoned draft became submittable after cache miss").toBe("");
        expect(taskCreatePosts,"Unexpected CREATE after new Area selection").toHaveLength(0);
        enter("attempting empty-composer save after explained cache miss");
        await cdp.eval("document.querySelector('[data-testid=\"target-private-task-save\"]').click()");
        await pause(300);
        expect(taskCreatePosts,"Blank composer after cache miss must not submit CREATE")
          .toHaveLength(0);
      }
      // Final record is captured AFTER the empty Save attempt, so CREATE=0
      // covers the entire native navigation and re-opening lifecycle.
      await evidence("completed");
    }catch(error){
      // Attach and log the state even when native pageshow never fires:
      // a broken observer, a reload and a genuine BFCache miss are distinct.
      await evidence("failure",error).catch(diagnosticError=>
        console.log("NATIVE_BFCACHE_DIAGNOSTIC_ERROR "+String(diagnosticError)));
      throw error;
    }finally{
      unsubscribeRequest();
      unsubscribeCached();
      unsubscribeResponse();
      unsubscribeFinished();
      unsubscribeFailed();
      unsubscribeNotUsed();
      cdp.close();
      await stopNativeChromeAndRemoveProfile(chrome,closeWatch,profile);
    }
  });
}
