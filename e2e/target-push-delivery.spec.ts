/** E-2 acceptance (steps 4–5 of #505): real Next routes, the real scheduler and
 * pass child, the isolated target SQLite and the fixed E-1 server clock, with a
 * LOOPBACK fake push service. Only the browser's PushManager/Notification
 * permission is stubbed (headless Chromium has no push service); every
 * notification the fake service receives is decrypted with the synthetic
 * browser keys to prove exactly what a device would show. */
import {test,expect,persistOwnerSession} from "./fixtures";
import {execFile,spawn} from "node:child_process";
import {settingsSections,signIn} from "./helpers";
import {DatabaseSync} from "node:sqlite";
import {readFileSync,renameSync,realpathSync,writeFileSync} from "node:fs";
import http from "node:http";
import path from "node:path";
import type {Page} from "@playwright/test";
import {decryptWebPush,syntheticBrowserKeys} from "../tests/support/web-push-decrypt.mjs";

test.skip(process.env.LUMI_TARGET_PUSH_E2E!=="true","Dedicated isolated E-2 push browser run only");
test.describe.configure({mode:"serial"});

const zone="Europe/Prague",DAY=86_400_000,HOUR=3_600_000;
const day=(ms:number)=>new Intl.DateTimeFormat("sv-SE",{timeZone:zone,dateStyle:"short"}).format(ms);
const run=()=>realpathSync(process.env.LUMI_E2E_RUN_DIR!);
const store=()=>JSON.parse(process.env.LUMI_E2E_TARGET_STORE!) as
  {directory:string;restoreGeneration:string;ownerUserId:string;seed:{areaId:string;areaTitle:string;revokeProjects:Record<string,{areaId:string;adminId:string}>}};
const browserKeys=syntheticBrowserKeys();

type Received={path:string;status:number;headers:http.IncomingHttpHeaders;body:Buffer};
const received:Received[]=[];
const statusFor=new Map<string,number>();
let hold:{path:string;release:()=>void}|null=null;
let server:http.Server;

test.beforeAll(async()=>{
  const r=run(),s=store();
  if(!path.basename(r).startsWith("lumi-e2e-")||s.ownerUserId!=="e2e-owner"||
    realpathSync(s.directory)!==path.join(r,"target-store"))throw Error("E-2 fixture must be isolated");
  server=http.createServer((req,res)=>{
    const chunks:Buffer[]=[];
    req.on("data",c=>chunks.push(c));
    req.on("end",()=>{
      const status=statusFor.get(req.url||"")??201;
      received.push({path:req.url||"",status,headers:req.headers,body:Buffer.concat(chunks)});
      if(hold&&hold.path===req.url){
        // Keep the connection open until the test has killed the pass.
        const release=()=>{try{res.writeHead(201);res.end();}catch{/* gone */}};
        hold.release=release;return;
      }
      res.writeHead(status);res.end();
    });
  });
  await new Promise<void>(resolve=>server.listen(Number(process.env.LUMI_E2E_PUSH_PORT),"127.0.0.1",resolve));
});
test.afterAll(async()=>{await new Promise(resolve=>server.close(resolve));});

const clockFile=()=>path.join(run(),"attention-clock.json");
const setClock=(ms:number)=>{const tmp=clockFile()+".new";writeFileSync(tmp,JSON.stringify(ms),{mode:0o600});renameSync(tmp,clockFile());};
const clock=()=>Number(JSON.parse(readFileSync(clockFile(),"utf8")));
/** The next Prague day at the given local hour, from the current fixed clock. */
function pragueAt(hour:number,daysAhead=1):number{
  const base=Date.parse(day(clock()+daysAhead*DAY)+"T00:00:00Z");
  for(const offset of [1,2]){
    const candidate=base+(hour-offset)*HOUR;
    const h=Number(new Intl.DateTimeFormat("en-GB",{timeZone:zone,hour:"2-digit",hourCycle:"h23"}).format(candidate));
    if(h===hour)return candidate;
  }
  throw Error("Prague hour not found");
}

