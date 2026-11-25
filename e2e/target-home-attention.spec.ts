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
  return {now,setClock,titles};
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
    const {now,setClock,titles}=fixture(width);
    await page.setViewportSize({width,height:844});
    await page.clock.install({time:new Date(now)});
    await page.goto("/?view=Home&scope=personal");
    await expect(panel(page)).toBeVisible({timeout:30_000});
    await expect(items(page)).toHaveCount(5);
    await expect(items(page).locator("strong")).toHaveText(titles.slice(0,5));
    await expect(panel(page)).not.toContainText(/E1 (completed|foreign|shared)/);
    await row(page,titles[0]).locator("summary").click();
    await expect(row(page,titles[0])).toContainText("Zdroj: termín úkolu");
    await expect(row(page,titles[0])).toContainText(zone);
    await panel(page).getByRole("button",{name:"Další upozornění"}).click();
    await expect(items(page)).toHaveCount(6);
    await expect(items(page).locator("strong")).toHaveText(titles);
    await expect(row(page,titles[4])).toHaveAttribute("data-rule","deadline_soon");
    await expect(row(page,titles[5])).toHaveAttribute("data-rule","planned_date_passed");
    await row(page,titles[5]).locator("summary").click();
    await expect(row(page,titles[5])).toContainText("Zdroj: osobní plán");
    await panel(page).getByRole("button",{name:"Méně upozornění"}).click();
    await expect(items(page)).toHaveCount(5);
    // Hold the acknowledged real commit while the routine session poll
    // reloads the parent. A remount would abort and lose the exact command.
    let release=()=>{};const barrier=new Promise<void>(r=>{release=r;});
    let committed=false,patches=0;
    const pattern="**/api/target-staging/attention/command";
    const hold=async(route:Route)=>{
      if(route.request().method()!=="PATCH"){await route.continue();return;}
      patches++;
      const response=await route.fetch();
      committed=response.status()===200;
      await barrier;await route.fulfill({response});
    };
    await page.route(pattern,hold);
    try{
      await row(page,titles[0]).getByRole("button",{name:"Skrýt",exact:true}).click();
      await expect.poll(()=>committed).toBe(true);
      await poll(page);
      release();
      await expect(row(page,titles[0])).toHaveCount(0);
      await expect(panel(page).getByRole("button",{name:"Zpět",exact:true})).toBeVisible();
      expect(patches).toBe(1);
    }finally{release();await page.unroute(pattern,hold);}
    // A further successful poll after acknowledgement cannot erase Undo.
    await poll(page);
    await expect(panel(page).getByRole("button",{name:"Zpět",exact:true})).toBeVisible();
    await panel(page).getByRole("button",{name:"Zpět",exact:true}).click();
    await expect(row(page,titles[0])).toBeVisible();
    // Real snooze through the UI; shift the isolated server clock, then
    // re-read without altering the actual stored snooze row.
    const until=Math.ceil((now+10*60_000)/60_000)*60_000;
    await row(page,titles[0]).getByRole("button",{name:"Odložit",exact:true}).click();
    await row(page,titles[0]).locator('input[type="datetime-local"]').fill(localInput(until));
    await row(page,titles[0]).getByRole("button",{name:"Potvrdit",exact:true}).click();
    await expect(row(page,titles[0])).toHaveCount(0);
    await expect(panel(page).getByText("Upozornění bylo upraveno.")).toBeVisible();
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
    await detail.getByTestId("target-detail-edit-status-toggle").click();
    await expect(detail.getByTestId("target-detail-edit-status")).toContainText("Stav úkolu je uložen.");
    await detail.getByRole("button",{name:"Zavřít"}).click();
    await expect(row(page,titles[1])).toHaveCount(0);
    await expect(row(page,titles[4])).toBeVisible();
    // Actual logout endpoint revokes the cookie before page revalidation.
    const logout=await page.evaluate(()=>fetch("/api/auth/logout",{method:"POST"}).then(r=>r.status));
    expect(logout).toBe(200);
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
    expect(requests).toEqual([]);
    expect((await page.request.get("/api/target-staging/attention")).status()).toBe(404);
  });
}
