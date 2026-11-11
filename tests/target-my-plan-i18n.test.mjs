import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import path from "node:path";
import {test} from "node:test";
import {myPlanCopy} from "../lib/target-my-plan-copy.ts";
import {
  mapTargetClientFailure,targetClientActionLabels,targetClientActionLabelsFor,
} from "../lib/target-client-errors.ts";

const root=path.resolve(import.meta.dirname,"..");
const read=file=>readFileSync(path.join(root,file),"utf8");
const DIACRITICS=/[áčďéěíňóřšťúůýžÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ]/;
const kinds=["signed_out","forbidden_or_missing","stale","conflict","invalid","rate_limited","unavailable","offline","uncertain"];
const inputs={
  signed_out:"unauthorized",forbidden_or_missing:"forbidden",stale:"stale",conflict:"conflict",
  invalid:"invalid_request",rate_limited:"rate_limited",unavailable:"unavailable",
  offline:"offline",uncertain:"uncertain",
};

/** Flatten a copy table: functions are invoked with sample arguments. */
function flatten(value,prefix=""){
  const out={};
  for(const [key,item] of Object.entries(value)){
    const name=prefix+key;
    if(typeof item==="function"){
      out[name+"()"]=item("Sample task");
      out[name+"(null)"]=item(null);
    }else if(item&&typeof item==="object")Object.assign(out,flatten(item,name+"."));
    else out[name]=item;
  }
  return out;
}

test("cs/en My Plan copy tables have identical key sets and no empty strings",()=>{
  assert.deepEqual(Object.keys(myPlanCopy).sort(),["cs","en"]);
  const cs=flatten(myPlanCopy.cs);
  const en=flatten(myPlanCopy.en);
  assert.deepEqual(Object.keys(en).sort(),Object.keys(cs).sort());
  assert.ok(Object.keys(cs).length>80);
  for(const [name,table] of [["cs",cs],["en",en]])
    for(const [key,text] of Object.entries(table)){
      assert.equal(typeof text,"string",name+"."+key);
      assert.ok(text.trim().length>0,name+"."+key+" is empty");
    }
});

test("English My Plan copy has no Czech diacritics, status codes or technical leakage",()=>{
  for(const [key,text] of Object.entries(flatten(myPlanCopy.en))){
    if(key.endsWith("(null)")&&key!=="whenConfirmed(null)")continue; // sample-only input
    assert.doesNotMatch(text,DIACRITICS,key);
    assert.doesNotMatch(text,/\b(?:4\d\d|5\d\d)\b|PATCH|\bCAS\b|dueOn|endpoint|stack|undefined|null/i,key);
  }
});

test("Czech My Plan copy is unchanged from R3-FE-2 (representative pins)",()=>{
  const cs=myPlanCopy.cs;
  assert.equal(cs.locale,"cs-CZ");
  assert.equal(cs.readReasons.offline,"Připojení se nezdařilo. Žádné úkoly nebyly změněny.");
  assert.equal(cs.statusReasons["signed-out"],"Přístup k zápisu zanikl. Znovu se přihlaste.");
  assert.equal(cs.whenReasons.unchanged,"Zvolený osobní den už je nastavený.");
  assert.equal(cs.whenConfirmed("5. listopadu 2026"),"Osobní plán potvrzen: 5. listopadu 2026.");
  assert.equal(cs.whenConfirmed(null),"Osobní plán potvrzen: bez plánovaného dne.");
  assert.equal(cs.completeTask("A"),"Dokončit úkol: A");
  assert.equal(cs.whenToday,"Kdy: Dnes");
  assert.equal(cs.gateChecking,"Ověřuji přihlášení k serverovému plánu…");
  assert.equal(cs.statusUncertain,"Výsledek zápisu není potvrzen. Žádná další změna se neodešle automaticky.");
});

test("English wording keeps uncertain outcomes neutral",()=>{
  const en=myPlanCopy.en;
  for(const text of [en.whenUncertain,en.whenUncertainRead,en.statusUncertain,en.statusUncertainRead])
    assert.match(text,/not (?:confirmed|certain)/);
  assert.equal(en.whenToday,"When: Today");
  assert.equal(en.toolbarDay,"Day");
  assert.equal(en.locale,"en-GB");
});

