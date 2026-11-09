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