function db(){
  const d=new DatabaseSync(path.join(store().directory,"lumi-target.sqlite"));
  d.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000");
  return d;
}
let seq=0;
function overdueTask(title:string):string{
  const id="e2:"+(++seq)+":"+Math.random().toString(36).slice(2,8);
  const d=db();
  try{d.prepare("INSERT INTO tasks(id,area_id,title,due_on,assignee_user_id) VALUES (?,?,?,?,?)")
    .run(id,store().seed.areaId,title,day(clock()-3*DAY),null);}finally{d.close();}
  return id;
}

function tickEnv():NodeJS.ProcessEnv{
  const r=run(),s=store();
  return {PATH:process.env.PATH,HOME:process.env.HOME,AI_EXECUTIVE_E2E:"true",LUMI_E2E_RUN_DIR:r,
    AI_EXECUTIVE_DATA_DIR:path.join(r,"data"),LUMI_E2E_ATTENTION_CLOCK:clockFile(),
    NODE_OPTIONS:"--require="+JSON.stringify(path.join(process.cwd(),"e2e/attention-test-clock.cjs")),
    AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED:"true",AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED:"true",
    AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTIFICATIONS_ENABLED:"true",
    AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTIFICATIONS_WRITE_ENABLED:"true",
    AI_EXECUTIVE_TARGET_STAGING_DIRECTORY:s.directory,
    AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION:s.restoreGeneration,
    AI_EXECUTIVE_TARGET_VAPID_PUBLIC_KEY:process.env.LUMI_E2E_PUSH_VAPID_PUBLIC,
    AI_EXECUTIVE_TARGET_VAPID_PRIVATE_KEY:process.env.LUMI_E2E_PUSH_VAPID_PRIVATE,
    VAPID_SUBJECT:"mailto:e2e@example.test",
    LUMI_E2E_TARGET_PUSH_TEST_ORIGIN:"http://127.0.0.1:"+process.env.LUMI_E2E_PUSH_PORT};
}
const tickArgs=["--experimental-loader",path.join(process.cwd(),"scripts/target-staging-ts-loader.mjs"),
  path.join(process.cwd(),"e2e/target-push-tick.mjs")];
/** One real scheduler tick; retried while the server's own tick holds the lock. */
async function tick():Promise<{state:string;sent?:number}>{
  for(let attempt=0;attempt<20;attempt++){
    const out=await new Promise<string>((resolve,reject)=>execFile(process.execPath,tickArgs,
      {cwd:process.cwd(),env:tickEnv(),timeout:120_000},(error,stdout)=>error?reject(error):resolve(stdout)));
    const result=JSON.parse(out) as {state:string;sent?:number};
    if(result.state!=="locked"&&result.state!=="busy")return result;
    await new Promise(r=>setTimeout(r,500));
  }
  throw Error("scheduler lock never released");
}

const endpointBase=()=>"http://127.0.0.1:"+process.env.LUMI_E2E_PUSH_PORT+"/lumi-e2e-push/device";
const delivered=(endpoint:string)=>received.filter(r=>r.path===new URL(endpoint).pathname&&r.status>=200&&r.status<300);
const payloads=(endpoint:string)=>delivered(endpoint).map(r=>JSON.parse(decryptWebPush(r.body,browserKeys)) as
  {title:string;body:string;url:string;tag:string});

