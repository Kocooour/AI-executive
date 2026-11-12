import assert from "node:assert/strict";
import {test} from "node:test";
import {readFileSync} from "node:fs";
import {execFileSync} from "node:child_process";
import path from "node:path";
import {TARGET_PERSONAL_V1_PROFILE,TARGET_PERSONAL_V1_EXCLUDED,
  TARGET_PERSONAL_V1_EXCLUDED_PREFIXES,TARGET_PERSONAL_V1_REQUIRED_SETTINGS,
  TARGET_PERSONAL_V1_NOT_SETTINGS,targetPersonalV1Env}
  from "../lib/target-personal-profile.ts";
import {targetUiConfig} from "../lib/target-ui-config.ts";
import {targetMainTitleSearchEnabled} from "../lib/target-main-title-search-ui.ts";
import {targetPrivateNoteAreaUiEnabled} from "../lib/target-private-note-area-ui-gate.ts";
import {targetPrivateNoteCreateUiEnabled} from "../lib/target-private-note-create-ui-gate.ts";
import {targetPrivateTaskCreateUiEnabled} from "../lib/target-private-task-create-ui-gate.ts";
import {targetProjectTitleEditUiEnabled} from "../lib/target-project-title-edit-ui-gate.ts";
import {targetNoteEditUiEnabled} from "../lib/target-note-edit-ui-gate.ts";

const root=path.resolve(import.meta.dirname,"..");
// Every tracked source that can read the environment: lib/, app/, scripts/, services/, instrumentation.ts,
// next.config.mjs, .env.example, deployment/ops files, any extension. Tests, e2e, docs, workflows and static
// assets only mention flags, they do not read them; this file's own subject is exempt.
const SKIPPED=/^(?:docs\/|tests\/|e2e\/|\.github\/|public\/|node_modules\/|pnpm-lock\.yaml$|playwright\.config\.ts$|lib\/target-personal-profile\.ts$)/;
const tracked=execFileSync("git",["ls-files","-z"],{cwd:root,encoding:"utf8",maxBuffer:64*1024*1024})
  .split("\0").filter(file=>file&&!SKIPPED.test(file)&&!/\.(?:png|jpe?g|gif|ico|webp|woff2?|ttf|svg|pdf|md)$/i.test(file));
// A name assembled at runtime cannot be classified, so it is refused: only these exact (file, fragment)
// pairs may mention an incomplete AI_EXECUTIVE_TARGET_ identifier.
const INCOMPLETE_ALLOWED=new Set([]);
const found=new Set(),nonBoolean=new Set(),incomplete=[];
for(const file of tracked){
  let text;
  try{text=readFileSync(path.join(root,file),"utf8");}catch{continue;}
  for(const match of text.matchAll(/AI_EXECUTIVE_TARGET_[A-Z0-9_]*/g)){
    const token=match[0];
    if(token.endsWith("_")||token==="AI_EXECUTIVE_TARGET_"){
      if(!INCOMPLETE_ALLOWED.has(file+"|"+token))incomplete.push(file+": "+token+" followed by "+JSON.stringify(text[match.index+token.length]));
    }else if(token.endsWith("_ENABLED"))found.add(token);
    else nonBoolean.add(token);
  }
  // A split prefix ("AI_EXECUTIVE_" + "TARGET_...") would also hide a flag from the scan.
  for(const match of text.matchAll(/AI_EXECUTIVE_(?:TARGET)?(?![A-Z0-9_])/g))
    if(!INCOMPLETE_ALLOWED.has(file+"|"+match[0]))incomplete.push(file+": split prefix "+match[0]);
}
const excluded=TARGET_PERSONAL_V1_EXCLUDED.map(entry=>entry.flag);
const env=targetPersonalV1Env();

test("profile is sorted, unique and well-formed; every exclusion has a reason",()=>{
  assert.deepEqual([...TARGET_PERSONAL_V1_PROFILE],[...TARGET_PERSONAL_V1_PROFILE].sort());
  assert.equal(new Set(TARGET_PERSONAL_V1_PROFILE).size,TARGET_PERSONAL_V1_PROFILE.length);
  assert.equal(new Set(excluded).size,excluded.length);
  for(const entry of TARGET_PERSONAL_V1_EXCLUDED)assert.ok(entry.reason.length>10,entry.flag);
  for(const flag of [...TARGET_PERSONAL_V1_PROFILE,...excluded])
    assert.match(flag,/^AI_EXECUTIVE_TARGET_[A-Z0-9_]+_ENABLED$/);
  assert.ok(TARGET_PERSONAL_V1_EXCLUDED_PREFIXES.some(entry=>entry.prefix==="AI_EXECUTIVE_HUMANWIKI_"));
  assert.deepEqual(Object.keys(env),[...TARGET_PERSONAL_V1_PROFILE]);
  assert.ok(Object.values(env).every(value=>value==="true"));
});

