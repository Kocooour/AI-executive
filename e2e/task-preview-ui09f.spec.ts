import {expect,test} from './fixtures';
import type {Route} from '@playwright/test';
test.skip(process.env.LUMI_TASK_PREVIEW_E2E!=='true','requires isolated task preview');
const endpoint='**/api/target-staging/task-temporal/detail?taskId=task-1';
const dto={task:{id:'task-1',title:'Ověřený úkol',projectId:null,areaId:'secret-area',areaKind:'shared',status:'open',completedAtMs:null,dueOn:'2026-11-08',assignedToMe:true}};
const fulfill=(route:Route,payload:unknown,status=200)=>route.fulfill({status,headers:{'content-type':'application/json','cache-control':'no-store'},body:JSON.stringify(payload)});
test('explicit read displays authorized task without exposing Area ID',async({page})=>{
  let calls=0;await page.route(endpoint,route=>{calls++;return fulfill(route,dto);});
  await page.goto('/target-staging/tasks/task-1/preview');
  await expect(page.locator('.stagingTaskContent')).toHaveCount(0);expect(calls).toBe(0);
  await page.getByRole('button',{name:'Načíst úkol'}).click();
  await expect(page.locator('.stagingTaskContent')).toContainText('Ověřený úkol');
  await expect(page.locator('.stagingTaskContent')).toContainText('Přiřazeno mně');
  await expect(page.locator('.stagingTaskContent')).not.toContainText('secret-area');
  await expect(page.locator('.stagingTaskStatus')).toBeFocused();expect(calls).toBe(1);
});
for(const code of [401,404,409,429,503])test(`failure ${code} hides task`,async({page})=>{
  await page.route(endpoint,route=>fulfill(route,{error:'secret'},code));
  await page.goto('/target-staging/tasks/task-1/preview');await page.getByRole('button',{name:'Načíst úkol'}).click();
  await expect(page.locator('.stagingTaskContent')).toHaveCount(0);
  await expect(page.locator('.stagingTaskError')).toBeVisible();await expect(page.locator('.stagingTaskError')).not.toContainText('secret');
});
for(const event of ['blur','offline','pagehide'])test(`${event} aborts and ignores a fetch that resolves late`,async({page})=>{
  await page.addInitScript(()=>{
    const original=window.fetch;
    window.fetch=(input,init)=>{
      if(String(input).includes('/api/target-staging/task-temporal/detail?'))return new Promise(resolve=>{
        (window as unknown as {resolveTask:(response:Response)=>void; taskSignal?:AbortSignal|null}).resolveTask=resolve;
        (window as unknown as {taskSignal?:AbortSignal|null}).taskSignal=init?.signal;
      });
      return original(input,init);
    };
  });
  await page.goto('/target-staging/tasks/task-1/preview');await page.getByRole('button',{name:'Načíst úkol'}).click();
  await expect.poll(()=>page.evaluate(()=>typeof (window as unknown as {resolveTask?:unknown}).resolveTask)).toBe('function');
  await page.evaluate(kind=>window.dispatchEvent(new Event(kind)),event);
  expect(await page.evaluate(()=>(window as unknown as {taskSignal:AbortSignal}).taskSignal.aborted)).toBe(true);
  await page.evaluate(payload=>(window as unknown as {resolveTask:(response:Response)=>void}).resolveTask(new Response(JSON.stringify(payload),{status:200,headers:{'content-type':'application/json','cache-control':'no-store'}})),dto);
  await page.evaluate(()=>new Promise(resolve=>setTimeout(resolve,100)));
  await expect(page.locator('.stagingTaskError')).toBeVisible();
  await expect(page.locator('.stagingTaskContent')).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Načíst úkol'})).toBeEnabled();
});

