/** Stop native Chromium before deleting its profile. A kill() call only
 * requests termination: removing the profile immediately races Chrome's
 * remaining writes and can turn successful BFCache evidence into ENOTEMPTY. */
import type {ChildProcess} from "node:child_process";
import {rmSync} from "node:fs";

type ChromeHandle=Pick<ChildProcess,"exitCode"|"signalCode"|"once"|"off"|"kill">;

function waitForClose(chrome:ChromeHandle,signal:"SIGTERM"|"SIGKILL",timeoutMs:number):Promise<boolean>{
  if(chrome.exitCode!==null||chrome.signalCode!==null)return Promise.resolve(true);
  return new Promise(resolve=>{
    let finished=false;
    const complete=(closed:boolean)=>{
      if(finished)return;
      finished=true;
      clearTimeout(timer);
      chrome.off("close",onClose);
      chrome.off("error",onError);
      resolve(closed);
    };
    const onClose=()=>complete(true);
    const onError=()=>complete(false);
    const timer=setTimeout(()=>complete(false),timeoutMs);
    chrome.once("close",onClose);
    chrome.once("error",onError);
    try{chrome.kill(signal);}catch{complete(false);}
  });
}

export async function stopNativeChromeAndRemoveProfile(
  chrome:ChromeHandle,profile:string,
  {graceMs=4_000,forceMs=4_000}:{graceMs?:number;forceMs?:number}={},
):Promise<void>{
  // A graceful shutdown lets Chrome terminate its subprocesses and flush
  // profile writes. Escalate only after a bounded wait; never delete a live
  // profile if the browser still refuses to stop.
  if(!await waitForClose(chrome,"SIGTERM",graceMs)&&
     !await waitForClose(chrome,"SIGKILL",forceMs)){
    throw new Error("Native Chromium did not exit; retaining its profile");
  }
  rmSync(profile,{recursive:true,force:true,maxRetries:20,retryDelay:100});
}
