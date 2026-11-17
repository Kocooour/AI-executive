/** Stop native Chromium before deleting its profile. A kill() call only
 * requests termination; an 'exit' status is NOT the child's 'close' event. */
import type {ChildProcess} from "node:child_process";
import {rmSync} from "node:fs";

type ChromeHandle=Pick<ChildProcess,"exitCode"|"signalCode"|"kill"|"on"|"off"|"once">;

/** Register immediately after spawn: 'close' can happen before teardown.
 * Node emits 'close' after 'exit' and after stdio has closed. A spawn 'error'
 * is not evidence of closure; the 'close' event remains authoritative. */
export function watchNativeChromeClose(chrome:ChromeHandle){
  let didClose=false;
  const closed=new Promise<void>(resolve=>{
    const onError=()=>{/* A child spawn error is followed by 'close'. */};
    chrome.on("error",onError);
    chrome.once("close",()=>{
      didClose=true;
      chrome.off("error",onError);
      resolve();
    });
  });
  return {closed,isClosed:()=>didClose};
}
type CloseWatch=ReturnType<typeof watchNativeChromeClose>;

function closeWithin(watch:CloseWatch,timeoutMs:number):Promise<boolean>{
  if(watch.isClosed())return Promise.resolve(true);
  return new Promise(resolve=>{
    const timer=setTimeout(()=>resolve(false),timeoutMs);
    void watch.closed.then(()=>{clearTimeout(timer);resolve(true);});
  });
}

export async function stopNativeChromeAndRemoveProfile(
  chrome:ChromeHandle,watch:CloseWatch,profile:string,
  {graceMs=4_000,forceMs=4_000}:{graceMs?:number;forceMs?:number}={},
):Promise<void>{
  // An exit status is NOT sufficient to delete the profile. If Chrome
  // already exited but its close event is pending, wait instead of signaling.
  const signal=(name:"SIGTERM"|"SIGKILL")=>{
    if(watch.isClosed()||chrome.exitCode!==null||chrome.signalCode!==null)return;
    try{chrome.kill(name);}catch{/* A missed close retains the profile. */}
  };
  if(!watch.isClosed()){
    signal("SIGTERM");
    if(!await closeWithin(watch,graceMs)){
      signal("SIGKILL");
      if(!await closeWithin(watch,forceMs)){
        throw new Error("Native Chromium did not close; retaining its profile");
      }
    }
  }
  rmSync(profile,{recursive:true,force:true,maxRetries:20,retryDelay:100});
}
