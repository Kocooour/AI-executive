import { expect, test } from "./fixtures";
import type { CDPSession } from "@playwright/test";
import { e2ePassword } from "../playwright.config";
import { confirmDialog, settingsSections, waitUntilSynced } from "./helpers";

// Passkeys with Chromium's virtual authenticator: it behaves like Touch ID that always succeeds
// and keeps its credentials for this test only.
const authenticatorOptions = { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } as const;
type Credential = { credentialId: string; isResidentCredential: boolean; rpId?: string; privateKey: string; userHandle?: string; signCount: number };

async function newAuthenticator(cdp: CDPSession) {
  return (await cdp.send("WebAuthn.addVirtualAuthenticator", { options: authenticatorOptions })).authenticatorId;
}

test("a passkey signs in until it is removed", async ({ page, context }) => {
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const first = `Passkey A ${Date.now()}`;
  const second = `Passkey B ${Date.now()}`;
  const access = async () => {
    await page.goto("/?view=Settings");
    await waitUntilSynced(page);
    await settingsSections(page).filter({ hasText: "Přístup" }).click();
  };
  const register = async (label: string) => {
    await page.getByLabel("Název passkeye").fill(label);
    await page.getByLabel("Potvrďte současné heslo").fill(e2ePassword);
    await page.getByRole("button", { name: "Přidat passkey" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Passkey přidán" })).toBeVisible();
    await expect(page.locator(".passkeyRow", { hasText: label })).toBeVisible();
  };

  // A wrong password is refused by the server before the device is asked.
  let authenticator = await newAuthenticator(cdp);
  await access();
  await page.getByLabel("Název passkeye").fill(first);
  await page.getByLabel("Potvrďte současné heslo").fill("nespravne-heslo");
  const refused = page.waitForResponse((response) => response.url().endsWith("/api/auth/passkeys/register/options"));
  await page.getByRole("button", { name: "Přidat passkey" }).click();
  expect((await refused).status()).toBe(401);
  expect((await cdp.send("WebAuthn.getCredentials", { authenticatorId: authenticator })).credentials).toHaveLength(0);
  await expect(page.locator(".passkeyRow", { hasText: first })).toHaveCount(0);

  // Passkey A on one device, passkey B on another; this browser keeps only A.
  await register(first);
  const [credentialA] = (await cdp.send("WebAuthn.getCredentials", { authenticatorId: authenticator })).credentials as Credential[];
  await cdp.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId: authenticator });
  authenticator = await newAuthenticator(cdp);
  await register(second);
  await cdp.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId: authenticator });
  authenticator = await newAuthenticator(cdp);
  await cdp.send("WebAuthn.addCredential", { authenticatorId: authenticator, credential: credentialA });

  // Signing out and back in with passkey A, without the password.
  await page.getByRole("button", { name: "Odhlásit se" }).click();
  await expect(page.locator(".authCard")).toBeVisible();
  expect(await page.evaluate(() => fetch("/api/store").then((response) => response.status))).toBe(401);
  await page.getByRole("button", { name: "Přihlásit se passkeyem" }).click();
  await expect(page.locator(".appShell")).toBeVisible();
  expect(await page.evaluate(() => fetch("/api/store").then((response) => response.status))).toBe(200);

  // Removing A asks first.
  await access();
  await page.locator(".passkeyRow", { hasText: first }).getByRole("button", { name: "Odebrat" }).click();
  await confirmDialog(page).getByRole("button", { name: "Odebrat" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Passkey odebrán" })).toBeVisible();
  await expect(page.locator(".passkeyRow", { hasText: first })).toHaveCount(0);
  await expect(page.locator(".passkeyRow", { hasText: second })).toBeVisible();
  await page.getByRole("button", { name: "Odhlásit se" }).click();
  await expect(page.locator(".authCard")).toBeVisible();

  // The app no longer offers A, and the server refuses A even when the device sends it anyway.
  await page.getByRole("button", { name: "Přihlásit se passkeyem" }).click();
  await expect(page.locator(".authCard .authError")).toBeVisible();
  await expect(page.locator(".appShell")).toHaveCount(0);
  const status = await page.evaluate(async (credentialId) => {
    const decode = (value: string) => Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=")), (c) => c.charCodeAt(0));
    const options = await fetch("/api/auth/passkeys/login/options", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).then((response) => response.json());
    const credential = await navigator.credentials.get({ publicKey: {
      challenge: decode(options.challenge),
      rpId: options.rpId,
      allowCredentials: [{ type: "public-key", id: decode(credentialId) }],
      userVerification: "required",
    } }) as PublicKeyCredential & { toJSON(): unknown };
    const response = await fetch("/api/auth/passkeys/login/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ challenge: options.challenge, response: credential.toJSON() }) });
    return response.status;
  }, credentialA.credentialId);
  expect(status).toBe(401);
  expect(await page.evaluate(() => fetch("/api/store").then((response) => response.status))).toBe(401);
});
