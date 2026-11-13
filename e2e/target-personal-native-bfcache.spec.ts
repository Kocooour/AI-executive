/** C15: BFCache witness in a REAL Chrome process.
 * Playwright launches Chromium with --disable-back-forward-cache. Even when
 * overridden, page.goBack() cannot synchronize with a BFCache thaw. This
 * standalone Chrome has neither that switch nor Playwright navigation control.
 * It uses the isolated personal-v1 SQLite server and test-owner session cookie.
 */
import {spawn} from "node:child_process";
import {existsSync,mkdtempSync,readFileSync,rmSync} from "node:fs";
import path from "node:path";
import {randomUUID} from "node:crypto";
import {chromium,test,expect} from "@playwright/test";

test.skip(process.env.LUMI_TARGET_PERSONAL_ACCEPTANCE_E2E!=="true",
  "Requires isolated personal-v1 real-store profile");
const dir=process.env.LUMI_E2E_RUN_DIR;
const store=JSON.parse(process.env.LUMI_E2E_TARGET_STORE||"null") as
  {seed?:{areaTitle?:string}}|null;
const origin="http://localhost:"+Number(process.env.E2E_PORT||3100);
const strict=process.env.LUMI_REAL_BFCACHE_E2E==="true";
const pause=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
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
      ws.addEventListener("open",()=>resolve(),{once:true});
      ws.addEventListener("error",()=>reject(Error("Cannot attach to Chrome")),{once:true});
    });
    return new CDP(ws);
  }
  send(method:string,params:Record<string,unknown>={}):Promise<any>{
    return new Promise((resolve,reject)=>{
      const id=++this.seq;
      this.requests.set(id,{resolve,reject});
      this.socket.send(JSON.stringify({id,method,params}));
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
  if(!dir||!existsSync(dir)||!store?.seed?.areaTitle)
    throw Error("Only an isolated E2E target store may be used");
  const profile=mkdtempSync(path.join(dir,"native-bfcache-"+width+"-"));
  const chrome=spawn(chromium.executablePath(),[
    "--headless=new","--no-sandbox","--no-first-run",
    "--remote-debugging-port=0","--user-data-dir="+profile,
    "--window-size="+width+",844","about:blank",
  ],{stdio:"ignore"});
  try{
    const port=await waitFor("Chrome DevToolsActivePort",async()=>{
      if(chrome.exitCode!==null)throw Error("Chrome exited "+chrome.exitCode);
      const filename=path.join(profile,"DevToolsActivePort");
      return existsSync(filename)?Number(readFileSync(filename,"utf8").split("\n")[0]):null;
    });
    const pageSocket=await waitFor("Chrome page target",async()=>{
      const pages=await fetch("http://127.0.0.1:"+port+"/json/list")
        .then(r=>r.json()) as {type:string;webSocketDebuggerUrl?:string}[];
      return pages.find(p=>p.type==="page")?.webSocketDebuggerUrl||null;
    });
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
    return {profile,chrome,cdp};
  }catch(e){
    chrome.kill("SIGKILL");rmSync(profile,{recursive:true,force:true,maxRetries:20,retryDelay:100});throw e;
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
    const {profile,chrome,cdp}=await nativeBrowser(width);
    let phase="before initial navigation";
    let secret="";
    let preBack: {shows:boolean[];docToken:string}|null=null;
    const cacheNotUsed: {reasons:{reason:string;type:string}[];frameId?:string}[]=[];
    const unsubscribeNotUsed=cdp.on("Page.backForwardCacheNotUsed",event=>{
      const data=event as {frameId?:string;notRestoredExplanations?:{reason:string;type:string}[]};
      // Keep reasons and frame identity only: no cookies, paths or private data.
      cacheNotUsed.push({frameId:data.frameId,reasons:(data.notRestoredExplanations||[])
        .map(reason=>({reason:reason.reason,type:reason.type}))});
    });
    async function evidence(status:"observed"|"failure",error?:unknown){
      let browser:Record<string,unknown>;
      try{browser=await cdp.eval<Record<string,unknown>>(snapshotExpression(secret));}
      catch(snapshotError){browser={snapshotError:String(snapshotError)};}
      const record={status,phase,width,
        checkedOutSha:process.env.LUMI_TESTED_CHECKOUT_SHA??null,
        preBack,cacheNotUsed,browser,
        ...(error===undefined?{}:{error:String(error)})};
      console.log("NATIVE_REAL_BFCACHE_EVIDENCE "+JSON.stringify(record));
      await test.info().attach("native-bfcache-"+width+"-"+status+".json",{
        body:Buffer.from(JSON.stringify(record,null,2)),contentType:"application/json"});
      return browser;
    }
    try{
      await cdp.send("Emulation.setDeviceMetricsOverride",{
        width,height:844,deviceScaleFactor:1,mobile:width===390});
      await cdp.send("Page.navigate",{url:origin+"/?view=Calendar&scope=personal"});
      // This is a prerequisite, not a BFCache hit: the initial navigation
      // must fire the genuine (persisted:false) pageshow before drafting.
      phase="awaiting initial native pageshow";
      await waitFor("initial browser-fired pageshow",()=>cdp.eval<boolean>(
        "window.__lumiNative?.shows?.includes(false)===true"));
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
      phase="navigating away to robots.txt";
      // Both navigations are native browser actions; no Playwright goBack and
      // no synthetic PageTransitionEvent. Keep the private response no-store.
      await cdp.eval("location.assign('/robots.txt');true");
      await waitFor("robots.txt",()=>cdp.eval<boolean>("location.pathname==='/robots.txt'"));
      phase="native history.back";
      await cdp.eval("history.back();true");
      await waitFor("native browser back",()=>cdp.eval<boolean>(
        "location.search.includes('view=Calendar')"));
      // A navigation can commit to the destination before its pageshow
      // actually fires. An earlier snapshot saw shows:[] and incorrectly
      // classified that in-flight navigation as a BFCache miss.
      phase="awaiting actual post-Back pageshow";
      await waitFor("actual browser-fired pageshow after Back",()=>cdp.eval<boolean>(
        "!!window.__lumiNative?.shows.length && ("+
        "window.__lumiShowsBeforeLeave===undefined || "+
        "window.__lumiNative.shows.length>window.__lumiShowsBeforeLeave)"));
      phase="asserting native Back privacy and authorization";
      const first=await evidence("observed");
      expect(first.titleVisible,"Private draft remains in DOM").toBe(false);
      expect(first.storageLeak,"Private draft persisted to browser storage").toBe(false);
      expect(["",null],"Old private Area remains selected").toContain(first.area);
      if(strict)expect(first.persisted,"Native pageshow.persisted was false; reasons="+
        JSON.stringify({navigation:first.notRestoredReasons,cdp:cacheNotUsed})).toBe(true);
      // The original document is preserved only on a genuine BFCache hit.
      // A full reload is covered separately by the existing Playwright suite.
      if(first.persisted){
        // The genuinely resumed document must be the exact private editor
        // document we left, rather than a fresh navigation or SPA transition.
        expect(first.documentToken,"BFCache returned a different document")
          .toBe(preBack?.docToken);
        const awake=await waitFor("new authorized session and Area GET",async()=>{
          const state=await cdp.eval<any>(snapshotExpression(secret));
          return state.reads.includes("/api/target-staging/session")&&
            state.reads.includes("/api/target-staging/notes/create-targets")?state:null;
        });
        expect(awake.reads.indexOf("/api/target-staging/session")).toBeLessThan(
          awake.reads.indexOf("/api/target-staging/notes/create-targets"));
        expect(awake.titleVisible).toBe(false);
        expect(["",null]).toContain(awake.area);
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
        await cdp.send("Network.enable");
        const creates:string[]=[];
        const unsubscribe=cdp.on("Network.requestWillBeSent",event=>{
          const req=event.request as {url:string;method:string};
          if(req.method==="POST"&&
            new URL(req.url).pathname==="/api/target-staging/tasks")creates.push(req.url);
        });
        await cdp.eval("document.querySelector('[data-testid=\"target-private-task-save\"]').click()");
        await pause(300);
        expect(creates,"Blank restored composer must not submit CREATE").toHaveLength(0);
        unsubscribe();
      }
    }catch(error){
      // Attach and log the state even when native pageshow never fires:
      // a broken observer, a reload and a genuine BFCache miss are distinct.
      await evidence("failure",error).catch(diagnosticError=>
        console.log("NATIVE_BFCACHE_DIAGNOSTIC_ERROR "+String(diagnosticError)));
      throw error;
    }finally{
      unsubscribeNotUsed();
      cdp.close();chrome.kill("SIGKILL");
      rmSync(profile,{recursive:true,force:true,maxRetries:20,retryDelay:100});
    }
  });
}
