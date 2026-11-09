import assert from "node:assert/strict";
import {test} from "node:test";
import {scopesCopy} from "../lib/target-scopes-copy.ts";

const DIACRITICS=/[áčďéěíňóřšťúůýžÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ]/;
function flatten(value,prefix=""){
  const out={};
  for(const [key,item] of Object.entries(value)){
    if(item&&typeof item==="object")Object.assign(out,flatten(item,prefix+key+"."));
    else out[prefix+key]=item;
  }
  return out;
}

test("R3-FE-3 copy: cs/en tables have identical key sets and no empty strings",()=>{
  assert.deepEqual(Object.keys(scopesCopy).sort(),["cs","en"]);
  const cs=flatten(scopesCopy.cs),en=flatten(scopesCopy.en);
  assert.deepEqual(Object.keys(en).sort(),Object.keys(cs).sort());
  for(const table of [cs,en])
    for(const [key,text] of Object.entries(table)){
      assert.equal(typeof text,"string",key);
      assert.ok(text.trim().length>0,key);
    }
});

test("R3-FE-3 copy: the switcher labels are exactly Vše / Osobní / Sdílené and All / Personal / Shared",()=>{
  const {cs,en}=scopesCopy;
  assert.deepEqual([cs.all,cs.personal,cs.shared],["Vše","Osobní","Sdílené"]);
  assert.deepEqual([en.all,en.personal,en.shared],["All","Personal","Shared"]);
});

test("R3-FE-3 copy: English has no Czech diacritics; neither language leaks technical detail",()=>{
  for(const [key,text] of Object.entries(flatten(scopesCopy.en)))
    if(key!=="locale")assert.doesNotMatch(text,DIACRITICS,key);
  for(const lang of ["cs","en"])
    for(const [key,text] of Object.entries(flatten(scopesCopy[lang]))){
      if(key==="locale")continue;
      assert.doesNotMatch(text,/\b(40[0-9]|50[0-9]|HTTP|JSON|cursor|generation|session_revoked|staging|api\/|undefined|null)\b/i,lang+"."+key);
    }
});

test("R3-FE-3 copy: All is never described as My Plan; no counts or progress wording",()=>{
  for(const lang of ["cs","en"])
    for(const [key,text] of Object.entries(flatten(scopesCopy[lang]))){
      assert.doesNotMatch(text,/m[ůu]j pl[áa]n|my plan/i,lang+"."+key);
      assert.doesNotMatch(text,/\d/,lang+"."+key);
    }
});

test("R3-FE-3 copy: the read-only notes say details come later",()=>{
  assert.match(scopesCopy.cs.readOnlyNote,/jen ke čtení/);
  assert.match(scopesCopy.en.readOnlyNote,/read-only/);
  assert.match(scopesCopy.cs.notesTitleOnlyNote,/názvy/);
  assert.match(scopesCopy.en.notesTitleOnlyNote,/titles only/);
});

test("R3-FE-3 copy: My Plan hints describe MY work, list hints describe what you may read",()=>{
  for(const lang of ["cs","en"]){
    const {listHints,planHints}=scopesCopy[lang];
    assert.deepEqual(Object.keys(planHints),["all","personal","shared"]);
    assert.notEqual(planHints.all,listHints.all);
    assert.notEqual(planHints.shared,listHints.shared);
  }
  assert.match(scopesCopy.en.planHints.all,/your (own )?work|All of your work/i);
  assert.match(scopesCopy.en.planHints.shared,/assigned to you/);
  assert.match(scopesCopy.cs.planHints.all,/vaše (soukromé|práce)|Veškerá vaše práce/);
  assert.doesNotMatch(scopesCopy.en.planHints.all,/everything you may read/i);
  assert.match(scopesCopy.en.listHints.all,/Everything you may read/);
});
