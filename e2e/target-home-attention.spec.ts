/** E-1 review acceptance. Real Next routes, isolated SQLite and an explicitly
 * preloaded test-only server clock shared with attention children. No fake
 * task/ACL/command responses; the held PATCH is the real server response. */
import {test,expect} from "./fixtures";
import {DatabaseSync} from "node:sqlite";
import {readFileSync,writeFileSync,renameSync,realpathSync} from "node:fs";
import path from "node:path";
import type {Page,Route} from "@playwright/test";

const mode=process.env.LUMI_TARGET_ATTENTION_E2E;
test.skip(mode!=="true"&&mode!=="off","Dedicated isolated E-1 browser run only");
const zone="Europe/Prague",DAY=86_400_000;
const day=(ms:number)=>new Intl.DateTimeFormat("sv-SE",{timeZone:zone,dateStyle:"short"}).format(ms);
const localInput=(ms:number)=>{
  const parts=new Intl.DateTimeFormat("sv-SE",{timeZone:zone,year:"numeric",month:"2-digit",day:"2-digit",
    hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).formatToParts(ms);
  const p=(type:string)=>parts.find(x=>x.type===type)!.value;
  return p("year")+"-"+p("month")+"-"+p("day")+"T"+p("hour")+":"+p("minute");
};
function fixture(width:number){
  const run=realpathSync(process.env.LUMI_E2E_RUN_DIR!);
  const store=JSON.parse(process.env.LUMI_E2E_TARGET_STORE!);
  if(!path.basename(run).startsWith("lumi-e2e-")||store.ownerUserId!=="e2e-owner"||
    realpathSync(store.directory)!==path.join(run,"target-store"))throw Error("E-1 fixture must be isolated");
  const clock=path.join(run,"attention-clock.json");
  const now=Number(JSON.parse(readFileSync(clock,"utf8")));
  const setClock=(ms:number)=>{
    const tmp=clock+".new";writeFileSync(tmp,JSON.stringify(ms),{mode:0o600});renameSync(tmp,clock);
  };
  const db=new DatabaseSync(path.join(store.directory,"lumi-target.sqlite"));
  const prefix="e1:"+width+":";
  const titles=["Po termínu A","Po termínu B","Po termínu C","Po termínu D","Termín zítra","Propadlé Kdy"].map(t=>"E1 "+width+" "+t);
  try{
    db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000");
    // The first viewport's disposable rows cannot crowd out the second.
    db.prepare("UPDATE tasks SET status='completed',completed_at_ms=? WHERE id LIKE 'e1:390:%' AND status='open'").run(now);
    db.prepare("UPDATE personal_notification_settings SET time_zone=? WHERE user_id=?").run(zone,store.ownerUserId);
    const put=db.prepare("INSERT INTO tasks(id,area_id,title,due_on,assignee_user_id) VALUES (?,?,?,?,?)");
    const area=store.seed.areaId;
    for(let i=0;i<6;i++)put.run(prefix+i,area,titles[i],i<4?day(now-(10-i)*DAY):i===4?day(now+DAY):null,null);
    db.prepare("INSERT INTO personal_task_plans(user_id,task_id,when_on) VALUES (?,?,?)").run(store.ownerUserId,prefix+5,day(now-DAY));
    put.run(prefix+"done",area,"E1 completed "+width,day(now-20*DAY),null);
    db.prepare("UPDATE tasks SET status='completed',completed_at_ms=? WHERE id=?").run(now,prefix+"done");
    const foreign=store.seed.revokeProjects[String(width)];
    put.run(prefix+"foreign","area:unassigned:"+foreign.adminId,"E1 foreign "+width,day(now-20*DAY),null);
    // Make the shared task genuinely accessible and assigned, rather than
    // relying on an unrelated ACL denial to make the personal filter pass.
    db.prepare("UPDATE area_members SET role='editor' WHERE area_id=? AND user_id=?").run(foreign.areaId,store.ownerUserId);
    put.run(prefix+"shared",foreign.areaId,"E1 shared "+width,day(now-20*DAY),store.ownerUserId);
  }finally{db.close();}
  const completeConcurrent=(index:number)=>{
    // Simulate another device's committed completion in this disposable store,
    // without waiting behind the browser's intentionally stalled read queue.
    const db=new DatabaseSync(path.join(store.directory,"lumi-target.sqlite"));
    try{
      db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000");
      expect(db.prepare("UPDATE tasks SET status='completed',completed_at_ms=? WHERE id=? AND status='open'").run(now,prefix+index).changes).toBe(1);
    }finally{db.close();}
  };
  return {now,setClock,titles,completeConcurrent};
}
const panel=(page:Page)=>page.getByTestId("target-home-attention");
const items=(page:Page)=>panel(page).getByTestId("target-home-attention-item");
const row=(page:Page,title:string)=>items(page).filter({hasText:title});
const isPath=(url:string,p:string)=>new URL(url).pathname===p;
const session="/api/target-staging/session";
const dayRoute="/api/target-staging/task-temporal/my-plan-day";
async function poll(page:Page){
  const verified=page.waitForResponse(r=>isPath(r.url(),session)&&r.status()===200);
  const overview=page.waitForResponse(r=>isPath(r.url(),dayRoute)&&r.status()===200);
  await page.clock.fastForward(61_000);
  await verified;await overview;
}
for(const width of [390,1280]){
  test("E-1 real Home lifecycle and privacy at "+width,async({page})=>{
    test.skip(mode!=="true","attention enabled run");
    test.setTimeout(180_000);
    const {now,setClock,titles,completeConcurrent}=fixture(width);
    await page.setViewportSize({width,height:844});
    await page.clock.install({time:new Date(now)});
    const firstRead=page.waitForResponse(r=>isPath(r.url(),"/api/target-staging/attention")&&r.status()===200);
    await page.goto("/?view=Home&scope=personal");
    const first=await (await firstRead).json();
    expect(first.evaluatedAtMs).toBe(now);
    expect(first.timeZone).toBe(zone);
    await expect(panel(page)).toBeVisible({timeout:30_000});
    await expect(items(page)).toHaveCount(5);
    await expect(items(page).locator("strong")).toHaveText(titles.slice(0,5));
    await expect(panel(page)).not.toContainText(/E1 (completed|foreign|shared)/);
    await row(page,titles[0]).locator("summary").click();
    await expect(row(page,titles[0])).toContainText("Zdroj: termín úkolu");
    await expect(row(page,titles[0])).not.toContainText(zone);
    await expect(row(page,titles[0]).locator("details")).not.toContainText(/Zdroj: termín úkolu:/);
    await panel(page).getByRole("button",{name:"Další upozornění"}).click();
    await expect(items(page)).toHaveCount(6);
    await expect(items(page).locator("strong")).toHaveText(titles);
    await expect(row(page,titles[4])).toHaveAttribute("data-rule","deadline_soon");
    await expect(row(page,titles[4])).toContainText("Termín do 48 hodin");
    await expect(row(page,titles[5])).toHaveAttribute("data-rule","planned_date_passed");
    await row(page,titles[5]).locator("summary").click();
    await expect(row(page,titles[5])).toContainText("Zdroj: osobní plán");
    // A real verified poll must keep expanded DOM, open Why and focus
    // throughout the new pinned cursor chain, including while GET is held.
    const summary=row(page,titles[5]).locator("summary");
    await summary.focus();
    const attentionPath="/api/target-staging/attention";
    let releaseRead=()=>{},readHeld=false;
    const readBarrier=new Promise<void>(r=>{releaseRead=r;});
    const holdRead=async(route:Route)=>{
      if(!readHeld){readHeld=true;await readBarrier;}
      await route.continue().catch(()=>{});
    };
    const readPattern=/\/api\/target-staging\/attention\?.*$/;
    await page.route(readPattern,holdRead);
    try{
      const verified=page.waitForResponse(r=>isPath(r.url(),session)&&r.status()===200);
      await page.clock.fastForward(61_000);await verified;
      await expect.poll(()=>readHeld).toBe(true);
      await expect(items(page)).toHaveCount(6);
      await expect(summary).toBeFocused();
      await expect(row(page,titles[5]).locator("details")).toHaveAttribute("open","");
      await expect(page.getByText("Načítám upozornění…",{exact:true})).toHaveCount(0);
      const appended=page.waitForResponse(r=>isPath(r.url(),attentionPath)&&
        new URL(r.url()).searchParams.has("cursor")&&r.status()===200);
      releaseRead();await appended;
      await expect(items(page)).toHaveCount(6);
      await expect(summary).toBeFocused();
      await expect(row(page,titles[5]).locator("details")).toHaveAttribute("open","");
    }finally{releaseRead();await page.unroute(readPattern,holdRead);}
    await panel(page).getByRole("button",{name:"Méně upozornění"}).click();
    await expect(items(page)).toHaveCount(5);
    // The picker is a local draft. No attention GET may begin until it
    // closes; the actual session poll and overview revalidation still run.
    const firstRow=row(page,titles[0]);
    await firstRow.getByRole("button",{name:"Odložit",exact:true}).click();
    const draft=firstRow.locator('input[type="datetime-local"]');
    const drafted=localInput(Math.ceil((now+20*60_000)/60_000)*60_000);
    await draft.fill(drafted);await draft.focus();
    await expect(firstRow.getByRole("button",{name:"Zítra 8:00",exact:true})).toBeVisible();
    expect(await draft.getAttribute("min")).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    expect(await draft.getAttribute("max")).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    let pickerReads=0;
    const countRead=(request:import("@playwright/test").Request)=>{
      if(request.method()==="GET"&&isPath(request.url(),attentionPath))pickerReads++;
    };
    page.on("request",countRead);
    try{
      await poll(page);
      await expect(draft).toHaveValue(drafted);
      await expect(draft).toBeFocused();
      await expect(items(page)).toHaveCount(5);
      expect(pickerReads).toBe(0);
      const refreshed=page.waitForResponse(r=>isPath(r.url(),attentionPath)&&r.status()===200);
      await firstRow.getByRole("button",{name:"Zrušit",exact:true}).click();
      await refreshed;
      await expect(draft).toHaveCount(0);
      await expect(firstRow.getByRole("button",{name:"Odložit",exact:true})).toBeFocused();
    }finally{page.off("request",countRead);}
    // Hold the acknowledged real commit across a routine session poll and
    // the bounded PATCH deadline. Only the original receipt may establish Undo.
    let release=()=>{};const barrier=new Promise<void>(r=>{release=r;});
    let committed=false,patches=0,original="";
    const pattern="**/api/target-staging/attention/command";
    const hold=async(route:Route)=>{
      if(route.request().method()!=="PATCH"){await route.continue();return;}
      patches++;original=route.request().postData()||"";
      const response=await route.fetch();
      committed=response.status()===200;
      await barrier;
      // The timed-out browser request can already have been cancelled.
      await route.fulfill({response}).catch(()=>{});
    };
    await page.route(pattern,hold);
    try{
      await row(page,titles[0]).getByRole("button",{name:"Skrýt",exact:true}).click();
      await expect.poll(()=>committed).toBe(true);
      const receipt=page.waitForResponse(r=>isPath(r.url(),"/api/target-staging/attention/command/receipt")&&r.status()===200);
      await poll(page);
      const reply=await receipt;
      expect(reply.request().postData()).toBe(original);
      expect(await reply.json()).toEqual({status:"committed"});
      await expect(row(page,titles[0])).toHaveCount(0);
      await expect(panel(page).getByRole("button",{name:/^Zpět: (skrytí|odložení) úkolu /})).toBeVisible();
      expect(patches).toBe(1);
      release();
    }finally{release();await page.unroute(pattern,hold);}
    // A further successful poll after acknowledgement cannot erase Undo.
    await poll(page);
    await expect(panel(page).getByRole("button",{name:/^Zpět: (skrytí|odložení) úkolu /})).toBeVisible();
    await panel(page).getByRole("button",{name:/^Zpět: (skrytí|odložení) úkolu /}).click();
    await expect(row(page,titles[0])).toBeVisible();
    await expect(page.locator(".targetHomeAttentionFeedback").getByText("Upozornění bylo obnoveno.")).toBeVisible();
    await page.clock.fastForward(8_001);
    await expect(page.locator(".targetHomeAttentionFeedback").getByText("Upozornění bylo obnoveno.")).toHaveCount(0);
    // Real snooze through the UI; shift the isolated server clock, then
    // re-read without altering the actual stored snooze row.
    const until=Math.ceil((now+10*60_000)/60_000)*60_000;
    await row(page,titles[0]).getByRole("button",{name:"Odložit",exact:true}).click();
    await row(page,titles[0]).locator('input[type="datetime-local"]').fill(localInput(until));
    await row(page,titles[0]).getByRole("button",{name:"Potvrdit",exact:true}).click();
    await expect(row(page,titles[0])).toHaveCount(0);
    await expect(page.locator(".targetHomeAttentionFeedback").getByText("Upozornění bylo upraveno.")).toBeVisible();
    setClock(until-1);
    await page.reload();
    await expect(panel(page)).toBeVisible();
    await expect(row(page,titles[0])).toHaveCount(0);
    setClock(until+1);
    await page.reload();
    await expect(row(page,titles[0])).toBeVisible();
    // Permanent dismissal survives a reload; completion through real detail
    // invalidation removes the other attention candidate without a reload.
    await row(page,titles[0]).getByRole("button",{name:"Skrýt",exact:true}).click();
    await expect(row(page,titles[0])).toHaveCount(0);
    await page.reload();
    await expect(panel(page)).toBeVisible();
    await expect(row(page,titles[0])).toHaveCount(0);
    await row(page,titles[1]).getByRole("button",{name:"Otevřít úkol "+titles[1]}).click();
    const detail=page.getByTestId("target-detail");
    await expect(detail).toBeVisible();
    const completion=page.waitForResponse(r=>
      isPath(r.url(),"/api/target-staging/task-temporal/status")&&
      r.request().method()==="PATCH"&&r.request().postDataJSON()?.taskId==="e1:"+width+":1",
      {timeout:35_000});
    await detail.getByTestId("target-detail-edit-status-toggle").click();
    const completed=await completion;
    // Record the actual HTTP outcome; the detail controller allows 30 seconds
    // for its guarded write/receipt. Require confirmed UI state, never pending.
    await expect(detail.getByTestId("target-detail-edit-status"),
      "Completion PATCH HTTP "+completed.status()).toContainText("Stav úkolu je uložen.",{timeout:35_000});
    await expect(detail.getByText("Dokončeno",{exact:true})).toBeVisible({timeout:25_000});
    // The same inspector control is labelled Zpět on mobile and Zavřít on desktop.
    // Match the actual responsive control, not the desktop-only label.
    await detail.locator("button.inspectorClose").click({timeout:10_000});
    await expect(detail).toHaveCount(0);
    await expect(row(page,titles[1])).toHaveCount(0);
    await expect(row(page,titles[4])).toBeVisible();
    // Hold a preview with no HTTP response. A concurrently completed task
    // must disappear when the verified poll runs; the expired preview must
    // not dispatch a mutation, and the surviving rows must be usable again.
    let heldPreview=0,unexpectedPatch=0;
    const previewPattern=/\/api\/target-staging\/attention\/command\?.*$/;
    const holdPreview=async(route:Route)=>{
      heldPreview++;
      // Never fulfill: the application deadline must cancel this request.
    };
    const countPatch=(request:import("@playwright/test").Request)=>{
      if(request.method()==="PATCH"&&isPath(request.url(),"/api/target-staging/attention/command"))unexpectedPatch++;
    };
    await page.route(previewPattern,holdPreview);
    page.on("request",countPatch);
    try{
      await row(page,titles[2]).getByRole("button",{name:"Skrýt",exact:true}).click();
      await expect.poll(()=>heldPreview).toBe(1);
      completeConcurrent(3);
      await poll(page);
      await expect(row(page,titles[3])).toHaveCount(0);
      await expect(row(page,titles[2]).getByRole("button",{name:"Skrýt",exact:true})).toBeEnabled();
      expect(unexpectedPatch).toBe(0);
    }finally{page.off("request",countPatch);await page.unroute(previewPattern,holdPreview);}
    // Keep a real acknowledged command outstanding while revoking the
    // current session. The mounted panel must disappear BEFORE a page reload;
    // releasing that old response must not resurrect private rows or Undo.
    let releaseRevoked=()=>{};const revokedBarrier=new Promise<void>(r=>{releaseRevoked=r;});
    let revokedCommitted=false,lateFinished=false;
    const holdRevoked=async(route:Route)=>{
      if(route.request().method()!=="PATCH"){await route.continue();return;}
      const response=await route.fetch();
      revokedCommitted=response.status()===200;
      await revokedBarrier;
      try{await route.fulfill({response});}catch{/* browser cancelled the obsolete request */}
      finally{lateFinished=true;}
    };
    await page.route(pattern,holdRevoked);
    try{
      await row(page,titles[4]).getByRole("button",{name:"Skrýt",exact:true}).click();
      await expect.poll(()=>revokedCommitted).toBe(true);
      await expect(panel(page)).toBeVisible();
      const logout=await page.evaluate(()=>fetch("/api/auth/logout",{method:"POST"}).then(r=>r.status));
      expect(logout).toBe(200);
      const refused=page.waitForResponse(r=>isPath(r.url(),session)&&r.status()===401);
      // Actual runtime verification, not a fabricated auth response.
      await page.evaluate(()=>window.dispatchEvent(new Event("lumi:auth-signed-in")));
      await refused;
      await expect(panel(page)).toHaveCount(0);
      for(const title of titles)await expect(page.getByText(title,{exact:true})).toHaveCount(0);
      releaseRevoked();
      await expect.poll(()=>lateFinished).toBe(true);
      await expect(panel(page)).toHaveCount(0);
      for(const title of titles)await expect(page.getByText(title,{exact:true})).toHaveCount(0);
      await expect(panel(page).getByRole("button",{name:/^Zpět: (skrytí|odložení) úkolu /})).toHaveCount(0);
    }finally{releaseRevoked();await page.unroute(pattern,holdRevoked);}
    await page.reload();
    await expect(page.locator('.authCard input[type="password"]')).toBeVisible();
    await expect(panel(page)).toHaveCount(0);
    for(const title of titles)await expect(page.getByText(title,{exact:true})).toHaveCount(0);
    expect((await page.request.get("/api/target-staging/attention?areaFilter=personal")).status()).toBe(401);
    // Next test's newly issued cookie must be strictly later than revocation.
    setClock(until+2001);
  });

  test("E-1 off profile makes no attention request at "+width,async({page})=>{
    test.skip(mode!=="off","off profile run");
    await page.setViewportSize({width,height:844});
    const requests:string[]=[];
    page.on("request",r=>{if(new URL(r.url()).pathname.startsWith("/api/target-staging/attention"))requests.push(r.url());});
    await page.goto("/?view=Home");
    await expect(page.locator(".appShell")).toBeVisible();
    await expect(panel(page)).toHaveCount(0);
    expect((await page.request.get("/api/target-staging/attention")).status()).toBe(404);
    await page.reload();
    await expect(page.locator(".appShell")).toBeVisible();
    await expect(panel(page)).toHaveCount(0);
    expect(requests).toEqual([]);
  });
}
