import assert from "node:assert/strict";
import {EventEmitter} from "node:events";
import {existsSync,mkdtempSync,rmSync,writeFileSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import {test} from "node:test";
import {stopNativeChromeAndRemoveProfile} from "../e2e/native-chrome-cleanup.ts";

function fixture(t){
  const dir=mkdtempSync(path.join(os.tmpdir(),"lumi-native-chrome-cleanup-"));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const child=new EventEmitter();
  child.exitCode=null;
  child.signalCode=null;
  const signals=[];
  child.kill=(signal)=>{signals.push(signal);return true;};
  return {dir,child,signals};
}

test("teardown waits for Chrome's close event before removing its profile",async t=>{
  const {dir,child,signals}=fixture(t);
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
  const teardown=stopNativeChromeAndRemoveProfile(child,dir,{graceMs:300,forceMs:300});
  assert.equal(existsSync(dir),true,"Chrome's profile must remain until close");
  await teardown;
  assert.deepEqual(signals,["SIGTERM"]);
  assert.equal(existsSync(dir),false);
});

test("an unresponsive Chrome receives SIGKILL only after bounded graceful wait",async t=>{
  const {dir,child,signals}=fixture(t);
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
  await stopNativeChromeAndRemoveProfile(child,dir,{graceMs:15,forceMs:300});
  assert.deepEqual(signals,["SIGTERM","SIGKILL"]);
  assert.equal(existsSync(dir),false);
});

test("refuses to delete a still-running Chrome profile after both timeouts",async t=>{
  const {dir,child,signals}=fixture(t);
  await assert.rejects(
    stopNativeChromeAndRemoveProfile(child,dir,{graceMs:10,forceMs:10}),
    /retaining its profile/);
  assert.deepEqual(signals,["SIGTERM","SIGKILL"]);
  assert.equal(existsSync(dir),true,"keep the profile for manual diagnostics");
});
