import assert from "node:assert/strict";
import {test} from "node:test";
import {readdirSync,readFileSync} from "node:fs";
import path from "node:path";
import {TARGET_PERSONAL_V1_PROFILE,TARGET_PERSONAL_V1_EXCLUDED,
  TARGET_PERSONAL_V1_EXCLUDED_PREFIXES,targetPersonalV1Env}
  from "../lib/target-personal-profile.ts";
import {targetUiConfig} from "../lib/target-ui-config.ts";
import {targetMainTitleSearchEnabled} from "../lib/target-main-title-search-ui.ts";
import {targetPrivateNoteAreaUiEnabled} from "../lib/target-private-note-area-ui-gate.ts";
import {targetPrivateNoteCreateUiEnabled} from "../lib/target-private-note-create-ui-gate.ts";
import {targetPrivateTaskCreateUiEnabled} from "../lib/target-private-task-create-ui-gate.ts";
import {targetProjectTitleEditUiEnabled} from "../lib/target-project-title-edit-ui-gate.ts";
import {targetNoteEditUiEnabled} from "../lib/target-note-edit-ui-gate.ts";

const root=path.resolve(import.meta.dirname,"..");
function sources(dir){
  return readdirSync(dir,{withFileTypes:true}).flatMap(entry=>{
    const full=path.join(dir,entry.name);
    if(entry.isDirectory())return entry.name==="node_modules"?[]:sources(full);
    return /\.(?:ts|tsx|mjs)$/.test(entry.name)?[full]:[];
  });
}
const found=new Set();
for(const file of [...sources(path.join(root,"lib")),...sources(path.join(root,"app"))]){
  if(file.endsWith("target-personal-profile.ts"))continue;
  for(const match of readFileSync(file,"utf8").matchAll(/AI_EXECUTIVE_TARGET_[A-Z0-9_]+_ENABLED/g))
    found.add(match[0]);
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

test("every boolean target flag in lib/ and app/ is classified exactly once",()=>{
  assert.ok(found.size>40,"scan must find the flags");
  const profile=new Set(TARGET_PERSONAL_V1_PROFILE);
  for(const flag of found){
    const where=Number(profile.has(flag))+Number(excluded.includes(flag));
    assert.equal(where,1,flag+" must be in exactly one of profile/excluded");
  }
  for(const flag of [...profile,...excluded])
    assert.ok(found.has(flag),flag+" is classified but no longer exists in the sources");
  assert.ok(!excluded.some(flag=>profile.has(flag)));
  for(const flag of excluded)
    assert.ok(/CLIENT_PREVIEW|INDEX_DETAIL_LINKS|ATTENTION|NOTIF|NOTE_SYNC|RELATIONS|HOME|GLOBAL_|DUE_/.test(flag),flag);
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
