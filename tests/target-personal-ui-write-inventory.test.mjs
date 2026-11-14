/** C22 / #443: closed inventory of UI fetch mutation sites in target mode.
 *
 * These are existing, reviewed entry points, NOT blanket authorization:
 * legacy content writers must still obey their target-mode gates. Adding a
 * new fetch mutation (even to an existing URL) requires an explicit review.
 * Integration settings are an owner-approved exception: ICS, iCloud, Gmail.
 */
import assert from "node:assert/strict";
import {readFileSync,readdirSync} from "node:fs";
import path from "node:path";
import {test} from "node:test";
import ts from "typescript";

const root=path.resolve(import.meta.dirname,"../app/ui");
const verbs=new Set(["POST","PUT","PATCH","DELETE"]);
const knownSites=[
  ["hooks/use-attention.ts","POST","/api/attention"],
  ["hooks/use-backups.ts","POST","/api/backups"],
  ["hooks/use-backups.ts","POST","/api/backups"],
  ["hooks/use-backups.ts","POST","/api/backups/import"],
  ["hooks/use-context-evidence.ts","POST","<url>"],
  ["hooks/use-day-plan.ts","POST","/api/work-sessions"],
  ["hooks/use-day-plan.ts","POST","/api/day-plan"],
  ["hooks/use-day-plan.ts","POST","/api/ai/actions"],
  ["hooks/use-day-plan.ts","POST","/api/ai/actions"],
  ["hooks/use-day-plan.ts","POST","/api/ai/actions"],
  ["hooks/use-notifications.ts","POST","/api/notifications"],
  ["hooks/use-notifications.ts","POST","/api/notifications"],
  ["hooks/use-notifications.ts","POST","/api/notifications"],
  ["hooks/use-notifications.ts","POST","/api/notifications"],
  ["hooks/use-passkeys.ts","POST","/api/auth/passkeys/register/options"],
  ["hooks/use-passkeys.ts","POST","/api/auth/passkeys/register/verify"],
  ["hooks/use-passkeys.ts","DELETE","/api/auth/passkeys"],
  ["hooks/use-sign-in.ts","POST","/api/auth/login"],
  ["hooks/use-sign-in.ts","POST","/api/auth/passkeys/login/options"],
  ["hooks/use-sign-in.ts","POST","/api/auth/passkeys/login/verify"],
  ["hooks/use-sync.ts","PUT","/api/store"],
  ["use-lumi-app.tsx","POST","/api/ai"],
  ["use-lumi-app.tsx","POST","/api/ai/actions"],
  ["use-lumi-app.tsx","POST","/api/ai/actions"],
  ["use-lumi-app.tsx","POST","/api/executive"],
  ["use-lumi-app.tsx","POST","/api/calendar"],
  ["use-lumi-app.tsx","POST","/api/context"],
  ["use-lumi-app.tsx","POST","/api/context/subjects"],
  ["use-lumi-app.tsx","POST","/api/context/subjects"],
  ["use-lumi-app.tsx","POST","/api/context/claims"],
  ["use-lumi-app.tsx","POST","/api/context/claims"],
  ["use-lumi-app.tsx","POST","/api/context/history"],
  ["use-lumi-app.tsx","POST","/api/context/inbox"],
  ["use-lumi-app.tsx","POST","/api/context/inbox"],
  ["use-lumi-app.tsx","POST","/api/auth/logout"],
  ["use-lumi-app.tsx","POST","/api/task-suggestions"],
  ["use-lumi-app.tsx","POST","/api/inbox/batch"],
  ["views/icloud-calendar-settings.tsx","POST","/api/calendar/icloud"],
  ["views/gmail-shared.ts","POST","<url>"],
].map(parts=>parts.join("|")).sort();

const approvedIntegrationSites=[
  "use-lumi-app.tsx|POST|/api/calendar", // ICS connect, refresh, disconnect
  "views/icloud-calendar-settings.tsx|POST|/api/calendar/icloud",
  "views/gmail-shared.ts|POST|<url>", // /api/mail/gmail and /api/mail/gmail/sync
].sort();

const delegatedSites=[
  // Wrappers whose URL is passed to fetch indirectly. Their call sites
  // must be pinned too: changing a Gmail target must never evade the
  // inventory just because gmailJson itself calls fetch(url, ...).
  ["hooks/use-context-evidence.ts","post","/api/context/sources"],
  ["hooks/use-context-evidence.ts","post","/api/context/sources"],
  ["hooks/use-context-evidence.ts","post","/api/context/evidence"],
  ["hooks/use-context-evidence.ts","post","/api/context/evidence"],
  ["views/gmail-settings.tsx","gmailJson","<url>"],
  ["views/gmail-settings.tsx","json","/api/mail/gmail?workspaceId=*"],
  ["views/gmail-settings.tsx","json","/api/mail/gmail"],
  ["views/gmail-settings.tsx","json","/api/mail/gmail"],
  ["views/gmail-settings.tsx","json","/api/mail/gmail/sync"],
  ["views/gmail-settings.tsx","json","/api/mail/gmail/sync"],
  ["views/gmail-reader.tsx","gmailJson","<url>"],
  ["views/gmail-reader.tsx","json","/api/mail/gmail?workspaceId=*"],
  ["views/gmail-reader.tsx","json","/api/mail/gmail/messages"],
  ["views/gmail-reader.tsx","json","/api/mail/gmail/message"],
  ["views/gmail-reader.tsx","json","/api/mail/gmail/thread"],
].map(parts=>parts.join("|")).sort();