/** Stand-in for the browser push service and permission prompt only. */
async function stubPush(page:Page,label:string){
  await page.exposeFunction("__lumiPushUnsubscribed",(endpoint:string)=>{statusFor.set(new URL(endpoint).pathname,410);});
  await page.addInitScript(({base,keys})=>{
    const saved=JSON.parse(sessionStorage.getItem("__lumiPushStub")||"{}") as
      {permission?:string;endpoint?:string|null;key?:number[];n?:number};
    const save=()=>sessionStorage.setItem("__lumiPushStub",JSON.stringify(saved));
    Object.defineProperty(Notification,"permission",{configurable:true,get:()=>saved.permission||"default"});
    Notification.requestPermission=async()=>{saved.permission="granted";save();return "granted";};
    const make=(endpoint:string,key:number[])=>({endpoint,expirationTime:null,
      options:{applicationServerKey:new Uint8Array(key).buffer,userVisibleOnly:true},
      toJSON:()=>({endpoint,expirationTime:null,keys}),
      getKey:()=>null,
      unsubscribe:async()=>{
        // A browser/push service may reject unsubscribe while the endpoint stays live.
        if(sessionStorage.getItem("__lumiRejectUnsubscribe")==="1")throw Error("synthetic unsubscribe failure");
        if(saved.endpoint===endpoint){saved.endpoint=null;save();
          await (window as unknown as {__lumiPushUnsubscribed:(e:string)=>Promise<void>}).__lumiPushUnsubscribed(endpoint);}
        return true;
      }});
    PushManager.prototype.getSubscription=async function(){
      return saved.endpoint&&saved.key?make(saved.endpoint,saved.key) as unknown as PushSubscription:null;
    };
    PushManager.prototype.subscribe=async function(options?:PushSubscriptionOptionsInit){
      const raw=options?.applicationServerKey;
      const bytes=raw instanceof ArrayBuffer?new Uint8Array(raw):new Uint8Array(raw as Uint8Array);
      saved.n=(saved.n||0)+1;saved.endpoint=base+"-"+saved.n;saved.key=[...bytes];save();
      return make(saved.endpoint,saved.key) as unknown as PushSubscription;
    };
  },{base:endpointBase()+"-"+label,keys:browserKeys.keys});
}
const endpointOf=(label:string,n=1)=>endpointBase()+"-"+label+"-"+n;

async function openNotifications(page:Page){
  await page.goto("/?view=Settings");
  await page.getByRole("navigation",{name:"Sekce nastavení"}).getByRole("button",{name:"Oznámení"}).click();
  const panel=page.getByTestId("target-push-settings");
  await expect(panel.getByRole("heading",{name:"Upozornění na úkoly"})).toBeVisible({timeout:20_000});
  return panel;
}

