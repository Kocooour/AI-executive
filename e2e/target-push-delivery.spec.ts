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
  {directory:string;restoreGeneration:string;ownerUserId:string;seed:{areaId:string}};
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
    const register=page.waitForResponse(r=>new URL(r.url()).pathname==="/api/target-staging/notifications/targets"&&
      r.request().method()==="POST");
    await panel.getByTestId("target-push-enable").click();
    expect((await register).status()).toBe(200);
    await expect(panel.getByTestId("target-push-device-state")).toHaveText("Toto zařízení dostává upozornění.");
    await expect(panel.getByTestId("target-push-notice")).toHaveText("Upozornění jsou na tomto zařízení zapnutá.");
    await expect(panel.getByTestId("target-push-attention")).toBeChecked();
    await expect(panel.getByTestId("target-push-devices")).toContainText("(toto zařízení)");
    // Content-free test notification, decrypted on the fake service.
    await panel.getByTestId("target-push-test").click();
    await expect(panel.getByTestId("target-push-notice")).toHaveText("Testovací oznámení bylo předáno službě oznámení.");
    const testMessages=payloads(endpointOf("ui"+width));
    expect(testMessages).toHaveLength(1);
    expect(testMessages[0]).toEqual({title:"Lumi",body:"Testovací oznámení: upozornění na tomto zařízení fungují.",
      url:"/?view=Settings",tag:"lumi-push-test"});
    // No horizontal scroll at this width.
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
    // A reload re-confirms the device from the server; nothing comes from browser storage.
    await page.reload();
    await expect(page.getByTestId("target-push-settings").getByTestId("target-push-device-state"))
      .toHaveText("Toto zařízení dostává upozornění.",{timeout:20_000});
    await page.getByTestId("target-push-disable").click();
    await expect(page.getByTestId("target-push-device-state")).toHaveText("Toto zařízení zatím upozornění nedostává.");
    await expect(page.getByTestId("target-push-devices")).toHaveCount(0);
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
    await panel.getByTestId("target-push-attention").uncheck();
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
    url:"/?task="+encodeURIComponent(rent),tag:"attention-"+rent});
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
  expect(messages[3].title).toBe("Limit Čtvrtý");
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
  // 6. Sign-out stops delivery to this device: the subscription ends at the push
  //    service, the next pass gets 410 and revokes the device in the store.
  await settingsSections(page).filter({hasText:"Přístup"}).click();
  await page.getByRole("button",{name:"Odhlásit se"}).click();
  await expect(page.locator(".authCard")).toBeVisible({timeout:30_000});
  await expect.poll(()=>statusFor.get(new URL(device).pathname)).toBe(410);
  setClock(pragueAt(14,1));
  const afterLogout=delivered(device).length;
  overdueTask("Po odhlášení");
  await tick();await tick();
  expect(delivered(device)).toHaveLength(afterLogout);
  const live=db();
  try{
    expect((live.prepare("SELECT COUNT(*) AS n FROM personal_push_targets WHERE user_id=? AND revoked_at_ms IS NULL")
      .get(store().ownerUserId) as {n:number}).n).toBe(0);
  }finally{live.close();}
  // Leave a valid owner session for any later scenario of this run.
  await signIn(page);
  await expect(page.locator(".appShell")).toBeVisible();
  await persistOwnerSession(page.context());
});
