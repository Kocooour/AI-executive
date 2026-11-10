/** R3-CAPTURE-1: real target Notes shell with a mocked Area read response.
 * Server ACL is separately proven against real pinned staging SQLite in
 * tests/target-private-note-area-http.test.mjs. No create or external writes. */
import {expect,test} from "./fixtures";
import type {Page,Route} from "@playwright/test";
test.skip(process.env.LUMI_PRIVATE_NOTE_AREAS_E2E!=="true",
  "Private note Area chooser is only enabled in the isolated focused browser job");
const headers={"content-type":"application/json","cache-control":"no-store"};
const reply=(route:Route,body:unknown,status=200)=>route.fulfill({
  status,headers,body:JSON.stringify(body),
});
const generation="A".repeat(43);
const choices=[{id:"personal-a",title:"Osobní"},{id:"personal-b",title:"Rodina"}];
async function setup(page:Page,handler:(route:Route)=>Promise<void>){
  let writes=0;
  page.on("request",req=>{
    if(req.method()!=="GET"&&req.url().includes("/api/target-staging/notes"))writes++;
  });
  await page.route("**/api/target-staging/session",route=>
    reply(route,{generation}));
  await page.route("**/api/target-staging/note-index/global**",route=>{
    const scope=new URL(route.request().url()).searchParams.get("scope");
    return reply(route,{scope,notes:[],hasMore:false,nextCursor:null});
  });
  await page.route("**/api/target-staging/notes/create-targets",handler);
  await page.goto("/?view=Notes");
  await expect(page.getByTestId("target-scope-list")).toHaveAttribute("data-state","ready");
  return ()=>writes;
}
for(const width of [390,1280]){
  test(`authorized private Area choices show no shared/foreign data at ${width}px`,async({page})=>{
    await page.setViewportSize({width,height:844});
    const writes=await setup(page,route=>reply(route,{areas:choices}));
    await page.getByTestId("target-private-area-open").click();
    const modal=page.getByTestId("target-private-note-areas");
    await expect(modal).toBeVisible();
    await expect(modal.getByRole("note")).toContainText(
      /nic se neukládá|nothing is saved/);
    const select=page.getByTestId("target-private-area-select");
    await expect(select.getByRole("option")).toHaveCount(3);
    await expect(select.getByRole("option",{name:"Rodina"})).toHaveCount(1);
    await expect(modal).not.toContainText("Shared");
    await select.selectOption("personal-b");
    await expect(page.getByTestId("target-private-area-selected")).toContainText("Rodina");
    await modal.getByRole("button",{name:"Zavřít"}).click();
    await expect(modal).toHaveCount(0);
    expect(writes()).toBe(0);
  });
}
test("read refusal keeps private area titles hidden and dispatches no write",async({page})=>{
  const writes=await setup(page,route=>reply(route,{error:"Staging unavailable"},503));
  await page.getByTestId("target-private-area-open").click();
  const modal=page.getByTestId("target-private-note-areas");
  await expect(modal).toContainText("Dostupné Oblasti nelze ověřit");
  await expect(page.getByTestId("target-private-area-select")).toHaveCount(0);
  expect(writes()).toBe(0);
});
test("malformed response cannot populate the chooser or silently choose a destination",async({page})=>{
  const writes=await setup(page,route=>reply(route,{
    areas:[...choices,{id:"team",title:"Shared",areaKind:"shared"}],
  }));
  await page.getByTestId("target-private-area-open").click();
  await expect(page.getByTestId("target-private-note-areas")).toContainText(
    "Dostupné Oblasti nelze ověřit");
  await expect(page.getByTestId("target-private-area-select")).toHaveCount(0);
  expect(writes()).toBe(0);
});

/** Simulate the browser's persisted BFCache lifecycle in a real Chromium DOM.
 * The session endpoint is held across pageshow: any old private title visible
 * during that gap would be an information leak. These are synthetic lifecycle
 * events, not a full browser back/forward navigation or release E2E. */
for(const width of [390,1280]){
  for(const sessionOutcome of ["authorized","revoked"] as const){
    test(`BFCache pagehide clears private Areas before delayed ${sessionOutcome} session check at ${width}px`,async({page})=>{
      await page.setViewportSize({width,height:844});
      let catalog=choices,areaReads=0;
      const writes=await setup(page,route=>{
        areaReads++;
        return reply(route,{areas:catalog});
      });
      await page.getByTestId("target-private-area-open").click();
      const modal=page.getByTestId("target-private-note-areas");
      const select=page.getByTestId("target-private-area-select");
      await expect(select.getByRole("option",{name:"Rodina"})).toHaveCount(1);
      await select.selectOption("personal-b");
      await expect(page.getByTestId("target-private-area-selected")).toContainText("Rodina");
      expect(areaReads).toBe(1);

      let holdSession=true;
      const pending:Route[]=[];
      // This later route takes priority over the setup session mock.
      await page.route("**/api/target-staging/session",route=>{
        if(holdSession){pending.push(route);return;}
        return sessionOutcome==="revoked"
          ?reply(route,{error:"Authentication required"},401)
          :reply(route,{generation});
      });
      const frozen=await page.evaluate(()=>{
        window.dispatchEvent(new PageTransitionEvent("pagehide",{persisted:true}));
        const el=document.querySelector('[data-testid="target-private-note-areas"]');
        return el?.textContent??"";
      });
      // Synchronous: no private text may be left in the BFCache snapshot.
      expect(frozen).not.toContain("Rodina");
      expect(frozen).not.toContain("Osobní");
      await expect(select).toHaveCount(0);
      await expect(page.getByTestId("target-private-area-selected")).toHaveCount(0);

      catalog=[{id:"personal-c",title:"Nová soukromá Oblast"}];
      await page.evaluate(()=>{
        window.dispatchEvent(new PageTransitionEvent("pageshow",{persisted:true}));
      });
      await expect.poll(()=>pending.length).toBeGreaterThan(0);
      await expect(modal).not.toContainText("Rodina");
      await expect(modal).not.toContainText("Osobní");
      await expect(select).toHaveCount(0);
      await expect(page.getByTestId("target-private-area-selected")).toHaveCount(0);
      expect(areaReads).toBe(1,"a private catalogue GET must wait for fresh session verification");

      holdSession=false;
      for(const route of pending.splice(0)){
        if(sessionOutcome==="revoked")await reply(route,{error:"Authentication required"},401);
        else await reply(route,{generation});
      }
      if(sessionOutcome==="authorized"){
        // Same generation, changed private Area policy: only the NEW server
        // response may appear, with no inherited selection from before hide.
        await expect(page.getByTestId("target-private-area-select")
          .getByRole("option",{name:"Nová soukromá Oblast"})).toHaveCount(1);
        await expect(modal).not.toContainText("Rodina");
        await expect(page.getByTestId("target-private-area-selected")).toHaveCount(0);
        expect(areaReads).toBe(2);
      }else{
        await expect(modal).not.toContainText("Rodina");
        await expect(select).toHaveCount(0);
        await expect(page.getByTestId("target-private-area-selected")).toHaveCount(0);
        expect(areaReads).toBe(1,"revocation must not re-fetch private Areas");
      }
      expect(writes()).toBe(0);
    });
  }
}
