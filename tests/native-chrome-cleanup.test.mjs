import assert from "node:assert/strict";
import {EventEmitter} from "node:events";
import {existsSync,mkdtempSync,rmSync,writeFileSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import {test} from "node:test";
import {stopNativeChromeAndRemoveProfile,watchNativeChromeClose} from "../e2e/native-chrome-cleanup.ts";

function fixture(t){
  const dir=mkdtempSync(path.join(os.tmpdir(),"lumi-native-chrome-cleanup-"));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const child=new EventEmitter();
  child.exitCode=null;
  child.signalCode=null;
  const signals=[];
  child.kill=(signal)=>{signals.push(signal);return true;};
  const closeWatch=watchNativeChromeClose(child);
  return {dir,child,closeWatch,signals};
}

test("teardown waits for Chrome's close event before removing its profile",async t=>{
  const {dir,child,closeWatch,signals}=fixture(t);
  child.kill=signal=>{
    signals.push(signal);
    setTimeout(()=>{
      // Simulate Chrome writing a final file after SIGTERM but before exit.
      writeFileSync(path.join(dir,"last-chrome-write"),"still running");
      child.signalCode=signal;
      child.emit("close",null,signal);
    },30);
    return true;
  };
  const teardown=stopNativeChromeAndRemoveProfile(child,closeWatch,dir,{graceMs:300,forceMs:300});
  assert.equal(existsSync(dir),true,"Chrome's profile must remain until close");
  await teardown;
  assert.deepEqual(signals,["SIGTERM"]);
  assert.equal(existsSync(dir),false);
});

test("an unresponsive Chrome receives SIGKILL only after bounded graceful wait",async t=>{
  const {dir,child,closeWatch,signals}=fixture(t);
  child.kill=signal=>{
    signals.push(signal);
    if(signal==="SIGKILL"){
      setTimeout(()=>{
        child.signalCode=signal;
        child.emit("close",null,signal);
      },10);
    }
    return true;
  };
  await stopNativeChromeAndRemoveProfile(child,closeWatch,dir,{graceMs:15,forceMs:300});
  assert.deepEqual(signals,["SIGTERM","SIGKILL"]);
  assert.equal(existsSync(dir),false);
});

test("refuses to delete a still-running Chrome profile after both timeouts",async t=>{
  const {dir,child,closeWatch,signals}=fixture(t);
  await assert.rejects(
    stopNativeChromeAndRemoveProfile(child,closeWatch,dir,{graceMs:10,forceMs:10}),
    /retaining its profile/);
  assert.deepEqual(signals,["SIGTERM","SIGKILL"]);
  assert.equal(existsSync(dir),true,"keep the profile for manual diagnostics");
});

test("exit status before close must not permit early profile removal",async t=>{
  const {dir,child,closeWatch,signals}=fixture(t);
  child.exitCode=0;
  const teardown=stopNativeChromeAndRemoveProfile(
    child,closeWatch,dir,{graceMs:250,forceMs:250});
  assert.equal(existsSync(dir),true);
  await new Promise(resolve=>setTimeout(resolve,30));
  assert.equal(existsSync(dir),true,"exit is not close");
  child.emit("close",0,null);
  await teardown;
  assert.deepEqual(signals,[],"already exited process must not be signaled");
  assert.equal(existsSync(dir),false);
});

test("signalCode set between grace and force still waits for close",async t=>{
  const {dir,child,closeWatch,signals}=fixture(t);
  child.kill=signal=>{
    signals.push(signal);
    setTimeout(()=>{child.signalCode=signal;child.emit("exit",null,signal);},5);
    return true;
  };
  const teardown=stopNativeChromeAndRemoveProfile(
    child,closeWatch,dir,{graceMs:20,forceMs:200});
  await new Promise(resolve=>setTimeout(resolve,50));
  assert.equal(existsSync(dir),true);
  assert.deepEqual(signals,["SIGTERM"],"already exited process must not receive SIGKILL");
  child.emit("close",null,"SIGTERM");
  await teardown;
  assert.equal(existsSync(dir),false);
});

test("already observed close allows cleanup without signaling",async t=>{
  const {dir,child,closeWatch,signals}=fixture(t);
  child.exitCode=0;
  child.emit("close",0,null);
  await stopNativeChromeAndRemoveProfile(child,closeWatch,dir);
  assert.deepEqual(signals,[]);
  assert.equal(existsSync(dir),false);
});
