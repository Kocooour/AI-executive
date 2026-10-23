import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import https from "node:https";
import ical, { type EventInstance, type VEvent } from "node-ical";
import { CalDavAuthError, CalDavError, defaultCalDavOptions, fetchCalendarObjects, type CalDavCredentials, type CalDavOptions } from "./caldav";
import { resolvedTarget } from "./calendar-net";
import { convertedEventIds, effectiveBusyEvents, isHiddenEvent, readDecisions } from "./calendar-decisions";
import { serverErrorKeys } from "./server-errors";
import { ensureDailyBackup, getDatabase, readSnapshot } from "./server-store";

const MAX_ICS_BYTES = 2 * 1024 * 1024;
const MAX_EVENTS = 5000;
const MAX_COMPONENTS = 5000;
const REQUEST_DEADLINE_MS = 12_000;

export interface CalendarEvent {
  id: string;
  sourceId: string;
  workspaceId: string;
  uid: string;
  occurrenceKey: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  timezone: string;
  status: string;
  transparency: string;
  busy: boolean;
  private: boolean;
  /** Whether the event belongs to a recurring series (RRULE, overrides or RECURRENCE-ID); absent in payloads cached before 2026-10. */
  recurring?: boolean;
}

export interface CalendarSourceState {
  id: string;
  workspaceId: string;
  provider: "ics" | "caldav";
  /** The iCloud account a CalDAV calendar belongs to; null for an ICS feed. */
  accountId: string | null;
  label: string;
  status: string;
  configured: boolean;
  lastSyncAt: number | null;
  lastSuccessAt: number | null;
  lastError: string;
  eventCount: number;
  revision: number;
}

function encryptionKey() {
  const secret = process.env.AI_EXECUTIVE_CALENDAR_SECRET || process.env.AI_EXECUTIVE_SESSION_SECRET || "";
  if (secret.length < 32) throw new Error("Calendar encryption is not configured");
  return createHash("sha256").update(`calendar-source\0${secret}`).digest();
}

export function encrypt(value: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString("base64url")).join(".");
}

export function decrypt(value: string) {
  const parts = value.split(".").map((part) => Buffer.from(part, "base64url"));
  if (parts.length !== 3 || parts[0].length !== 12 || parts[1].length !== 16) throw new Error("Calendar source is corrupt");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), parts[0]);
  decipher.setAuthTag(parts[1]);
  return Buffer.concat([decipher.update(parts[2]), decipher.final()]).toString("utf8");
}

async function fetchOnce(url: URL): Promise<{ body?: string; redirect?: URL; contentType?: string }> {
  const target = await resolvedTarget(url);
  return new Promise((resolve, reject) => {
    const request = https.request({
      protocol: "https:", hostname: url.hostname, port: 443,
      path: `${url.pathname}${url.search}`, method: "GET",
      headers: { Accept: "text/calendar, text/plain;q=0.8", "User-Agent": "AI-Executive-Calendar/1" },
      servername: url.hostname,
      lookup: (_hostname, options, callback) => {
        if (typeof options === "object" && options.all) callback(null, [target]);
        else callback(null, target.address, target.family);
      },
      timeout: 10_000,
    }, (response) => {
      const status = response.statusCode || 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        try { resolve({ redirect: new URL(response.headers.location, url) }); } catch { reject(new Error("Calendar redirect is invalid")); }
        return;
      }
      if (status !== 200) { response.resume(); reject(new Error(`Calendar server returned ${status}`)); return; }
      const declared = Number(response.headers["content-length"] || 0);
      if (declared > MAX_ICS_BYTES) { response.destroy(); reject(new Error("Calendar feed is too large")); return; }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_ICS_BYTES) { response.destroy(new Error("Calendar feed is too large")); return; }
        chunks.push(chunk);
      });
      response.on("end", () => resolve({ body: Buffer.concat(chunks).toString("utf8"), contentType: String(response.headers["content-type"] || "") }));
      response.on("error", reject);
    });
    const deadline = setTimeout(() => request.destroy(new Error("Calendar request exceeded its total time limit")), REQUEST_DEADLINE_MS);
    request.on("close", () => clearTimeout(deadline));
    request.on("timeout", () => request.destroy(new Error("Calendar request timed out")));
    request.on("error", reject);
    request.end();
  });
}