for(const event of ['focus','hidden','pageshow','blur','offline','pagehide'])test(`visible content is removed on ${event} and requires an explicit new read`,async({page})=>{
  let calls=0;
  await page.route(endpoint,route=>{calls++;return fulfill(route,dto);});
  await page.goto('/target-staging/tasks/task-1/preview');
  const button=page.getByRole('button',{name:'Načíst úkol'});
  await button.click();
  await expect(page.locator('.stagingTaskContent')).toBeVisible();
  expect(calls).toBe(1);
  await page.evaluate(kind=>{
    if(kind==='hidden'){
      const previous=Object.getOwnPropertyDescriptor(document,'visibilityState');
      Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});
      document.dispatchEvent(new Event('visibilitychange'));
      if(previous)Object.defineProperty(document,'visibilityState',previous);
      else Reflect.deleteProperty(document,'visibilityState');
    }else if(kind==='pageshow')window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}));
    else window.dispatchEvent(new Event(kind));
  },event);
  await expect(page.locator('.stagingTaskContent')).toHaveCount(0);
  await expect(page.locator('.stagingTaskError')).toBeVisible();
  await page.waitForTimeout(200);
  expect(calls).toBe(1);
  await button.click();
  await expect(page.locator('.stagingTaskContent')).toBeVisible();
  expect(calls).toBe(2);
});

// UI-09f: real mounted index-to-task navigation; both HTTP payloads are synthetic.
const indexEndpoint='**/api/target-staging/global-index?*';
const indexTaskPage={
  scope:'all',
  items:[
    {kind:'task',item:{id:'task-1',title:'Ověřený úkol',projectId:null,
      areaId:'secret-area',areaKind:'shared',status:'open',dueOn:null,assignedToMe:true}},
    {kind:'task',item:{id:'task/unsafe',title:'Úkol bez bezpečného odkazu',
      projectId:null,areaId:'private-area',areaKind:'private',status:'open',dueOn:null}},
  ],
  hasMore:false,nextCursor:null,
};
const indexUrl='/target-staging/global-index/preview';

test('index task link opens the detail without prefetch or implicit authorization',async({page})=>{
  let indexGets=0,detailGets=0;
  await page.route(indexEndpoint,route=>{indexGets++;return fulfill(route,indexTaskPage);});
  await page.route(endpoint,route=>{detailGets++;return fulfill(route,dto);});
  await page.goto(indexUrl);
  const link=page.getByRole('link',{name:'Otevřít úkol: Ověřený úkol'});
  await expect(link).toHaveAttribute('href','/target-staging/tasks/task-1/preview');
  await expect(page.getByText('Úkol bez bezpečného odkazu')).toBeVisible();
  await expect(page.getByRole('link',{name:/Úkol bez bezpečného odkazu/})).toHaveCount(0);
  expect(indexGets).toBe(1);expect(detailGets).toBe(0);
  await link.click();
  await expect(page).toHaveURL(/\/target-staging\/tasks\/task-1\/preview$/);
  await expect(page.getByRole('heading',{name:'Detail úkolu'})).toBeVisible();
  await expect(page.locator('.stagingTaskContent')).toHaveCount(0);
  expect(detailGets).toBe(0);
  await page.getByRole('button',{name:'Načíst úkol'}).click();
  await expect(page.locator('.stagingTaskContent')).toContainText('Ověřený úkol');
  expect(detailGets).toBe(1);
});

test('a task linked from the index still requires server permission',async({page})=>{
  await page.route(indexEndpoint,route=>fulfill(route,indexTaskPage));
  let detailGets=0;
  await page.route(endpoint,route=>{detailGets++;return fulfill(route,{error:'secret'},404);});
  await page.goto(indexUrl);
  await page.getByRole('link',{name:'Otevřít úkol: Ověřený úkol'}).click();
  await expect(page.locator('.stagingTaskContent')).toHaveCount(0);
  expect(detailGets).toBe(0);
  await page.getByRole('button',{name:'Načíst úkol'}).click();
  await expect(page.locator('.stagingTaskError')).toContainText('Úkol není dostupný');
  await expect(page.locator('.stagingTaskError')).not.toContainText('secret');
  await expect(page.locator('.stagingTaskContent')).toHaveCount(0);
  expect(detailGets).toBe(1);
});