test("target client errors: English mapping for every kind, calm and non-technical",()=>{
  for(const kind of kinds){
    const cs=mapTargetClientFailure(inputs[kind]);
    const en=mapTargetClientFailure(inputs[kind],"en");
    assert.equal(cs.kind,kind);
    assert.equal(en.kind,kind);
    assert.equal(en.action,cs.action);
    assert.ok(en.message.length>10);
    assert.doesNotMatch(en.message,DIACRITICS);
    assert.doesNotMatch(en.message,/\b\d{3}\b|HTTP|PATCH|stack|exception|undefined/i);
    assert.notEqual(en.message,cs.message);
    // Default language is unchanged Czech.
    assert.deepEqual(mapTargetClientFailure(inputs[kind],"cs"),cs);
  }
  const uncertain=mapTargetClientFailure("uncertain","en").message;
  assert.match(uncertain,/do not know yet whether/);
  assert.doesNotMatch(uncertain,/\b(?:saved successfully|failed|succeeded)\b/i);
  // Status-shaped inputs map identically in both languages.
  for(const status of [401,403,404,409,429,500])
    assert.equal(mapTargetClientFailure(status,"en").kind,mapTargetClientFailure(status).kind);
  assert.equal(mapTargetClientFailure({status:409,error:"stale"},"en").kind,"stale");
  assert.equal(mapTargetClientFailure(Symbol("x"),"en").kind,"unavailable");
  assert.doesNotMatch(mapTargetClientFailure(undefined,"en").message,DIACRITICS);
});

test("target client action labels exist per language with identical keys",()=>{
  const cs=targetClientActionLabelsFor("cs");
  const en=targetClientActionLabelsFor("en");
  assert.deepEqual(cs,targetClientActionLabels);
  assert.deepEqual(targetClientActionLabelsFor(),targetClientActionLabels);
  assert.equal(cs.sign_in,"Přihlásit se");
  assert.deepEqual(Object.keys(en).sort(),Object.keys(cs).sort());
  for(const label of Object.values(en)){
    assert.ok(label.length>0);
    assert.doesNotMatch(label,DIACRITICS);
  }
});

test("wiring: root passes language to TargetMyPlan, which passes it on; standalone page stays Czech",()=>{
  const rootSource=read("app/ui/lumi-app-root.tsx");
  assert.match(rootSource,/<TargetMyPlan key=\{"private-task:"\+taskListRevision\} gates=\{targetMyPlan\} language=\{language\} scopeDriven=\{scopesOn\} taskDetail=\{detailGates\.task\} \/>/);
  assert.match(rootSource,/data-plan-source="target-staging"[\s\S]*?language === "cs"[\s\S]*?: "This plan comes from the staging server/);
  const plan=read("app/ui/target-my-plan.tsx");
  assert.match(plan,/<TargetStagingMyPlanPreview key=\{gate\.generation\} embedded language=\{language\}/);
  assert.equal((plan.match(/<TargetDataStatus[\s\S]*?\/>/g)??[]).filter(tag=>!tag.includes("language={language}")).length,0);
  assert.doesNotMatch(plan,/[áčďéěíňóřšťúůýž]/i);
  const page=read("app/target-staging/my-plan/preview/page.tsx");
  assert.doesNotMatch(page,/language/);
  const preview=read("app/ui/target-staging-my-plan-preview.tsx");
  assert.match(preview,/language="cs"/);
  assert.match(preview,/myPlanCopy\[language\]/);
  const status=read("app/ui/target-data-status.tsx");
  assert.match(status,/language="cs"/);
  assert.match(status,/mapTargetClientFailure\(failure,language\)/);
});

test("the preview component keeps no inline Czech UI text outside comments",()=>{
  const source=read("app/ui/target-staging-my-plan-preview.tsx")
    .replace(/\/\*[\s\S]*?\*\//g,"").replace(/^\s*\/\/.*$/gm,"");
  assert.doesNotMatch(source,DIACRITICS);
  assert.doesNotMatch(source,/"cs-CZ"[\s\S]*"cs-CZ"[\s\S]*"cs-CZ"/); // only the default parameter values
});

test("Czech My Plan copy matches the full R3-FE-2 snapshot (every value)",()=>{
  // Snapshot verified string-by-string against the pre-R3-FE-2b JSX. The one
  // deliberate change is the space between the status-undo failure reason and
  // the "Předchozí dokončení…" sentence, which JSX previously dropped.
  const snapshot=JSON.parse(read("tests/fixtures/target-my-plan-copy-cs.json"));
  assert.deepEqual(flatten(myPlanCopy.cs),snapshot);
});