async function fetchCalendar(urlValue: string) {
  let url = new URL(urlValue);
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    const response = await fetchOnce(url);
    if (response.redirect) { url = response.redirect; continue; }
    const contentType = (response.contentType || "").toLowerCase();
    if (contentType && !contentType.includes("text/calendar") && !contentType.includes("text/plain") && !contentType.includes("application/octet-stream")) {
      throw new Error("Calendar server returned an unsupported content type");
    }
    if (!response.body?.includes("BEGIN:VCALENDAR")) throw new Error("Response is not an iCalendar feed");
    return response.body;
  }
  throw new Error("Calendar redirected too many times");
}

function scalar(value: unknown) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "val" in value) return String((value as { val?: unknown }).val || "");
  return String(value || "");
}

function normalizeInstance(sourceId: string, workspaceId: string, uid: string, instance: EventInstance, recurring: boolean): CalendarEvent | null {
  if (!(instance.start instanceof Date) || Number.isNaN(instance.start.getTime())) return null;
  const event = instance.event as VEvent & Record<string, unknown>;
  const start = instance.start;
  const end = instance.end instanceof Date && instance.end > start
    ? instance.end : new Date(start.getTime() + (instance.isFullDay ? 24 * 60 * 60_000 : 30 * 60_000));
  const status = scalar(event.status || "CONFIRMED").toUpperCase();
  if (status === "CANCELLED") return null;
  const transparency = scalar(event.transparency || "OPAQUE").toUpperCase();
  const occurrenceKey = `${uid}:${start.toISOString()}`;
  const classification = scalar((event as Record<string, unknown>).class || "PUBLIC").toUpperCase();
  const timezone = String((start as Date & { tz?: string }).tz || "UTC");
  return {
    id: createHash("sha256").update(`${sourceId}\0${occurrenceKey}`).digest("hex"),
    sourceId, workspaceId, uid, occurrenceKey,
    title: classification === "PRIVATE" || classification === "CONFIDENTIAL"
      ? "Soukromá událost"
      : scalar(event.summary || "Událost").slice(0, 500),
    start: start.toISOString(), end: end.toISOString(), allDay: instance.isFullDay,
    timezone, status, transparency,
    busy: transparency !== "TRANSPARENT" && status !== "CANCELLED",
    private: classification === "PRIVATE" || classification === "CONFIDENTIAL",
    recurring,
  };
}

/** The cached horizon: 14 days back and 90 days forward. */
export function calendarWindow(now = Date.now()) {
  return { from: new Date(now - 14 * 24 * 60 * 60_000), to: new Date(now + 90 * 24 * 60 * 60_000) };
}

/**
 * Normalized events of one calendar: an ICS feed (one body) or the calendar objects of a CalDAV calendar (one body per
 * event resource). The limits on size, lines, components and occurrences apply to the calendar as a whole.
 */
