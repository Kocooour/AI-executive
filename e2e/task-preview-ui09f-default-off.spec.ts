import {expect,test} from './fixtures';
test('task preview returns 404 by default',async({page})=>{
  const response=await page.goto('/target-staging/tasks/task-1/preview');
  expect(response?.status()).toBe(404);
  await expect(page.getByRole('button',{name:'Načíst úkol'})).toHaveCount(0);
});