test("no flag name is assembled at runtime or split, so the scan cannot be bypassed",()=>{
  assert.deepEqual(incomplete,[]);
});

test("every non-boolean target setting is either a required operator setting or explicitly not one",()=>{
  const required=TARGET_PERSONAL_V1_REQUIRED_SETTINGS.map(entry=>entry.name);
  const internal=TARGET_PERSONAL_V1_NOT_SETTINGS.map(entry=>entry.name);
  for(const name of nonBoolean)
    assert.equal(Number(required.includes(name))+Number(internal.includes(name)),1,name+" must be classified exactly once");
  for(const name of [...required,...internal])assert.ok(nonBoolean.has(name),name+" no longer exists in the sources");
  for(const name of required)assert.ok(!TARGET_PERSONAL_V1_PROFILE.includes(name));
});

test("every server-only profile flag is read by a route handler or a lib helper under its exact name",()=>{
  const serverSources=tracked.filter(file=>/^(?:app\/api\/|lib\/)/.test(file))
    .map(file=>readFileSync(path.join(root,file),"utf8")).join("\n");
  for(const flag of TARGET_PERSONAL_V1_PROFILE.filter(name=>name.startsWith("AI_EXECUTIVE_TARGET_STAGING_")))
    assert.ok(serverSources.includes(flag),flag+" is not read by any server source");
});

test("every boolean target flag in the tracked sources is classified exactly once",()=>{
  assert.ok(found.size>40,"scan must find the flags");
  assert.ok(tracked.some(file=>file.startsWith("app/api/"))&&tracked.includes("package.json"),"scan covers the tracked tree");
  const profile=new Set(TARGET_PERSONAL_V1_PROFILE);
  for(const flag of found){
    const where=Number(profile.has(flag))+Number(excluded.includes(flag));
    assert.equal(where,1,flag+" must be in exactly one of profile/excluded");
  }
  for(const flag of [...profile,...excluded])
    assert.ok(found.has(flag),flag+" is classified but no longer exists in the sources");
  assert.ok(!excluded.some(flag=>profile.has(flag)));
  for(const flag of excluded)
    assert.ok(/CLIENT_PREVIEW|INDEX_DETAIL_LINKS|ATTENTION|NOTIF|NOTE_SYNC|RELATIONS|HOME|GLOBAL_|DUE_|PROJECTS_CREATE|PROJECT_TASKS_CREATE/.test(flag),flag);
  for(const flag of profile)assert.ok(!/CLIENT_PREVIEW|INDEX_DETAIL_LINKS|ATTENTION|NOTIF|NOTE_SYNC|HUMANWIKI/.test(flag),flag);
});

test("the profile switches every myPlan/scopes/details/edits field on",()=>{
  const config=targetUiConfig(env);
  assert.ok(config);
  assert.deepEqual(config.myPlan,{enabled:true,statusWrite:true,whenWrite:true});
  assert.deepEqual(config.scopes,{enabled:true,projects:true,notes:true});
  assert.deepEqual(config.details,{task:true,project:true,note:true});
  assert.deepEqual(config.edits,{taskTitle:true,taskStatus:true,taskWhen:true,taskDelete:true,noteEdit:true,noteDelete:true});
});

test("the other UI gates evaluate enabled under the profile",()=>{
  assert.equal(targetMainTitleSearchEnabled(env),true);
  assert.equal(targetPrivateNoteAreaUiEnabled(env),true);
  assert.equal(targetPrivateNoteCreateUiEnabled(env),true);
  assert.equal(targetPrivateTaskCreateUiEnabled(env),true);
  assert.equal(targetProjectTitleEditUiEnabled(env),true);
  assert.equal(targetNoteEditUiEnabled(env),true);
});

test("removing any single profile flag turns at least one gate or route off (no dead flags)",()=>{
  const gates=e=>JSON.stringify([targetUiConfig(e),targetMainTitleSearchEnabled(e),
    targetPrivateNoteAreaUiEnabled(e),targetPrivateNoteCreateUiEnabled(e),
    targetPrivateTaskCreateUiEnabled(e),targetProjectTitleEditUiEnabled(e),targetNoteEditUiEnabled(e)]);
  const base=gates(env);
  for(const flag of TARGET_PERSONAL_V1_PROFILE){
    const reduced={...env};delete reduced[flag];
    assert.notEqual(gates(reduced),base,flag+" has no effect on any UI gate");
  }
});
