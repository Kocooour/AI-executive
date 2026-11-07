/** Default-deny smoke on the same isolated server, with the preview flag OFF. */
import {test,expect} from "./fixtures";
test("UI-09c preview returns HTTP 404 without client opt-in",async({page})=>{
  const response=await page.goto("/target-staging/projects/family/preview");
  expect(response?.status()).toBe(404);
  await expect(page.getByRole("heading",{name:"Úkoly projektu"})).toHaveCount(0);
  await expect(page.getByRole("button",{name:"Ověřit a načíst projekt"})).toHaveCount(0);
});
