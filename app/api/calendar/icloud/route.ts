import { NextResponse } from "next/server";
import { fenceRestoredClient } from "../../../../lib/restore-fence";
import { isAuthenticated } from "../../../../lib/auth";
import { CalDavAuthError, CalDavError } from "../../../../lib/caldav";
import { refreshCalDavAccount } from "../../../../lib/calendar";
import {
  applyICloudSelection,
  calendarChoices,
  disconnectICloud,
  discoverICloud,
  getICloudAccountState,
  parseAppleId,
  parseAppPassword,
  recordRefusedPassword,
  replaceICloudPassword,
  requireAccount,
  storeICloudAccount,
  storedCredentials,
} from "../../../../lib/icloud-calendar";
import { enforceRateLimit, HttpInputError, readJsonBody, requireSameOrigin } from "../../../../lib/http-security";
import { recordSecurityEvent } from "../../../../lib/security-audit";
import { developerOnly, serverErrorKeys } from "../../../../lib/server-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The owner's iCloud calendar over CalDAV, read-only. Owner session only (the integration API token is not a session).
// Responses never contain the Apple ID, the password or an iCloud address, and are never cached.
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });

// Only messages written in this code base are returned; anything else becomes a fixed text.
function safeMessage(error: unknown) {
  const message = error instanceof Error ? String(error.message) : "";
  // The fallback is written as an Error so that tests/server-errors.test.mjs finds (and requires a translation of) it.
  return message in serverErrorKeys || developerOnly.has(message) ? message : new Error("iCloud request failed").message;
}

export async function GET(request: Request) {
  if (!isAuthenticated(request)) return json({ error: "Authentication required" }, 401);
  const limited = enforceRateLimit(request, "calendar-read", 300, 10 * 60_000);
  if (limited) return json({ error: limited.error }, limited.status);
  return json({ account: getICloudAccountState() });
}

export async function POST(request: Request) {
  if (!isAuthenticated(request)) return json({ error: "Authentication required" }, 401);
  const fenced = fenceRestoredClient(request);
  if (fenced) return fenced;
  let action = "";
  try {
    requireSameOrigin(request);
    const body = await readJsonBody<Record<string, unknown>>(request, 16 * 1024);
    // Checked again now that the body has been read (see app/api/calendar/route.ts). The actions that ask iCloud first check
    // the fence once more after that answer, right before their synchronous write.
    const fencedAgain = fenceRestoredClient(request);
    if (fencedAgain) return fencedAgain;
    action = String(body.action || "");
    // Every action that sends the Apple ID to Apple shares one tight limit, so that Lumi cannot get the account locked.
    const appleActions = ["discover", "connect", "update-password", "calendars", "select"];
    const limited = appleActions.includes(action)
      ? enforceRateLimit(request, "calendar-icloud-apple", 10, 60 * 60_000)
      : enforceRateLimit(request, `calendar-icloud-${action}`, action === "refresh" ? 12 : 30, 60 * 60_000);
    if (limited) return json({ error: limited.error }, limited.status);

    if (action === "discover") {
      const credentials = { username: parseAppleId(body.appleId), password: parseAppPassword(body.appPassword) };
      const discovery = await discoverICloud(credentials);
      recordSecurityEvent(request, "calendar.icloud.discover", "allowed", { provider: "icloud" });
      return json({ calendars: calendarChoices(discovery) });
    }
    if (action === "connect") {
      const credentials = { username: parseAppleId(body.appleId), password: parseAppPassword(body.appPassword) };
      const discovery = await discoverICloud(credentials);
      const fencedAfterDiscovery = fenceRestoredClient(request);
      if (fencedAfterDiscovery) return fencedAfterDiscovery;
      const accountId = storeICloudAccount(credentials, discovery, body.calendars);
      recordSecurityEvent(request, "calendar.icloud.connect", "allowed", { provider: "icloud" });
      return refreshed(request, accountId);
    }
    if (action === "update-password") {
      const account = requireAccount();
      const credentials = { username: storedCredentials(account).username, password: parseAppPassword(body.appPassword) };
      const discovery = await discoverICloud(credentials);
      const fencedAfterDiscovery = fenceRestoredClient(request);
      if (fencedAfterDiscovery) return fencedAfterDiscovery;
      replaceICloudPassword(String(account.id), credentials, discovery);
      recordSecurityEvent(request, "calendar.icloud.password", "allowed", { provider: "icloud" });
      return refreshed(request, String(account.id));
    }
    if (action === "calendars" || action === "select") {
      const account = requireAccount();
      if (account.status === "auth_failed") throw new CalDavAuthError("Apple refused the app-specific password");
      let discovery;
      try { discovery = await discoverICloud(storedCredentials(account)); }
      catch (error) {
        if (error instanceof CalDavAuthError) recordRefusedPassword(String(account.id));
        throw error;
      }
      if (action === "calendars") return json({ calendars: calendarChoices(discovery) });
      const fencedAfterDiscovery = fenceRestoredClient(request);
      if (fencedAfterDiscovery) return fencedAfterDiscovery;
      applyICloudSelection(String(account.id), discovery, body.calendars);
      recordSecurityEvent(request, "calendar.icloud.select", "allowed", { provider: "icloud" });
      return refreshed(request, String(account.id));
    }
    if (action === "refresh") {
      const account = requireAccount();
      try { await refreshCalDavAccount(String(account.id)); }
      catch (error) { return json({ account: getICloudAccountState(), error: safeMessage(error), code: error instanceof CalDavAuthError ? "auth" : undefined }, 502); }
      recordSecurityEvent(request, "calendar.icloud.refresh", "allowed", { provider: "icloud" });
      return json({ account: getICloudAccountState() });
    }
    if (action === "disconnect") {
      const account = requireAccount();
      disconnectICloud(String(account.id));
      recordSecurityEvent(request, "calendar.icloud.disconnect", "allowed", { provider: "icloud" });
      return json({ account: null, removed: true });
    }
    return json({ error: "Unknown action" }, 400);
  } catch (error) {
    recordSecurityEvent(request, `calendar.icloud.${/^[a-z-]{1,20}$/.test(action) ? action : "write"}`, error instanceof CalDavAuthError ? "rejected" : "failed", { provider: "icloud" });
    const status = error instanceof HttpInputError ? error.status : error instanceof CalDavAuthError ? 400 : error instanceof CalDavError ? 502 : 400;
    return json({ error: safeMessage(error), code: error instanceof CalDavAuthError ? "auth" : undefined }, status);
  }
}

/** The stored account is fetched right away; only the event cache and the states are written after this await. */
async function refreshed(request: Request, accountId: string) {
  try {
    await refreshCalDavAccount(accountId);
    return json({ account: getICloudAccountState() });
  } catch (error) {
    recordSecurityEvent(request, "calendar.icloud.refresh", "failed", { provider: "icloud" });
    return json({ account: getICloudAccountState(), error: safeMessage(error), code: error instanceof CalDavAuthError ? "auth" : undefined }, 502);
  }
}