function sources(dir=root){
  return readdirSync(dir,{withFileTypes:true}).flatMap(entry=>{
    const file=path.join(dir,entry.name);
    return entry.isDirectory()?sources(file):
      entry.isFile()&&/\.[jt]sx?$/.test(entry.name)?[file]:[];
  });
}
function propertyName(name){
  return ts.isIdentifier(name)||ts.isStringLiteral(name)?name.text:null;
}
function methodsInOptions(node){
  if(ts.isParenthesizedExpression(node)||ts.isAsExpression(node)||
    ts.isSatisfiesExpression(node)||ts.isTypeAssertionExpression(node))
    return methodsInOptions(node.expression);
  if(ts.isConditionalExpression(node))
    return [...methodsInOptions(node.whenTrue),...methodsInOptions(node.whenFalse)];
  // A variable or spread may hide {method:"POST"}. Fail closed instead
  // of silently treating that call as a GET.
  if(!ts.isObjectLiteralExpression(node))return ["<unknown-options>"];
  const methods=[];
  for(const property of node.properties){
    if(!ts.isPropertyAssignment(property))return ["<unknown-options>"];
    const name=propertyName(property.name);
    if(name===null)return ["<unknown-options>"];
    if(name==="method")
      methods.push(ts.isStringLiteralLike(property.initializer)
        ?property.initializer.text.toUpperCase():"<dynamic-method>");
  }
  return methods;
}
function targetOf(node){
  if(ts.isStringLiteralLike(node))return node.text;
  if(ts.isBinaryExpression(node)&&
    node.operatorToken.kind===ts.SyntaxKind.PlusToken&&ts.isStringLiteralLike(node.left))
    return node.left.text+"*";
  if(ts.isTemplateExpression(node))return node.head.text+"*";
  if(ts.isIdentifier(node))return "<"+node.text+">";
  return "<dynamic-url>";
}
function inventory(){
  const found=[];
  for(const file of sources()){
    const source=readFileSync(file,"utf8");
    const ast=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true,
      file.endsWith(".tsx")?ts.ScriptKind.TSX:ts.ScriptKind.TS);
    assert.equal(ast.parseDiagnostics.length,0,file+" is not parseable");
    function visit(node){
      if(ts.isCallExpression(node)&&ts.isIdentifier(node.expression)&&
        node.expression.text==="fetch"&&node.arguments.length>=2){
        const methods=methodsInOptions(node.arguments[1]);
        for(const method of methods){
          if(!verbs.has(method)&&method!=="<dynamic-method>"&&
            method!=="<unknown-options>")continue;
          found.push([path.relative(root,file).split(path.sep).join("/"),method,
            targetOf(node.arguments[0])].join("|"));
        }
      }
      ts.forEachChild(node,visit);
    }
    visit(ast);
  }
  return found.sort();
}
test("all direct app/ui fetch mutation sites are inventoried; new unreviewed writes fail closed",()=>{
  assert.deepEqual(inventory(),knownSites);
});
/** Pin the actual endpoints reached through the existing dynamic wrappers.
 * A new caller or URI needs an explicit review; the fetch(url) snapshot alone
 * cannot distinguish Gmail from an unapproved content-write endpoint.
 */
function delegatedInventory(){
  const result=[];
  for(const file of sources()){
    const relative=path.relative(root,file).split(path.sep).join("/");
    const gmailView=relative==="views/gmail-settings.tsx"||
      relative==="views/gmail-reader.tsx";
    const contextEvidence=relative==="hooks/use-context-evidence.ts";
    const source=readFileSync(file,"utf8");
    const ast=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true,
      file.endsWith(".tsx")?ts.ScriptKind.TSX:ts.ScriptKind.TS);
    function visit(node){
      if(ts.isCallExpression(node)&&ts.isIdentifier(node.expression)&&
        node.arguments.length>0){
        const fn=node.expression.text;
        if(fn==="gmailJson"||(fn==="json"&&gmailView)||
          (fn==="post"&&contextEvidence))
          result.push([relative,fn,targetOf(node.arguments[0])].join("|"));
      }
      ts.forEachChild(node,visit);
    }
    visit(ast);
  }
  return result.sort();
}
test("dynamic Gmail and context write wrappers have a closed destination inventory",()=>{
  assert.deepEqual(delegatedInventory(),delegatedSites);
});
test("fetch options cannot hide a new mutation behind an identifier or spread",()=>{
  for(const options of ["writeOptions","{...writeOptions}","{ method: requestMethod }"]){
    const source=ts.createSourceFile("unsafe.ts",
      'fetch("/api/unreviewed", '+options+')',ts.ScriptTarget.Latest,true);
    let found=null;
    function visit(node){
      if(ts.isCallExpression(node)&&ts.isIdentifier(node.expression)&&
        node.expression.text==="fetch")found=methodsInOptions(node.arguments[1]);
      ts.forEachChild(node,visit);
    }
    visit(source);
    assert.deepEqual(found,[options.includes("requestMethod")
      ?"<dynamic-method>":"<unknown-options>"]);
  }
});
test("the owner-approved target-mode write exceptions are exactly ICS, iCloud and Gmail settings",()=>{
  for(const site of approvedIntegrationSites)assert.ok(knownSites.includes(site),site);
  assert.deepEqual(approvedIntegrationSites,[
    "use-lumi-app.tsx|POST|/api/calendar",
    "views/gmail-shared.ts|POST|<url>",
    "views/icloud-calendar-settings.tsx|POST|/api/calendar/icloud",
  ].sort());
});
