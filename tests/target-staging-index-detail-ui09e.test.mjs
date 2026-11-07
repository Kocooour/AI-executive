import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import path from "node:path";
import {test} from "node:test";
import {stagingIndexDetailHref} from "../lib/target-staging-index-detail-links.ts";

const root=path.join(import.meta.dirname,"..");
const read=(name)=>readFileSync(path.join(root,name),"utf8");
const gate={project:true,note:true};

test("UI-09e only explicitly allowed project/note preview URLs, never task URLs",()=>{
  assert.equal(stagingIndexDetailHref("project","p-1",gate),
    "/target-staging/projects/p-1/preview");
  assert.equal(stagingIndexDetailHref("note","note:a+b",gate),
    "/target-staging/notes/note%3Aa%2Bb/preview");
  assert.equal(stagingIndexDetailHref("task","t-1",gate),null);
  assert.equal(stagingIndexDetailHref("project","p-1",{project:false,note:true}),null);
  assert.equal(stagingIndexDetailHref("note","n-1",{project:true,note:false}),null);
  assert.equal(stagingIndexDetailHref("note","n-1",{project:false,note:false}),null);
});
test("UI-09e rejects ambiguous, overly long and malformed destination IDs",()=>{
  for(const id of ["","..","."," secret","secret ","abc/def","abc\\def",
    "bad\n","bad\0","\ud800","ä".repeat(260)]){
    assert.equal(stagingIndexDetailHref("project",id,gate),null,JSON.stringify(id));
    assert.equal(stagingIndexDetailHref("note",id,gate),null,JSON.stringify(id));
  }
  assert.equal(stagingIndexDetailHref("note",42,gate),null);
  assert.equal(stagingIndexDetailHref("note","ok",{project:true,note:true}),"/target-staging/notes/ok/preview");
  assert.equal(stagingIndexDetailHref("project","x?filter=shared",gate),
    "/target-staging/projects/x%3Ffilter%3Dshared/preview");
  assert.equal(stagingIndexDetailHref("note","#secret",gate),
    "/target-staging/notes/%23secret/preview");
});
test("UI-09e server-controlled separate gate and destination opt-ins",()=>{
  const page=read("app/target-staging/global-index/preview/page.tsx");
  const ui=read("app/ui/target-staging-global-index-preview.tsx");
  const css=read("app/target-staging/global-index/preview/preview.css");
  for(const flag of [
    "AI_EXECUTIVE_TARGET_STAGING_INDEX_DETAIL_LINKS_ENABLED",
    "AI_EXECUTIVE_TARGET_STAGING_PROJECT_TASKS_CLIENT_PREVIEW_ENABLED",
    "AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_ENABLED",
    "AI_EXECUTIVE_TARGET_STAGING_NOTE_CLIENT_PREVIEW_ENABLED",
  ])assert.ok(page.includes(flag),flag);
  assert.ok(page.includes("projectDetailEnabled={projectDetailEnabled}"));
  assert.ok(page.includes("noteDetailEnabled={noteDetailEnabled}"));
  assert.ok(ui.includes("projectDetailEnabled=false,noteDetailEnabled=false"));
  assert.ok(ui.includes("stagingIndexDetailHref(entry.kind,entry.item.id"));
  assert.ok(ui.includes("href={href}"));
  assert.ok(ui.includes("Otevřít projekt: "));
  assert.ok(ui.includes("Otevřít poznámku: "));
  assert.match(css,/stagingGlobalItemLink:focus-visible/);
  assert.doesNotMatch(ui,/item\.areaId\}|item\.projectId\}|note\.body|localStorage|sessionStorage|indexedDB/);
  for(const file of [
    "app/ui/navigation.ts","app/ui/views/mobile-nav.tsx",
    "app/ui/views/sidebar.tsx","app/ui/views/topbar.tsx",
  ])assert.doesNotMatch(read(file),/target-staging\/(?:global-index|notes|projects)/,file);
});
