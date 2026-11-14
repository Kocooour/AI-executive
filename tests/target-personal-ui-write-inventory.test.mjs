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
  if(ts.isParenthesizedExpression(node)||ts.isAsExpression(node))
    return methodsInOptions(node.expression);
  if(ts.isConditionalExpression(node))
    return [...methodsInOptions(node.whenTrue),...methodsInOptions(node.whenFalse)];
  if(!ts.isObjectLiteralExpression(node))return [];
  return node.properties.flatMap(property=>{
    if(!ts.isPropertyAssignment(property)||propertyName(property.name)!=="method")return [];
    return [ts.isStringLiteralLike(property.initializer)
      ?property.initializer.text.toUpperCase():"<dynamic-method>"];
  });
}
function targetOf(node){
  if(ts.isStringLiteralLike(node))return node.text;
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
          if(!verbs.has(method)&&method!=="<dynamic-method>")continue;
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
test("the owner-approved target-mode write exceptions are exactly ICS, iCloud and Gmail settings",()=>{
  for(const site of approvedIntegrationSites)assert.ok(knownSites.includes(site),site);
  assert.deepEqual(approvedIntegrationSites,[
    "use-lumi-app.tsx|POST|/api/calendar",
    "views/gmail-shared.ts|POST|<url>",
    "views/icloud-calendar-settings.tsx|POST|/api/calendar/icloud",
  ].sort());
});
