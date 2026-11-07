/** UI-09d default-off check; run with no note preview server flag. */
import {expect,test} from "./fixtures";

test("note detail preview returns 404 unless note preview is explicitly enabled",async({page})=>{
  const response=await page.goto("/target-staging/notes/note-1/preview");
  expect(response?.status()).toBe(404);
  await expect(page.getByRole("button",{name:"Načíst poznámku"})).toHaveCount(0);
  await expect(page.getByRole("heading",{name:"Detail poznámky"})).toHaveCount(0);
});