for(const width of [390,1280]){
  test("task alerts: enable this device, test message, device list and turn off at "+width+"px",async({page})=>{
    test.setTimeout(120_000);
    await page.setViewportSize({width,height:844});
    await stubPush(page,"ui"+width);
    const panel=await openNotifications(page);
    await expect(panel.getByTestId("target-push-device-state")).toHaveText("Toto zařízení zatím upozornění nedostává.");
    // The legacy attention switch is hidden while target alerts own them.
    await expect(page.getByText("Upozornit na urgentní termíny",{exact:true})).toHaveCount(0);
    await expect(panel.getByTestId("target-push-zone")).toHaveValue(width===390?"UTC":zone);
    // Interrupt the settings write after successful device registration.
    // Reload must show the partial state and offer an idempotent retry.
    const settingsPath="**/api/target-staging/notifications/settings";
    if(width===390)await page.route(settingsPath,async route=>{
      if(route.request().method()==="PATCH")await route.fulfill({status:503,contentType:"application/json",body:'{"error":"unavailable"}'});
      else await route.continue();
    });
    const register=page.waitForResponse(r=>new URL(r.url()).pathname==="/api/target-staging/notifications/targets"&&
      r.request().method()==="POST");
    await panel.getByTestId("target-push-enable").click();
    expect((await register).status()).toBe(200);
    if(width===390){
      await expect(panel.getByTestId("target-push-notice")).toHaveText("Akci se nepodařilo dokončit.");
      await expect(panel.getByTestId("target-push-device-state")).toHaveText("Zařízení je přihlášené, upozornění na úkoly jsou vypnutá.");
      await page.unroute(settingsPath);
      await openNotifications(page);
      await expect(panel.getByTestId("target-push-enable")).toHaveText("Zapnout upozornění");
      await expect(panel.getByTestId("target-push-attention")).not.toBeChecked();
      await expect(panel.getByTestId("target-push-zone")).toHaveValue("UTC");
      const retry=page.waitForResponse(r=>new URL(r.url()).pathname==="/api/target-staging/notifications/targets"&&r.request().method()==="POST");
      await panel.getByTestId("target-push-enable").click();
      expect(await (await retry).json()).toMatchObject({ok:true,unchanged:true});
      await expect(panel.getByTestId("target-push-devices").locator("li")).toHaveCount(1);
    }
    await expect(panel.getByTestId("target-push-device-state")).toHaveText("Toto zařízení dostává upozornění.");
    await expect(panel.getByTestId("target-push-notice")).toHaveText(width===390
      ?"Upozornění jsou na tomto zařízení zapnutá. Časové pásmo bylo nastaveno podle tohoto zařízení (Europe/Prague)."
      :"Upozornění jsou na tomto zařízení zapnutá.");
    await expect(panel.getByTestId("target-push-zone")).toHaveValue(zone);
    await expect(panel.getByTestId("target-push-attention")).toBeChecked();
    await expect(panel.getByTestId("target-push-devices")).toContainText("(toto zařízení)");
    // Content-free test notification, decrypted on the fake service.
    await panel.getByTestId("target-push-test").click();
    await expect(panel.getByTestId("target-push-notice")).toHaveText("Testovací oznámení bylo předáno službě oznámení.");
    const testMessages=payloads(endpointOf("ui"+width));
    expect(testMessages).toHaveLength(1);
    expect(testMessages[0]).toEqual({title:"Lumi",body:"Testovací oznámení: upozornění na tomto zařízení fungují.",
      url:"/?view=Settings",tag:"lumi-push-test"});
    // A deliberate later choice of UTC must survive another device enable.
    if(width===390){
      await panel.getByTestId("target-push-zone").fill("UTC");
      await panel.getByRole("button",{name:"Uložit",exact:true}).click();
      await expect(panel.getByTestId("target-push-notice")).toHaveText("Uloženo.");
    }
    // The push service forgets the device: the test result says so, the device
    // is removed server-side, and the panel truthfully offers to turn it on again.
    statusFor.set(new URL(endpointOf("ui"+width)).pathname,410);
    await panel.getByTestId("target-push-test").click();
    await expect(panel.getByTestId("target-push-notice")).toHaveText(
      "Služba oznámení zařízení už nezná, proto bylo odebráno. Zapněte upozornění znovu.");
    await expect(panel.getByTestId("target-push-notice")).toBeFocused();
    await expect(panel.getByTestId("target-push-device-state")).toHaveText("Toto zařízení zatím upozornění nedostává.");
    await panel.getByTestId("target-push-enable").click();
    await expect(panel.getByTestId("target-push-device-state")).toHaveText("Toto zařízení dostává upozornění.");
    await expect(panel.getByTestId("target-push-notice")).toHaveText("Upozornění jsou na tomto zařízení zapnutá.");
    await expect(panel.getByTestId("target-push-zone")).toHaveValue(width===390?"UTC":zone);
    if(width===390){
      await panel.getByTestId("target-push-zone").fill(zone);
      await panel.getByRole("button",{name:"Uložit",exact:true}).click();
      await expect(panel.getByTestId("target-push-notice")).toHaveText("Uloženo.");
    }
    // No horizontal scroll at this width.
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
    // A reload re-confirms the device from the server; nothing comes from browser storage.
    const reloaded=await openNotifications(page);
    await expect(reloaded.getByTestId("target-push-device-state"))
      .toHaveText("Toto zařízení dostává upozornění.",{timeout:20_000});
    await reloaded.getByTestId("target-push-disable").click();
    await expect(reloaded.getByTestId("target-push-device-state")).toHaveText("Toto zařízení zatím upozornění nedostává.");
    await expect(reloaded.getByTestId("target-push-notice"))
      .toHaveText("Na tomto zařízení se upozornění už nebudou zobrazovat.");
    await expect(reloaded.getByText("(toto zařízení)")).toHaveCount(0);
  });
}

