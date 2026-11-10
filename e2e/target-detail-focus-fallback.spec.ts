import {expect,test} from '@playwright/test';

test.skip(process.env.LUMI_TARGET_DETAIL_FOCUS_E2E!=='true','Isolated target detail focus scenario is opt-in');

for(const width of [390,1280])test(`return when note list is offline at ${width}px`,async({page,context})=>{
  await page.setViewportSize({width,height:844});
  const headers={'content-type':'application/json','cache-control':'no-store'};
  await page.route('**/api/target-staging/session',route=>route.fulfill({status:200,headers,body:JSON.stringify({generation:'A'.repeat(43)})}));
  await page.route('**/api/target-staging/note-index/global**',route=>{
    const scope=new URL(route.request().url()).searchParams.get('scope');
    return route.fulfill({status:200,headers,body:JSON.stringify({scope,notes:[{id:'n',title:'Note n',projectId:null,areaId:'area',areaKind:'private',revision:1}],hasMore:false,nextCursor:null})});
  });
  await page.route('**/api/target-staging/notes/*',route=>route.fulfill({status:200,headers,body:JSON.stringify({note:{id:'n',title:'Note n',body:'Synthetic body',projectId:null,areaId:'area',areaKind:'private',revision:1}})}));
  await page.goto('/?view=Notes');
  const row=page.getByRole('button',{name:/Otevřít.*Note n/});
  await row.click();
  await expect(page.getByText('Synthetic body')).toBeVisible();
  await page.getByTestId('target-detail').getByRole('button',{name:/Zavřít|Zpět/}).click();
  await expect(row).toBeFocused();
  await row.click();
  await expect(page.getByText('Synthetic body')).toBeVisible();
  await context.setOffline(true);
  await expect(page.getByTestId('target-scope-list').getByRole('alert')).toBeAttached();
  await page.getByTestId('target-detail').getByRole('button',{name:/Zavřít|Zpět/}).click();
  await expect(page.getByTestId('target-detail')).toHaveCount(0);
  await expect(page.getByTestId('target-scope-list').getByRole('status')).toBeFocused();
});

test('a slow list failure does not steal focus after closing the detail',async({page,context})=>{
  let delayIndex=false;
  let releaseIndex:()=>void=()=>{};
  const delayed=new Promise<void>(resolve=>{releaseIndex=resolve;});
  const headers={'content-type':'application/json','cache-control':'no-store'};
  await page.route('**/api/target-staging/session',route=>route.fulfill({status:200,headers,body:JSON.stringify({generation:'A'.repeat(43)})}));
  await page.route('**/api/target-staging/note-index/global**',async route=>{
    if(delayIndex){await delayed;return route.fulfill({status:503,headers,body:'{}'});}
    const scope=new URL(route.request().url()).searchParams.get('scope');
    return route.fulfill({status:200,headers,body:JSON.stringify({scope,notes:[{id:'n',title:'Note n',projectId:null,areaId:'area',areaKind:'private',revision:1}],hasMore:false,nextCursor:null})});
  });
  await page.route('**/api/target-staging/notes/*',route=>route.fulfill({status:200,headers,body:JSON.stringify({note:{id:'n',title:'Note n',body:'Synthetic body',projectId:null,areaId:'area',areaKind:'private',revision:1}})}));
  await page.goto('/?view=Notes');
  await page.getByRole('button',{name:/Otevřít.*Note n/}).click();
  await expect(page.getByText('Synthetic body')).toBeVisible();
  await context.setOffline(true);
  await expect(page.getByTestId('target-scope-list').getByRole('alert')).toBeAttached();
  delayIndex=true;
  await context.setOffline(false);
  await expect(page.getByTestId('target-scope-list')).toHaveAttribute('data-state','loading');
  await page.getByTestId('target-detail').getByRole('button',{name:/Zavřít|Zpět/}).click();
  const status=page.getByTestId('target-scope-list').getByRole('status');
  await expect(status).toBeFocused();
  const scope=page.locator('[data-scope-option=personal]');
  await scope.focus();
  await page.waitForTimeout(3200); // Exceeds the focus-return window before the response fails.
  releaseIndex();
  await expect(page.getByTestId('target-scope-list')).toHaveAttribute('data-state','error');
  await expect(scope).toBeFocused();
});

for(const width of [390,1280])test(`return when a successful note-list refresh removes the opener at ${width}px`,async({page,context})=>{
  await page.setViewportSize({width,height:844});
  const headers={'content-type':'application/json','cache-control':'no-store'};
  let openerStillAuthorized=true;
  await page.route('**/api/target-staging/session',route=>route.fulfill({
    status:200,headers,body:JSON.stringify({generation:'A'.repeat(43)}),
  }));
  await page.route('**/api/target-staging/note-index/global**',route=>{
    const scope=new URL(route.request().url()).searchParams.get('scope');
    // A valid 200 response can be empty OR contain other authorized notes.
    // Neither case allows the old note's row to be focused again.
    const notes=openerStillAuthorized
      ? [{id:'n',title:'Note n',projectId:null,areaId:'area',areaKind:'private',revision:1}]
      : width===390 ? []
      : [{id:'other',title:'Other note',projectId:null,areaId:'area',areaKind:'private',revision:1}];
    return route.fulfill({status:200,headers,body:JSON.stringify({
      scope,notes,hasMore:false,nextCursor:null,
    })});
  });
  await page.route('**/api/target-staging/notes/*',route=>route.fulfill({
    status:200,headers,body:JSON.stringify({note:{
      id:'n',title:'Note n',body:'Synthetic body',
      projectId:null,areaId:'area',areaKind:'private',revision:1,
    }}),
  }));
  await page.goto('/?view=Notes');
  const list=page.getByTestId('target-scope-list');
  const row=page.getByRole('button',{name:/Otevřít.*Note n/});
  await row.click();
  await expect(page.getByText('Synthetic body')).toBeVisible();

  // Reconnect forces a full, independently authorized 200 list refresh while
  // the detail remains open. The note row no longer exists in the current list.
  await context.setOffline(true);
  await expect(list).toHaveAttribute('data-state','error');
  openerStillAuthorized=false;
  await context.setOffline(false);
  await expect(list).toHaveAttribute('data-state','ready');
  await expect(row).toHaveCount(0);
  if(width===1280)await expect(page.getByRole('button',{name:/Otevřít.*Other note/})).toBeVisible();
  await expect(page.getByTestId('target-detail')).toBeVisible();

  await page.getByTestId('target-detail').getByRole('button',{name:/Zavřít|Zpět/}).click();
  await expect(page.getByTestId('target-detail')).toHaveCount(0);
  const status=list.getByRole('status');
  await expect(status).toBeFocused();
  // A later list update or unrelated keyboard action must not steal focus.
  const scope=page.locator('[data-scope-option=personal]');
  await scope.focus();
  await expect(scope).toBeFocused();
});
