import assert from "node:assert/strict";
import {test} from "node:test";
import {detailCopy} from "../lib/target-detail-copy.ts";

const shape=value=>typeof value==="function"?"fn"
  :value!==null&&typeof value==="object"
    ?Object.fromEntries(Object.keys(value).sort().map(k=>[k,shape(value[k])]))
    :typeof value;

test("cs and en tables have identical key sets and value kinds",()=>{
  assert.deepEqual(shape(detailCopy.cs),shape(detailCopy.en));
});

test("no value is empty and functions return non-empty text",()=>{
  for(const language of ["cs","en"]){
    const walk=(value,at)=>{
      if(typeof value==="function"){
        const text=value("Titulek");
        assert.equal(typeof text,"string",at);
        assert.ok(text.length>0,at);
        assert.ok(text.includes("Titulek")||at.endsWith("panelLabelLoading"),at+" should mention the title");
      }else if(value&&typeof value==="object")for(const [k,v] of Object.entries(value))walk(v,at+"."+k);
      else assert.ok(typeof value==="string"&&value.length>0,at);
    };
    walk(detailCopy[language],language);
  }
});

test("the not-available wording never reveals whether an item exists or who owns it",()=>{
  for(const language of ["cs","en"]){
    const text=detailCopy[language].failures["not-available"];
    assert.doesNotMatch(text,/404|403|401|smaz|delet|revok|oprávn|permission|exist|nenalez|not found|forbidden/i,text);
  }
});

test("failure wording shows no status codes or technical ids",()=>{
  for(const language of ["cs","en"])
    for(const text of Object.values(detailCopy[language].failures))
      assert.doesNotMatch(text,/\b[0-9]{3}\b|HTTP|id\b|token|generation/i,text);
});

test("cs uses Czech wording and en does not reuse it",()=>{
  assert.equal(detailCopy.cs.locale,"cs-CZ");
  assert.equal(detailCopy.en.locale,"en-GB");
  assert.notEqual(detailCopy.cs.close,detailCopy.en.close);
  assert.notEqual(detailCopy.cs.failures["not-available"],detailCopy.en.failures["not-available"]);
});
