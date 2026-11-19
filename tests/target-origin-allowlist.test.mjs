import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { HttpInputError, requireTargetSameOrigin } from "../lib/http-security.ts";

const previous=process.env.AI_EXECUTIVE_ALLOWED_ORIGINS;
after(()=>{
  if(previous===undefined)delete process.env.AI_EXECUTIVE_ALLOWED_ORIGINS;
  else process.env.AI_EXECUTIVE_ALLOWED_ORIGINS=previous;
});

const internal="http://127.0.0.1:3000/api/target-staging/tasks";
const publicOrigin="https://vm13861.tail412944.ts.net";
const req=(origin,site)=>new Request(internal,{method:"POST",headers:{
  ...(origin===undefined?{}:{origin}),
  ...(site===undefined?{}:{"sec-fetch-site":site}),
}});
const allowed=(request)=>assert.doesNotThrow(()=>requireTargetSameOrigin(request));
const denied=(request)=>assert.throws(()=>requireTargetSameOrigin(request),
  error=>error instanceof HttpInputError&&error.status===403);

test("target writes allow exact internal and configured HTTPS origins",()=>{
  process.env.AI_EXECUTIVE_ALLOWED_ORIGINS="https://other.example, "+publicOrigin;
  allowed(req("http://127.0.0.1:3000","same-origin"));
  allowed(req(publicOrigin,"same-origin"));
  allowed(req(publicOrigin)); // non-browser clients may omit Sec-Fetch-Site
});

test("target writes reject missing, opaque, malformed and non-canonical origins",()=>{
  process.env.AI_EXECUTIVE_ALLOWED_ORIGINS=publicOrigin+",null,*";
  for(const origin of [undefined,"null","*","https://user@vm13861.tail412944.ts.net",
    publicOrigin+"/path",publicOrigin+"/","ftp://vm13861.tail412944.ts.net",
    "https://vm13861.tail412944.ts.net:443"]){
    denied(req(origin,"same-origin"));
  }
});

test("target writes require exact scheme, port, hostname and no prefix matches",()=>{
  process.env.AI_EXECUTIVE_ALLOWED_ORIGINS=publicOrigin;
  for(const origin of ["http://vm13861.tail412944.ts.net",
    "https://vm13861.tail412944.ts.net:8443",
    "https://vm13861.tail412944.ts.net.evil.invalid",
    "https://vm13861.tail412944.ts.ne",
    "https://unlisted.invalid"]){
    denied(req(origin,"same-origin"));
  }
});

test("target writes reject cross-site and same-site fetch metadata even if allowlisted",()=>{
  process.env.AI_EXECUTIVE_ALLOWED_ORIGINS=publicOrigin;
  for(const site of ["cross-site","same-site","none","", "SAME-ORIGIN"]){
    denied(req(publicOrigin,site));
  }
  allowed(req(publicOrigin,"same-origin"));
});

const root=path.dirname(fileURLToPath(import.meta.url));
const sourceRoot=path.resolve(root,"..");
const targetRoutes=path.join(sourceRoot,"app/api/target-staging");
const libs=path.join(sourceRoot,"lib");
function* files(dir){
  for(const entry of readdirSync(dir,{withFileTypes:true})){
    const full=path.join(dir,entry.name);
    if(entry.isDirectory())yield* files(full);
    else if(entry.isFile()&&full.endsWith(".ts"))yield full;
  }
}
test("all target write routes use the shared target Origin guard (direct or delegated)",()=>{
  let direct=0,delegated=0;
  const strict=/headers\.get\(["']origin["']\)\s*!==\s*new URL\(request\.url\)\.origin/;
  for(const file of [...files(targetRoutes),
    ...readdirSync(libs).filter(n=>n.endsWith("-http.ts")).map(n=>path.join(libs,n))]){
    const source=readFileSync(file,"utf8");
    assert.doesNotMatch(source,strict,"obsolete strict equality in "+file);
    if(!file.startsWith(targetRoutes+path.sep)||!file.endsWith("route.ts"))continue;
    if(!/export async function (?:POST|PATCH|PUT|DELETE)\b/.test(source))continue;
    if(source.includes("requireTargetSameOrigin(request)")){direct++;continue;}
    assert.match(source,/from ["'][^"']*target-private-(?:task|structure)-create-http["']/,
      "unguarded write route "+file);
    assert.match(source,/return postPrivate(?:Task|Project|ProjectTask)[A-Za-z]*\(request\);/,
      "unguarded write route "+file);
    delegated++;
  }
  // Keep the guard inventory explicit; a new writer must be classified and protected.
  assert.equal(direct,26);
  assert.equal(delegated,12);
  for(const file of ["target-private-task-create-http.ts","target-private-structure-create-http.ts"]){
    assert.match(readFileSync(path.join(libs,file),"utf8"),/requireTargetSameOrigin\(request\)/);
  }
});