export async function parseCalendar(sourceId: string, workspaceId: string, input: string | string[]) {
  const bodies = Array.isArray(input) ? input : [input];
  const totalLength = bodies.reduce((total, body) => total + body.length, 0);
  const totalLines = bodies.reduce((total, body) => total + body.split("\n").length, 0);
  if (totalLength > MAX_ICS_BYTES || totalLines > 50_000) throw new Error("Calendar feed is too large");
  const { from, to } = calendarWindow();
  const events: CalendarEvent[] = [];
  let componentCount = 0;
  for (const body of bodies) for (const component of Object.values(await ical.async.parseICS(body))) {
    if (!component || component.type !== "VEVENT") continue;
    componentCount += 1;
    if (componentCount > MAX_COMPONENTS) throw new Error("Calendar contains too many components");
    if (component.rrule) {
      const frequency = String(component.rrule.options.freq || "").toUpperCase();
      if (!["DAILY", "WEEKLY", "MONTHLY", "YEARLY"].includes(frequency)) {
        throw new Error("Sub-daily or unknown recurrence is not supported");
      }
      const dimensions = ["byhour", "byminute", "bysecond"];
      if (dimensions.some((name) => {
        const value = component.rrule?.options[name];
        return Array.isArray(value) && value.length > 1;
      })) throw new Error("Recurrence expands too frequently");
    }
    const uid = scalar(component.uid);
    if (!uid) continue;
    // From the definition, not from how many repeats fall into the cached window (a yearly series has one).
    const recurring = Boolean(component.rrule || component.recurrenceid || Object.keys(component.recurrences || {}).length);
    const instances = ical.expandRecurringEvent(component, { from, to, includeOverrides: true, excludeExdates: true, expandOngoing: true });
    for (const instance of instances) {
      const event = normalizeInstance(sourceId, workspaceId, uid, instance, recurring);
      if (event) events.push(event);
      if (events.length > MAX_EVENTS) throw new Error("Calendar contains too many occurrences");
    }
  }
  return [...new Map(events.map((event) => [event.occurrenceKey, event])).values()];
}

function sourceRow(id: string) {
  return getDatabase().prepare("SELECT * FROM calendar_sources WHERE id = ?").get(id) as Record<string, unknown> | undefined;
}

function publicSource(row: Record<string, unknown>): CalendarSourceState {
  const lastSuccessAt = row.last_success_at == null ? null : Number(row.last_success_at);
  const storedStatus = String(row.status);
  return {
    id: String(row.id), workspaceId: String(row.workspace_id), provider: row.provider === "caldav" ? "caldav" : "ics",
    accountId: row.account_id == null ? null : String(row.account_id), label: String(row.label),
    status: storedStatus === "ready" && lastSuccessAt && Date.now() - lastSuccessAt > 24 * 60 * 60_000 ? "stale" : storedStatus, configured: true,
    lastSyncAt: row.last_sync_at == null ? null : Number(row.last_sync_at),
    lastSuccessAt,
    lastError: String(row.last_error || ""), eventCount: Number(row.event_count || 0), revision: Number(row.revision || 0),
  };
}

export function listCalendarSources() {
  return getDatabase().prepare("SELECT * FROM calendar_sources ORDER BY created_at").all()
    .map((row) => publicSource(row as Record<string, unknown>));
}

export function saveCalendarSource(input: { label: string; url: string; workspaceId: string }) {
  const label = input.label.trim();
  if (!label || label.length > 120) throw new Error("Invalid calendar label");
  if (!readSnapshot().entities.some((entity) => entity.type === "workspace" && entity.workspaceId === input.workspaceId)) throw new Error("Workspace not found");
  const url = new URL(input.url.trim());
  if (url.protocol !== "https:" || input.url.length > 8192) throw new Error("Calendar URL must use HTTPS");
  const id = randomUUID();
  const now = Date.now();
  ensureDailyBackup();
  getDatabase().prepare(`INSERT INTO calendar_sources
    (id, workspace_id, provider, label, encrypted_url, status, created_at, updated_at)
    VALUES (?, ?, 'ics', ?, ?, 'pending', ?, ?)`)
    .run(id, input.workspaceId, label, encrypt(url.toString()), now, now);
  return publicSource(sourceRow(id)!);
}

const sourceChanged = () => Object.assign(new Error("Calendar source changed during synchronization"), { sourceChanged: true });
export const isSourceChanged = (error: unknown) => error instanceof Error && (error as { sourceChanged?: boolean }).sourceChanged === true;