// F-1: all personal planning and deadline mutations of the new task use the
// actual application UI, never direct SQL. Only unrelated fixture rows are reset.
for(const width of [390,1280]){
  test("F-1: Quick Capture, arbitrary When, deadline, Home and push at "+width+"px",async({page})=>{
    test.setTimeout(300_000);
    const now=pragueAt(10);
    setClock(now);
    await page.clock.setFixedTime(new Date(now));
    await page.setViewportSize({width,height:844});
    const viewer=store().seed.revokeProjects[String(width)];
    const viewerId="f1:viewer:"+width,viewerTitle="F-1 viewer "+width;
    const d=db();
    try{
      d.prepare("UPDATE personal_notification_settings SET time_zone=? WHERE user_id=?").run(zone,store().ownerUserId);
      d.prepare("UPDATE tasks SET status='completed',completed_at_ms=? WHERE status='open'").run(now);
      d.prepare("UPDATE area_members SET role='viewer' WHERE area_id=? AND user_id=?").run(viewer.areaId,store().ownerUserId);
      d.prepare("INSERT INTO tasks(id,area_id,title,due_on,assignee_user_id) VALUES (?,?,?,?,?)")
        .run(viewerId,viewer.areaId,viewerTitle,null,null);
    }finally{d.close();}
    const label="f1"+width,device=endpointOf(label);
    await stubPush(page,label);
    const settings=await openNotifications(page);
    if(await settings.getByTestId("target-push-attention").isChecked()){
      await settings.getByTestId("target-push-attention").click();
      await expect(settings.getByTestId("target-push-notice")).toHaveText("Uloženo.");
      await expect(settings.getByTestId("target-push-attention")).not.toBeChecked();
    }
    await settings.getByTestId("target-push-enable").click();
    await expect(settings.getByTestId("target-push-attention")).toBeChecked();
    await expect(settings.getByTestId("target-push-device-state")).toHaveText("Toto zařízení dostává upozornění.");
    await tick();
    expect(payloads(device)).toHaveLength(0);

    const title="F-1 termín "+width, future=day(now+5*DAY), deadline=day(now+DAY);
    await page.goto("/?view=MyPlanPreview&scope=personal");
    const plan=page.getByTestId("target-my-plan"),detail=page.getByTestId("target-detail");
    await expect(plan).toBeVisible();
    await page.locator('[data-target-private-capture-fab="'+(width===390?"mobile":"desktop")+'"]').click();
    await page.getByTestId("target-capture-task-kind").click();
    await page.getByTestId("target-private-task-area").selectOption({label:store().seed.areaTitle});
    await page.getByTestId("target-private-task-form").getByRole("textbox",{name:"Název úkolu"}).fill(title);
    const created=page.waitForResponse(r=>new URL(r.url()).pathname==="/api/target-staging/tasks"&&r.request().method()==="POST");
    await page.getByTestId("target-private-task-save").click();
    const response=await created;
    expect(response.status()).toBe(201);
    const id=response.request().postDataJSON().taskId as string;
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    await page.getByTestId("target-private-task-open").click();
    await expect(detail).toContainText(title);
    const whenInput=detail.getByTestId("target-detail-edit-when-date");
    await whenInput.fill(future);
    await whenInput.locator("..").getByRole("button",{name:"Uložit",exact:true}).click();
    await expect(detail.getByTestId("target-detail-edit-status")).toContainText("Termín „Kdy“ je uložen.");
    await page.goto("/?view=MyPlanPreview&scope=personal");
    const row=page.locator('[data-detail-row="task:'+id+'"]');
    await expect(plan).toBeVisible();
    const dateInput=plan.getByLabel("Den",{exact:true});
    await dateInput.fill(day(now+3*DAY));
    await expect(plan.getByRole("region",{name:"Do vybraného dne včetně"})).toBeVisible();
    await expect(row).toHaveCount(0);
    await dateInput.fill(future);
    await expect(plan.getByRole("region",{name:"Do vybraného dne včetně"}).locator('[data-detail-row="task:'+id+'"]')).toBeVisible();
    await row.click();
    await expect(detail).toContainText(title);
    const duePath="/api/target-staging/task-temporal/due-on";
    const dueInput=detail.getByTestId("target-detail-edit-due-date");
    const saveDue=async(date:string)=>{
      await dueInput.fill(date);
      const pending=page.waitForResponse(r=>new URL(r.url()).pathname===duePath&&r.request().method()==="PATCH");
      await dueInput.locator("..").getByRole("button",{name:"Uložit",exact:true}).click();
      const reply=await pending;
      expect(reply.status()).toBe(200);
      expect(reply.request().postDataJSON().dueOn).toBe(date);
      await expect(detail.getByTestId("target-detail-edit-status")).toContainText("Termín");
      await expect(dueInput).toHaveValue(date);
      return reply.request().postDataJSON() as Record<string,unknown>;
    };
    await saveDue(day(now+6*DAY));
    const command=await saveDue(deadline);
    await page.goto("/?view=Home&scope=personal");
    const homeRow=page.locator("[data-rule]").filter({hasText:title});
    await expect(homeRow).toHaveAttribute("data-rule","deadline_soon",{timeout:30_000});
    await tick();await tick();
    const messages=()=>payloads(device).filter(p=>p.tag==="attention-"+id);
    expect(messages()).toHaveLength(1);
    expect(messages()[0].title).toBe(title);
    await page.goto(messages()[0].url);
    await expect(detail).toContainText(title,{timeout:25_000});

    const past=pragueAt(10,2);
    setClock(past);
    await page.clock.setFixedTime(new Date(past));
    await page.goto("/?view=Home&scope=personal");
    await expect(homeRow).toHaveAttribute("data-rule","deadline_overdue",{timeout:30_000});
    await tick();await tick();
    expect(messages()).toHaveLength(2);
    expect(messages()[1].body).toMatch(/uplynul/);
    await page.goto(messages()[1].url);
    await expect(detail).toContainText(title,{timeout:25_000});
    const removal=page.waitForResponse(r=>new URL(r.url()).pathname===duePath&&r.request().method()==="PATCH");
    await dueInput.locator("..").getByRole("button",{name:"Odebrat termín"}).click();
    const removed=await removal;
    expect(removed.status()).toBe(200);
    expect(removed.request().postDataJSON().dueOn).toBeNull();
    await expect(dueInput).toHaveValue("");
    await page.goto("/?view=Home&scope=personal");
    await expect(homeRow).toHaveCount(0);
    await tick();await tick();
    expect(messages()).toHaveLength(2);
    expect(payloads(device)).toHaveLength(2);

    // Viewer can read the shared task but cannot write a deadline, even
    // when bypassing the UI with a forged command from a genuine owner write.
    await page.goto("/?view=MyPlanPreview&taskId="+encodeURIComponent(viewerId));
    await expect(detail).toContainText(viewerTitle,{timeout:25_000});
    await expect(detail.getByTestId("target-detail-edit-readonly")).toBeVisible();
    await expect(dueInput).toHaveCount(0);
    const denied=await page.request.get(duePath+"?taskId="+encodeURIComponent(viewerId));
    expect(denied.status()).toBe(404);
    const forged=await page.request.patch(duePath,{headers:{
      origin:new URL(page.url()).origin,"x-lumi-target-protocol":"1"
    },data:{...command,taskId:viewerId,writeAreaId:viewer.areaId,commandId:crypto.randomUUID()}});
    expect(forged.status()).toBe(404);
    const again=await openNotifications(page);
    await again.getByTestId("target-push-disable").click();
    await expect(again.getByTestId("target-push-device-state")).toHaveText("Toto zařízení zatím upozornění nedostává.");
  });
}

