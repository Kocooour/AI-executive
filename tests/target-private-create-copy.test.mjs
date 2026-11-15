/** C22 reviewer #443: prohibit internal jargon in user-visible Czech/English
 * copy without treating code identifiers, comments or data-testid as UI text.
 */
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import path from "node:path";
import {test} from "node:test";
import ts from "typescript";
import {myPlanCopy} from "../lib/target-my-plan-copy.ts";

const root=path.resolve(import.meta.dirname,"..");
const forbidden=/\b(?:commands?|receipts?|staging)\b|příkaz\p{L}*/iu;
const read=file=>readFileSync(path.join(root,file),"utf8");
function parse(file){
  const ast=ts.createSourceFile(file,read(file),ts.ScriptTarget.Latest,true,
    file.endsWith(".tsx")?ts.ScriptKind.TSX:ts.ScriptKind.TS);
  assert.equal(ast.parseDiagnostics.length,0,file+" cannot be parsed");
  return ast;
}
function nameOf(node){
  return ts.isIdentifier(node)||ts.isStringLiteralLike(node)?node.text:null;
}
function copyTable(file,variable){
  const ast=parse(file);
  let table=null;
  function visit(node){
    if(ts.isVariableDeclaration(node)&&nameOf(node.name)===variable){
      let init=node.initializer;
      while(init&&(ts.isAsExpression(init)||ts.isSatisfiesExpression(init)))
        init=init.expression;
      assert.ok(init&&ts.isObjectLiteralExpression(init),file+" copy must be a literal");
      const result={};
      for(const lang of init.properties){
        assert.ok(ts.isPropertyAssignment(lang));
        const key=nameOf(lang.name);
        assert.ok(key==="cs"||key==="en");
        assert.ok(ts.isObjectLiteralExpression(lang.initializer));
        result[key]={};
        for(const property of lang.initializer.properties){
          assert.ok(ts.isPropertyAssignment(property));
          const label=nameOf(property.name);
          assert.ok(label&&ts.isStringLiteralLike(property.initializer),
            file+"."+key+"."+label+" must be a literal");
          result[key][label]=property.initializer.text;
        }
      }
      table=result;
    }
    ts.forEachChild(node,visit);
  }
  visit(ast);
  assert.ok(table?.cs&&table?.en,file+" copy table not found");
  assert.deepEqual(Object.keys(table.cs).sort(),Object.keys(table.en).sort());
  return table;
}
function flatten(value,prefix=""){
  const result={};
  for(const [key,item] of Object.entries(value)){
    if(typeof item==="function"){
      result[prefix+key+"()"]=item("Example");
      result[prefix+key+"(null)"]=item(null);
    }else if(item&&typeof item==="object")
      Object.assign(result,flatten(item,prefix+key+"."));
    else result[prefix+key]=item;
  }
  return result;
}
function inlineNoteCopy(){
  const ast=parse("app/ui/target-private-note-area-chooser.tsx");
  const messages=[];
  function allStrings(node){
    if(ts.isStringLiteralLike(node)){messages.push(node.text);return;}
    ts.forEachChild(node,allStrings);
  }
  function rendered(node){
    if(ts.isStringLiteralLike(node)){messages.push(node.text);return;}
    if(ts.isParenthesizedExpression(node)){rendered(node.expression);return;}
    if(ts.isConditionalExpression(node)){
      rendered(node.whenTrue);rendered(node.whenFalse);return;
    }
    if(ts.isBinaryExpression(node)){
      if(node.operatorToken.kind===ts.SyntaxKind.AmpersandAmpersandToken)
        rendered(node.right);
      else if(node.operatorToken.kind===ts.SyntaxKind.PlusToken){
        rendered(node.left);rendered(node.right);
      }
    }
  }
  function visit(node){
    if(ts.isCallExpression(node)&&ts.isIdentifier(node.expression)&&
      node.expression.text==="setWriteMessage"&&node.arguments.length)
      allStrings(node.arguments[0]);
    // JSX children contain text; attributes such as data-testid don't.
    if(ts.isJsxExpression(node)&&node.expression&&!ts.isJsxAttribute(node.parent))
      rendered(node.expression);
    if(ts.isJsxText(node)&&node.text.trim())messages.push(node.text.trim());
    ts.forEachChild(node,visit);
  }
  visit(ast);
  return messages;
}
const project=copyTable("app/ui/target-private-project-create.tsx","words");
const note=copyTable("app/ui/target-private-note-area-chooser.tsx","copy");

test("creation copy in both languages, inline note messages and My Plan contain no internal jargon",()=>{
  for(const [component,table] of Object.entries({project,note,myPlan:myPlanCopy})){
    for(const language of ["cs","en"]){
      for(const [key,value] of Object.entries(flatten(table[language]))){
        assert.equal(typeof value,"string",component+"."+language+"."+key);
        assert.doesNotMatch(value,forbidden,component+"."+language+"."+key);
      }
    }
  }
  const messages=inlineNoteCopy();
  assert.ok(messages.length>=15,"all inline note messages must be inspected");
  for(const message of messages)assert.doesNotMatch(message,forbidden,
    "note inline: "+message);
});

test("creation cancelled vs already completed has distinct, equivalent user outcomes and open action",()=>{
  for(const table of [project.cs,project.en]){
    assert.notEqual(table.cancelled,table.settled);
    assert.notEqual(table.cancelled,table.settledUnknown);
    assert.ok(table.cancelUnresolved.length>15);
    assert.ok(table.openProject.length>5&&table.openTask.length>5);
  }
  assert.match(project.cs.cancelled,/zrušeno.*Žádná položka nevznikla/i);
  assert.match(project.en.cancelled,/cancelled.*No item was created/i);
  assert.match(project.cs.settled,/dokončilo.*otevřít/i);
  assert.match(project.en.settled,/finished.*open/i);
  const source=read("app/ui/target-private-project-create.tsx");
  assert.match(source,/if\(result==="cancelled"\)\{\s*setSaved\(null\);setMessage\(c\.cancelled\);/);
  assert.match(source,/if\(receipt\)showCommitted\(receipt\)/);
  assert.match(source,/\{saved&&<button[\s\S]*?openTargetDetail\(/);
});

test("storage errors give recovery steps, and moving day is described consistently",()=>{
  assert.match(project.cs.storage,/Obnovte stránku/);
  assert.match(project.en.storage,/Reload the page/);
  const noteCopy=inlineNoteCopy().join(" ");
  assert.match(noteCopy,/Obnovte stránku/);
  assert.match(noteCopy,/Reload the page/);
  assert.match(myPlanCopy.cs.scopeStatus,/Přesunutí úkolu na jiný den není dostupné/);
  assert.match(myPlanCopy.en.scopeStatus,/Moving a task to another day is not available/);
  assert.match(myPlanCopy.cs.scopeStatus,/při výpadku připojení samy neodešlou/);
  assert.match(myPlanCopy.en.scopeStatus,/not sent automatically while offline/);
});
