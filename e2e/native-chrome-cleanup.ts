/** Stop native Chromium before deleting its profile. A kill() call only
 * requests termination; an 'exit' status is NOT the child's 'close' event. */
import type {ChildProcess} from "node:child_process";
import {rm} from "node:fs/promises";

type ChromeHandle=Pick<ChildProcess,"pid"|"exitCode"|"signalCode"|"kill"|"on"|"off"|"once">;

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

const sleep=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));

/** The native BFCache browser is spawned detached on POSIX, giving its
 * helpers their own process group even after the Chrome parent closes. */
function groupAlive(pid:number|undefined):boolean{
  if(process.platform==="win32"||!pid||pid<=0)return false;
  try{process.kill(-pid,0);return true;}
  catch(error){return (error as NodeJS.ErrnoException).code==="EPERM";}
}
async function groupGoneWithin(pid:number,timeoutMs:number):Promise<boolean>{
  const until=Date.now()+timeoutMs;
  while(groupAlive(pid)){
    if(Date.now()>=until)return false;
    await sleep(Math.min(100,until-Date.now()));
  }
  return true;
}

type CleanupOptions={
  graceMs?:number;forceMs?:number;cleanupMs?:number;retryMs?:number;
  /** Injectable so the ENOTEMPTY race can be reproduced deterministically. */
  removeProfile?:(profile:string)=>Promise<void>|void;
  warn?:(message:string)=>void;
};

export async function stopNativeChromeAndRemoveProfile(
  chrome:ChromeHandle,watch:CloseWatch,profile:string,
  {graceMs=4_000,forceMs=4_000,cleanupMs=10_000,retryMs=100,
    removeProfile=(name)=>rm(name,{recursive:true,force:true,maxRetries:0}),
    warn=console.warn}:CleanupOptions={},
):Promise<void>{
  const signal=(name:"SIGTERM"|"SIGKILL")=>{
    if(groupAlive(chrome.pid)){
      try{process.kill(-chrome.pid!,name);return;}catch{/* Fall back to the parent. */}
    }
    if(watch.isClosed()||chrome.exitCode!==null||chrome.signalCode!==null)return;
    try{chrome.kill(name);}catch{/* A missed close retains the profile. */}
  };
  // Parent close alone does not guarantee Chrome's GPU/utility helpers are gone.
  if(!watch.isClosed()){
    signal("SIGTERM");
    if(!await closeWithin(watch,graceMs)){
      signal("SIGKILL");
      if(!await closeWithin(watch,forceMs)){
        warn("Native Chromium did not close; retaining profile: "+profile);
        return;
      }
    }
  }
  if(groupAlive(chrome.pid)){
    signal("SIGTERM");
    if(!await groupGoneWithin(chrome.pid!,graceMs)){
      signal("SIGKILL");
      if(!await groupGoneWithin(chrome.pid!,forceMs)){
        warn("Native Chromium process group is still running; retaining profile: "+profile);
        return;
      }
    }
  }

  // Helpers can still finish their last profile writes around process exit.
  // Never mask a successful BFCache assertion with a cleanup-only failure.
  const deadline=Date.now()+Math.max(0,cleanupMs);
  let delay=Math.max(1,retryMs);
  let attempts=0;
  while(true){
    attempts++;
    try{await removeProfile(profile);return;}
    catch(error){
      const code=(error as NodeJS.ErrnoException).code;
      const transient=["ENOTEMPTY","EBUSY","EPERM","EACCES"].includes(code||"");
      if(!transient||Date.now()>=deadline){
        warn("Native Chromium profile cleanup failed ("+attempts+" attempts): "+
          profile+"; "+String(error));
        return;
      }
      await sleep(Math.min(delay,Math.max(0,deadline-Date.now())));
      delay=Math.min(delay*2,1_000);
    }
  }
}
