import assert from "node:assert/strict";
import {readFileSync,readdirSync,statSync} from "node:fs";
import path from "node:path";
import {test} from "node:test";
const root=path.resolve(import.meta.dirname,"..");
const read=file=>readFileSync(path.join(root,file),"utf8");
const flags=["AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED","AI_EXECUTIVE_TARGET_UI_ENABLED"];

test("the server prop function needs BOTH flags to be exactly true",async()=>{
  const old=Object.fromEntries(flags.map(f=>[f,process.env[f]]));
  const {targetUiEnabled}=await import("../lib/target-staging-session-generation.ts");
  try{
    for(const f of flags)delete process.env[f];
    assert.equal(targetUiEnabled(),false);
    for(const only of flags){
      for(const f of flags)delete process.env[f];
      process.env[only]="true";
      assert.equal(targetUiEnabled(),false,only);
    }
    for(const bad of ["1","TRUE","yes","false",""]){
      process.env[flags[0]]="true";process.env[flags[1]]=bad;
      assert.equal(targetUiEnabled(),false,bad);
    }
    for(const f of flags)process.env[f]="true";
    assert.equal(targetUiEnabled(),true);
  }finally{
    for(const [f,v] of Object.entries(old))if(v===undefined)delete process.env[f];else process.env[f]=v;
  }
});

test("the server page mounts the provider only behind the flag and reads it per request",()=>{
  const page=read("app/page.tsx");
  assert.doesNotMatch(page,/^"use client"/m);
  assert.match(page,/export const dynamic = "force-dynamic"/);
  assert.match(page,/targetUiEnabled\(\)/);
  assert.match(page,/targetData\s*\n?\s*\?\s*<TargetDataProvider><LumiAppRoot targetMyPlan=\{config\?\.myPlan\} targetScopes=\{config\?\.scopes\} targetDetails=\{config\?\.details\} targetEdits=\{config\?\.edits\} targetNoteEdit=\{Boolean\(config\?\.details\.note\) && targetNoteEditUiEnabled\(process\.env\)\} targetProjectEdit=\{Boolean\(config\?\.details\.project\) && targetProjectTitleEditUiEnabled\(process\.env\)\} targetPrivateNoteAreas=\{Boolean\(config\?\.scopes\.notes\)&&targetPrivateNoteAreaUiEnabled\(process\.env\)\} targetPrivateNoteCreate=\{Boolean\(config\?\.scopes\.notes\)&&targetPrivateNoteCreateUiEnabled\(process\.env\)\} targetPrivateTaskCreate=\{Boolean\(config\?\.scopes\.notes&&config\?\.myPlan\.enabled&&config\?\.details\.task\)&&targetPrivateTaskCreateUiEnabled\(process\.env\)\} \/><\/TargetDataProvider>\s*\n?\s*:\s*<LumiAppRoot \/>/);
  // The page itself never creates a runtime nor fetches.
  assert.doesNotMatch(page,/createTargetClientRuntime|fetch\(|target-client-runtime/);
});

test("the provider creates the runtime only inside an effect (never during render or SSR)",()=>{
  const source=read("app/ui/target-data-provider.tsx");
  const effect=source.indexOf("useEffect(()=>{\n    const created=createTargetClientRuntime()");
  assert.ok(effect>0);
  assert.equal((source.match(/createTargetClientRuntime\(/g)??[]).length,1);
  assert.match(source,/created\.dispose\(\)/);
  assert.match(source,/contextVersion|runtime\.generation/);
  assert.doesNotMatch(source,/localStorage|sessionStorage|indexedDB/);
});

test("the legacy app root and use-lumi-app know nothing about the target runtime",()=>{
  // R3-FE-2: the root may only lazily import the target My Plan screen; it never
  // touches the runtime, provider, session endpoint or hooks itself.
  for(const file of ["app/ui/lumi-app-root.tsx","app/ui/use-lumi-app.tsx"]){
    const source=read(file);
    assert.doesNotMatch(source,/target-client-runtime|target-data-provider|target-staging\/session|useTargetSession|useTargetRuntime|useTargetGeneration|TargetDataStatus/,file);
  }
});

test("only the runtime (and its server route) reference the session endpoint; no screen is switched",()=>{
  const hits=[];
  const walk=dir=>{
    for(const name of readdirSync(path.join(root,dir))){
      if(name==="node_modules"||name===".next")continue;
      const rel=path.join(dir,name);
      const full=path.join(root,rel);
      if(statSync(full).isDirectory())walk(rel);
      else if(/\.(ts|tsx)$/.test(name)&&readFileSync(full,"utf8").includes("target-staging/session"))
        hits.push(rel);
    }
  };
  walk("app");walk("lib");
  assert.deepEqual(hits.sort(),["app/api/target-staging/session/route.ts","lib/target-client-runtime.ts"]);
  // Consumers of the runtime hooks (.ts and .tsx): the lazily loaded My Plan screen (R3-FE-2),
  // the scope lists with their gate hook (R3-FE-3), and the provider/status modules themselves.
  const users=[];
  const scan=dir=>{
    for(const name of readdirSync(path.join(root,dir))){
      const rel=path.join(dir,name);
      const full=path.join(root,rel);
      if(statSync(full).isDirectory())scan(rel);
      else if(/\.tsx?$/.test(name)&&/useTargetSession|useTargetGeneration|useTargetRuntime|TargetDataStatus/.test(readFileSync(full,"utf8")))
        users.push(rel);
    }
  };
  scan("app");
  assert.deepEqual(users.sort(),[
    "app/ui/target-data-provider.tsx","app/ui/target-data-status.tsx","app/ui/target-my-plan.tsx",
    // R3-FE-3: the lazily loaded scope lists and the gate hook.
    "app/ui/target-scope-lists.tsx","app/ui/use-target-gate.ts",
    // R3-FE-4a: the lazily loaded authorized detail panel and the compact sidebar project list.
    "app/ui/target-detail-panel.tsx","app/ui/target-sidebar-projects.tsx","app/ui/use-target-revalidation.ts",
    // R3-FE-4b: the lazily loaded detail edit controls use the existing runtime
    // to enforce the same generation-scoped note PATCH recovery barrier as the note editor.
    "app/ui/target-detail-edit.tsx","app/ui/target-note-editor.tsx",
    "app/ui/target-project-title-editor.tsx",
    // R3-CAPTURE-1: live private Area chooser uses the existing runtime.
    "app/ui/target-private-note-area-chooser.tsx",
    // R3-FE-6: lazily loaded private task capture uses the same runtime contract.
    "app/ui/target-private-task-area-chooser.tsx",
  ].sort());
});

test("TargetDataStatus uses status for the info kind, alert for errors, and a real button",()=>{
  const source=read("app/ui/target-data-status.tsx");
  assert.match(source,/role=\{mapped\.kind==="uncertain"\?"status":"alert"\}/);
  assert.match(source,/<button type="button"/);
  assert.doesNotMatch(source,/dangerouslySetInnerHTML|\.status\b.*\{mapped\.kind\}/);
});