test("delivery: baseline, exactly one private message, daily limit, quiet hours, restart, 410 and sign-out",async({page})=>{
  test.setTimeout(420_000);
  await page.setViewportSize({width:1280,height:844});
  // 10:00 in Prague, outside the default quiet hours 22:00–08:00.
  setClock(pragueAt(10));
  const d=db();
  try{
    d.prepare("UPDATE personal_notification_settings SET time_zone=? WHERE user_id=?").run(zone,store().ownerUserId);
    // Earlier E-1/E-2 rows must not count as new items.
    d.prepare("UPDATE tasks SET status='completed',completed_at_ms=? WHERE status='open'").run(clock());
  }finally{d.close();}
  await stubPush(page,"main");
  const panel=await openNotifications(page);
  // Turning alerts off forgets the baseline, so this run starts from a fresh one.
  if(await panel.getByTestId("target-push-attention").isChecked()){
    await panel.getByTestId("target-push-attention").click();
    await expect(panel.getByTestId("target-push-notice")).toHaveText("Uloženo.");
    await expect(panel.getByTestId("target-push-attention")).not.toBeChecked();
  }
  await panel.getByTestId("target-push-enable").click();
  await expect(panel.getByTestId("target-push-attention")).toBeChecked();
  await expect(panel.getByTestId("target-push-device-state")).toHaveText("Toto zařízení dostává upozornění.");
  const device=endpointOf("main");
  overdueTask("Starý dluh");
  // 1. The first enabled pass only records what already exists.
  await tick();
  expect(delivered(device)).toHaveLength(0);
  // 2. A new overdue task: exactly one message, nothing private beyond the title.
  const rent=overdueTask("Zaplatit nájem");
  await tick();await tick();
  let messages=payloads(device);
  expect(messages).toHaveLength(1);
  expect(messages[0]).toEqual({title:"Zaplatit nájem",body:expect.stringMatching(/^Termín \d+\. \d+\. uplynul\.$/),
    url:"/?view=MyPlanPreview&taskId="+encodeURIComponent(rent),tag:"attention-"+rent});
  // Follow the URL from the actual decrypted push.
  await page.goto(messages[0].url);
  await expect(page.getByTestId("target-detail")).toContainText("Zaplatit nájem",{timeout:25_000});
  await openNotifications(page);
  expect(JSON.stringify(messages)).not.toContain("Starý dluh");
  // 3. At most three routine messages per rolling 24 h: the fourth waits.
  for(const title of ["Druhý","Třetí","Čtvrtý"])overdueTask("Limit "+title);
  await tick();
  expect(payloads(device)).toHaveLength(3);
  // 4. Quiet hours: at 23:00 the next day nothing is sent; at 08:00 it is.
  setClock(pragueAt(23));
  await tick();
  expect(payloads(device)).toHaveLength(3);
  setClock(pragueAt(8,1));
  await tick();
  messages=payloads(device);
  expect(messages).toHaveLength(4);
  // Which item waited is the planner's ranking; every item arrives exactly once.
  expect(messages.map(m=>m.title).sort()).toEqual(["Limit Druhý","Limit Třetí","Limit Čtvrtý","Zaplatit nájem"].sort());
  // 5. A pass killed while its send is in flight never sends that item again.
  setClock(pragueAt(12,1));
  const crash=overdueTask("Přerušené odeslání");
  hold={path:new URL(device).pathname,release:()=>{}};
  const before=received.filter(r=>r.path===hold!.path).length;
  // Its own process group, so the harness AND its pass child die together, like a restart.
  const child=spawn(process.execPath,tickArgs,{cwd:process.cwd(),env:tickEnv(),detached:true,stdio:"ignore"});
  await expect.poll(()=>received.filter(r=>r.path===hold!.path).length,{timeout:60_000}).toBe(before+1);
  process.kill(-child.pid!,"SIGKILL");
  await new Promise(r=>setTimeout(r,500));
  hold.release();hold=null;
  for(let i=0;i<3;i++)await tick();
  const crashed=received.filter(r=>{
    if(r.path!==new URL(device).pathname)return false;
    try{return (JSON.parse(decryptWebPush(r.body,browserKeys)) as {tag:string}).tag==="attention-"+crash;}catch{return false;}
  });
  expect(crashed).toHaveLength(1);
  // 6. Turning alerts off sends nothing; turning them on again starts from a
  //    fresh baseline instead of announcing what happened meanwhile.
  setClock(pragueAt(13,1));
  await panel.getByTestId("target-push-attention").click();
  await expect(panel.getByTestId("target-push-attention")).not.toBeChecked();
  const whileOff=delivered(device).length;
  overdueTask("Při vypnutých upozorněních");
  await tick();await tick();
  expect(delivered(device)).toHaveLength(whileOff);
  await panel.getByTestId("target-push-attention").click();
  await expect(panel.getByTestId("target-push-attention")).toBeChecked();
  await tick();await tick();
  expect(delivered(device)).toHaveLength(whileOff);
  // 7. Another registered device must survive logout of this one.
  const second=await page.context().newPage();
  await stubPush(second,"second");
  const secondPanel=await openNotifications(second);
  await secondPanel.getByTestId("target-push-enable").click();
  await expect(secondPanel.getByTestId("target-push-notice")).toHaveText("Upozornění jsou na tomto zařízení zapnutá.");
  await expect(secondPanel.getByTestId("target-push-devices").locator("li")).toHaveCount(2);
  const otherDevice=endpointOf("second");
  await second.close();
  const liveTargets=()=>{
    const live=db();
    try{return (live.prepare("SELECT COUNT(*) AS n FROM personal_push_targets WHERE user_id=? AND revoked_at_ms IS NULL")
      .get(store().ownerUserId) as {n:number}).n;}finally{live.close();}
  };
  let logoutRequests=0;
  page.on("request",r=>{if(new URL(r.url()).pathname==="/api/auth/logout")logoutRequests++;});
  // A) The server cannot confirm revocation: sign-out still completes (owner
  //    decision 2026-11-27) with a one-shot notice. The browser subscription is
  //    ended, so the next pass gets 410 and revokes this device; the other stays.
  const targetsPath="**/api/target-staging/notifications/targets";
  let refused=0;
  await page.route(targetsPath,async route=>{
    if(route.request().method()==="POST"&&route.request().postDataJSON()?.action==="revoke"){
      refused++;
      await route.fulfill({status:503,contentType:"application/json",body:'{"error":"unavailable"}'});
    }else await route.continue();
  });
  await settingsSections(page).filter({hasText:"Přístup"}).click();
  await page.getByRole("button",{name:"Odhlásit se"}).click();
  await expect(page.locator(".authCard")).toBeVisible({timeout:30_000});
  await expect(page.locator(".authCard .authNotice")).toHaveText(
    "Jste odhlášeni. Nepodařilo se ověřit, že toto zařízení bylo odebráno z upozornění na úkoly. Pokud je v seznamu dál, odeberte ho v Nastavení → Oznámení na jiném zařízení.");
  expect(refused).toBeGreaterThan(0);
  expect(logoutRequests).toBe(1);
  await page.unroute(targetsPath);
  expect(statusFor.get(new URL(device).pathname)).toBe(410);
  expect(liveTargets()).toBe(2);
  setClock(pragueAt(14,2));
  let afterLogout=delivered(device).length;
  let beforeOther=delivered(otherDevice).length;
  let newTask=overdueTask("Po odhlášení bez potvrzení");
  await tick();await tick();
  expect(delivered(device)).toHaveLength(afterLogout);
  expect(payloads(otherDevice).slice(beforeOther).map(p=>p.tag)).toContain("attention-"+newTask);
  expect(liveTargets()).toBe(1);
  // B) Sign in again, turn this device on again, and sign out with a confirmed
  //    server revocation even though the browser refuses to unsubscribe.
  await signIn(page);
  await expect(page.locator(".appShell")).toBeVisible();
  const again=await openNotifications(page);
  await again.getByTestId("target-push-enable").click();
  await expect(again.getByTestId("target-push-device-state")).toHaveText("Toto zařízení dostává upozornění.");
  const reenabled=endpointOf("main",2);
  expect(liveTargets()).toBe(2);
  await page.evaluate(()=>sessionStorage.setItem("__lumiRejectUnsubscribe","1"));
  await settingsSections(page).filter({hasText:"Přístup"}).click();
  await page.getByRole("button",{name:"Odhlásit se"}).click();
  await expect(page.locator(".authCard")).toBeVisible({timeout:30_000});
  await expect(page.locator(".authCard .authNotice")).toHaveCount(0);
  expect(logoutRequests).toBe(2);
  expect(statusFor.get(new URL(reenabled).pathname)).not.toBe(410);
  expect(liveTargets()).toBe(1);
  setClock(pragueAt(16,2));
  afterLogout=delivered(reenabled).length;
  beforeOther=delivered(otherDevice).length;
  newTask=overdueTask("Po odhlášení");
  await tick();await tick();
  expect(delivered(reenabled)).toHaveLength(afterLogout);
  expect(payloads(otherDevice).slice(beforeOther).map(p=>p.tag)).toContain("attention-"+newTask);
  // Leave a valid owner session for any later scenario of this run.
  await signIn(page);
  await expect(page.locator(".appShell")).toBeVisible();
  await persistOwnerSession(page.context());
});