export async function refreshCalendarSource(id: string) {
  const row = sourceRow(id);
  if (!row) throw new Error("Calendar source not found");
  const now = Date.now();
  // The version of the calendar this refresh fetches for. A change while it runs (another workspace, a deselect, a disconnect)
  // bumps the revision; the fetched events then belong to the old version and nothing is written, not even an error state.
  const revision = Number(row.revision);
  ensureDailyBackup();
  const claimed = getDatabase().prepare(`UPDATE calendar_sources SET status='syncing', updated_at=?
    WHERE id=? AND revision=? AND (status!='syncing' OR updated_at < ?)`)
    .run(now, id, revision, now - 15 * 60_000);
  if (Number(claimed.changes) !== 1) throw new Error("Calendar synchronization is already running");
  try {
    const body = row.provider === "caldav" ? await fetchCalDavSource(row) : await fetchCalendar(decrypt(String(row.encrypted_url)));
    const events = await parseCalendar(id, String(row.workspace_id), body);
    const database = getDatabase();
    database.exec("BEGIN IMMEDIATE");
    try {
      const current = database.prepare("SELECT revision, workspace_id FROM calendar_sources WHERE id = ?").get(id) as { revision: number; workspace_id: string } | undefined;
      if (!current) throw new Error("Calendar source was disconnected during synchronization");
      if (Number(current.revision) !== revision || current.workspace_id !== row.workspace_id) throw sourceChanged();
      database.prepare("DELETE FROM calendar_events WHERE source_id = ?").run(id);
      const insert = database.prepare(`INSERT INTO calendar_events
        (id, source_id, workspace_id, occurrence_key, payload, start_at, end_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const event of events) insert.run(event.id, id, event.workspaceId, event.occurrenceKey, JSON.stringify(event), Date.parse(event.start), Date.parse(event.end), now);
      database.prepare(`UPDATE calendar_sources SET status='ready', last_sync_at=?, last_success_at=?, last_error=NULL,
        event_count=?, revision=revision+1, updated_at=? WHERE id=?`).run(now, now, events.length, now, id);
      database.exec("COMMIT");
    } catch (error) { database.exec("ROLLBACK"); throw error; }
    return { source: publicSource(sourceRow(id)!), events };
  } catch (error) {
    // Changed or removed meanwhile: the error state belongs to the old version, so it is not written either.
    const errorState = getDatabase().prepare("UPDATE calendar_sources SET status='error', last_sync_at=?, last_error=?, updated_at=? WHERE id=? AND revision=?");
    if (row.provider === "caldav") {
      // Only fixed messages are kept for an iCloud calendar: never an address, the Apple ID or a parser's quote of the data.
      // The account's state is set by refreshCalDavAccount, the only caller for an iCloud calendar.
      const message = safeCalDavMessage(error);
      errorState.run(now, message, now, id, revision);
      throw error instanceof CalDavError || isSourceChanged(error) ? error : new Error(message);
    }
    if (isSourceChanged(error)) throw error;
    const message = error instanceof Error ? error.message.slice(0, 500) : "Calendar refresh failed";
    errorState.run(now, message, now, id, revision);
    throw new Error(message);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// iCloud (CalDAV) calendars: an account row holds the encrypted Apple ID and app-specific password; each selected
// calendar is a source row (provider 'caldav') whose encrypted address is the calendar collection. The account lifecycle
// (discover, connect, password, selection, disconnect) is in lib/icloud-calendar.ts.

let calDavOptionsOverride: CalDavOptions | null = null;
/** Unit tests replace the network with a fake transport. */
export function setCalDavOptionsForTests(options: CalDavOptions | null) {
  if (options !== null && !process.env.NODE_TEST_CONTEXT) throw new Error("Not available outside tests");
  calDavOptionsOverride = options;
}
export function calDavOptions(): CalDavOptions {
  return calDavOptionsOverride ?? defaultCalDavOptions();
}

export function safeCalDavMessage(error: unknown) {
  if (error instanceof CalDavError) return error.message;
  if (error instanceof Error && error.message in serverErrorKeys) return error.message;
  // Written as an Error so that tests/server-errors.test.mjs finds (and requires a translation of) the message.
  return new Error("iCloud calendar could not be read").message;
}

export function calDavAccountRow(id: string) {
  return getDatabase().prepare("SELECT * FROM calendar_accounts WHERE id = ?").get(id) as Record<string, unknown> | undefined;
}

export function calDavCredentials(account: Record<string, unknown>): CalDavCredentials {
  const value = JSON.parse(decrypt(String(account.encrypted_credentials))) as Partial<CalDavCredentials>;
  if (typeof value.username !== "string" || typeof value.password !== "string") throw new Error("Calendar source is corrupt");
  return { username: value.username, password: value.password };
}

/**
 * Records the account's state. A refused password stops automatic refreshes until the password is replaced. The callers
 * write after awaiting iCloud, so they pass the account version they started from (revision and updated_at): when the
 * account was disconnected, given a new password, or replaced by a restore in the meantime, nothing is written.
 */
export function markCalDavAccount(
  id: string, status: "ready" | "auth_failed" | "error", message: string | null, expected: { revision: number; updatedAt: number },
) {
  const now = Date.now();
  const result = getDatabase().prepare(`UPDATE calendar_accounts SET status=?, last_error=?, last_success_at=CASE WHEN ? = 'ready' THEN ? ELSE last_success_at END,
    revision=revision+1, updated_at=? WHERE id=? AND revision=? AND updated_at=?`).run(status, message, status, now, now, id, expected.revision, expected.updatedAt);
  return Number(result.changes) === 1;
}

export function calDavAccountVersion(account: Record<string, unknown>) {
  return { revision: Number(account.revision), updatedAt: Number(account.updated_at) };
}

async function fetchCalDavSource(row: Record<string, unknown>) {
  const account = row.account_id == null ? undefined : calDavAccountRow(String(row.account_id));
  if (!account) throw new Error("No iCloud account is connected");
  if (account.status === "auth_failed") throw new CalDavAuthError("Apple refused the app-specific password");
  return fetchCalendarObjects(calDavCredentials(account), decrypt(String(row.encrypted_url)), calendarWindow(), calDavOptions());
}

/**
 * Refreshes every calendar of an iCloud account, one REPORT each. The account is claimed with the same 'syncing' pattern as a
 * source (a claim older than 15 minutes is taken over). An account whose password was refused is not contacted at all.
 */
export async function refreshCalDavAccount(accountId: string) {
  const now = Date.now();
  ensureDailyBackup();
  const claimed = getDatabase().prepare(`UPDATE calendar_accounts SET status='syncing', updated_at=?
    WHERE id=? AND status!='auth_failed' AND (status!='syncing' OR updated_at < ?)`).run(now, accountId, now - 15 * 60_000);
  if (Number(claimed.changes) !== 1) {
    const account = calDavAccountRow(accountId);
    if (!account) throw new Error("No iCloud account is connected");
    if (account.status === "auth_failed") throw new CalDavAuthError("Apple refused the app-specific password");
    throw new Error("Calendar synchronization is already running");
  }
  // The version this refresh owns: the final state is written only if nobody changed the account meanwhile.
  const claimedAccount = calDavAccountRow(accountId);
  if (!claimedAccount) throw new Error("No iCloud account is connected");
  const version = calDavAccountVersion(claimedAccount);
  const sources = getDatabase().prepare("SELECT id FROM calendar_sources WHERE account_id = ? AND provider = 'caldav' ORDER BY created_at")
    .all(accountId) as Array<{ id: string }>;
  let failure: unknown = null;
  for (const source of sources) {
    try {
      // A calendar changed during its fetch (moved to another workspace) is fetched once more for its new version.
      try { await refreshCalendarSource(String(source.id)); }
      catch (error) {
        if (!isSourceChanged(error)) throw error;
        if (sourceRow(String(source.id))) await refreshCalendarSource(String(source.id));
      }
    } catch (error) {
      // A calendar deselected or changed meanwhile is not a failure of the account.
      if (isSourceChanged(error) || (error instanceof Error && ["Calendar source was disconnected during synchronization", "Calendar source not found"].includes(error.message))) continue;
      failure ??= error;
      if (error instanceof CalDavAuthError) { failure = error; break; }
    }
  }
  if (!failure) markCalDavAccount(accountId, "ready", null, version);
  else if (failure instanceof CalDavAuthError) markCalDavAccount(accountId, "auth_failed", failure.message, version);
  else markCalDavAccount(accountId, "error", safeCalDavMessage(failure), version);
  if (failure) throw failure instanceof CalDavError ? failure : new Error(safeCalDavMessage(failure));
  return { refreshed: sources.length };
}

export async function processCalendarRefreshes(now = Date.now()) {
  const rows = getDatabase().prepare(`SELECT id FROM calendar_sources
    WHERE provider != 'caldav'
      AND (status != 'syncing' OR updated_at <= ?)
      AND (last_sync_at IS NULL OR last_sync_at <= ?)
    ORDER BY COALESCE(last_sync_at, 0) LIMIT 2`).all(now - 15 * 60_000, now - 30 * 60_000);
  let refreshed = 0;
  for (const row of rows) {
    try { await refreshCalendarSource(String((row as { id: string }).id)); refreshed += 1; }
    catch { /* State is persisted without leaking the feed URL to logs. */ }
  }
  // At most one iCloud account per pass, with all of its calendars; an account whose password was refused waits for a new one.
  const account = getDatabase().prepare(`SELECT a.id FROM calendar_accounts a
    WHERE a.status != 'auth_failed' AND (a.status != 'syncing' OR a.updated_at <= ?)
      AND EXISTS (SELECT 1 FROM calendar_sources s WHERE s.account_id = a.id AND (s.last_sync_at IS NULL OR s.last_sync_at <= ?))
    ORDER BY a.updated_at LIMIT 1`).get(now - 15 * 60_000, now - 30 * 60_000) as { id: string } | undefined;
  if (account) {
    try { await refreshCalDavAccount(String(account.id)); refreshed += 1; }
    catch { /* The account and its calendars keep a fixed message; nothing identifying is logged. */ }
  }
  return { due: rows.length + (account ? 1 : 0), refreshed };
}

/** After a restore: the event cache was emptied, so every restored source is fetched again. A failure is logged without the feed address. */
export async function refreshAllCalendarSources() {
  const rows = getDatabase().prepare("SELECT id FROM calendar_sources WHERE provider != 'caldav'").all() as Array<{ id: string }>;
  for (const row of rows) {
    try { await refreshCalendarSource(String(row.id)); }
    catch (error) { console.error("Calendar refresh after a restore failed:", error instanceof Error ? error.message.slice(0, 200) : "error"); }
  }
  const accounts = getDatabase().prepare("SELECT id FROM calendar_accounts").all() as Array<{ id: string }>;
  for (const account of accounts) {
    try { await refreshCalDavAccount(String(account.id)); }
    catch (error) { console.error("Calendar refresh after a restore failed:", safeCalDavMessage(error)); }
  }
}

export function deleteCalendarSource(id: string) {
  ensureDailyBackup();
  const database = getDatabase();
  database.exec("BEGIN IMMEDIATE");
  try {
    database.prepare("DELETE FROM calendar_events WHERE source_id = ?").run(id);
    const result = database.prepare("DELETE FROM calendar_sources WHERE id = ?").run(id);
    database.exec("COMMIT");
    return Number(result.changes) === 1;
  } catch (error) { database.exec("ROLLBACK"); throw error; }
}

export function listCalendarEvents(workspaceId: string, from: number, to: number) {
  if (to <= from || to - from > 120 * 24 * 60 * 60_000) throw new Error("Invalid calendar range");
  return getDatabase().prepare(`SELECT payload FROM calendar_events
    WHERE workspace_id = ? AND end_at > ? AND start_at < ? ORDER BY start_at LIMIT ?`)
    .all(workspaceId, from, to, MAX_EVENTS)
    .map((row) => JSON.parse(String((row as { payload: string }).payload)) as CalendarEvent);
}

function zonedDateTimeToMs(dateValue: string, timeValue: string, timeZone: string) {
  const [year, month, date] = dateValue.split("-").map(Number);
  const [hour, minute] = timeValue.split(":").map(Number);
  const desired = Date.UTC(year, month - 1, date, hour, minute);
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  });
  let candidate = desired;
  for (let iteration = 0; iteration < 2; iteration += 1) {
    const values = Object.fromEntries(formatter.formatToParts(new Date(candidate)).map((part) => [part.type, part.value]));
    const represented = Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day), Number(values.hour), Number(values.minute));
    candidate += desired - represented;
  }
  return candidate;
}

/** The events that occupy time in a workspace: not hidden by the owner and not turned into a task (lib/calendar-decisions.ts). */
export function effectiveBusyEventsFor(workspaceId: string, events: CalendarEvent[]) {
  const entities = readSnapshot().entities;
  const workspace = entities.find((entity) => entity.type === "workspace" && entity.workspaceId === workspaceId);
  return effectiveBusyEvents(events, readDecisions(workspace), entities.filter((entity) => entity.type === "task" && entity.workspaceId === workspaceId));
}

/**
 * The events an agent may see: hidden events ("only in the calendar so I know") and events that became
 * tasks (the task stands for them) are left out, like everywhere outside the Calendar view.
 */
export function visibleCalendarEventsFor(workspaceId: string, events: CalendarEvent[]) {
  const entities = readSnapshot().entities;
  const workspace = entities.find((entity) => entity.type === "workspace" && entity.workspaceId === workspaceId);
  const decisions = readDecisions(workspace);
  const converted = convertedEventIds(entities.filter((entity) => entity.type === "task" && entity.workspaceId === workspaceId), events);
  return events.filter((event) => !isHiddenEvent(decisions, event) && !converted.has(event.id));
}

export function calendarAvailability(
  workspaceId: string,
  localDate: string,
  timezone: string,
  workdayStart: string,
  workdayEnd: string,
) {
  const sources = listCalendarSources().filter((source) => source.workspaceId === workspaceId);
  const from = zonedDateTimeToMs(localDate, workdayStart, timezone);
  const to = zonedDateTimeToMs(localDate, workdayEnd, timezone);
  if (!sources.length || to <= from) return { configured: false, fresh: false, freeHours: 0, busyHours: 0, windows: [] as Array<{ start: string; end: string; hours: number }> };
  const fresh = sources.every((source) => source.status === "ready");
  const events = effectiveBusyEventsFor(workspaceId, listCalendarEvents(workspaceId, from, to));
  const merged = events.map((event) => [Math.max(from, Date.parse(event.start)), Math.min(to, Date.parse(event.end))] as [number, number])
    .filter((interval) => interval[1] > interval[0]).sort((a, b) => a[0] - b[0])
    .reduce<Array<[number, number]>>((result, interval) => {
      const previous = result[result.length - 1];
      if (!previous || interval[0] > previous[1]) result.push(interval);
      else previous[1] = Math.max(previous[1], interval[1]);
      return result;
    }, []);
  const windows: Array<{ start: string; end: string; hours: number }> = [];
  let cursor = from;
  for (const interval of merged) {
    if (interval[0] - cursor >= 30 * 60_000) windows.push({ start: new Date(cursor).toISOString(), end: new Date(interval[0]).toISOString(), hours: (interval[0] - cursor) / 3_600_000 });
    cursor = Math.max(cursor, interval[1]);
  }
  if (to - cursor >= 30 * 60_000) windows.push({ start: new Date(cursor).toISOString(), end: new Date(to).toISOString(), hours: (to - cursor) / 3_600_000 });
  const busyMs = merged.reduce((total, interval) => total + interval[1] - interval[0], 0);
  return { configured: true, fresh, freeHours: (to - from - busyMs) / 3_600_000, busyHours: busyMs / 3_600_000, windows };
}
