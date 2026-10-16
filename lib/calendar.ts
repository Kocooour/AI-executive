import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import https from "node:https";
import net from "node:net";
import ical, { type EventInstance, type VEvent } from "node-ical";
import { getDatabase, readSnapshot } from "./server-store";

const MAX_ICS_BYTES = 2 * 1024 * 1024;
const MAX_EVENTS = 5000;
const MAX_COMPONENTS = 5000;
const REQUEST_DEADLINE_MS = 12_000;
const publicIpv6 = new net.BlockList();
publicIpv6.addSubnet("2000::", 3, "ipv6");
const unsafeIpv6 = new net.BlockList();
unsafeIpv6.addSubnet("2001::", 23, "ipv6");
unsafeIpv6.addSubnet("2001:db8::", 32, "ipv6");
unsafeIpv6.addSubnet("2002::", 16, "ipv6");
unsafeIpv6.addSubnet("3fff::", 20, "ipv6");

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
}

export interface CalendarSourceState {
  id: string;
  workspaceId: string;
  provider: "ics";
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

function encrypt(value: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString("base64url")).join(".");
}

function decrypt(value: string) {
  const parts = value.split(".").map((part) => Buffer.from(part, "base64url"));
  if (parts.length !== 3 || parts[0].length !== 12 || parts[1].length !== 16) throw new Error("Calendar source is corrupt");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), parts[0]);
  decipher.setAuthTag(parts[1]);
  return Buffer.concat([decipher.update(parts[2]), decipher.final()]).toString("utf8");
}

function isPublicAddress(address: string) {
  if (net.isIPv4(address)) {
    const [a, b, c] = address.split(".").map(Number);
    return !(
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0 && (c === 0 || c === 2)) ||
      (a === 192 && b === 88 && c === 99) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  const value = address.toLowerCase();
  if (!net.isIPv6(value)) return false;
  if (value.startsWith("::ffff:")) return isPublicAddress(value.slice(7));
  return publicIpv6.check(value, "ipv6") && !unsafeIpv6.check(value, "ipv6");
}

async function resolvedTarget(url: URL) {
  if (url.protocol !== "https:" || url.username || url.password || url.port && url.port !== "443") {
    throw new Error("Calendar URL must use public HTTPS on port 443");
  }
  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  const allowed = addresses.filter((item) => isPublicAddress(item.address));
  if (!allowed.length || allowed.length !== addresses.length) throw new Error("Calendar host resolves to a private or unsafe address");
  return allowed[0];
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

function normalizeInstance(sourceId: string, workspaceId: string, uid: string, instance: EventInstance): CalendarEvent | null {
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
  };
}

async function parseCalendar(sourceId: string, workspaceId: string, body: string) {
  if (body.length > MAX_ICS_BYTES || body.split("\n").length > 50_000) throw new Error("Calendar feed is too large");
  const parsed = await ical.async.parseICS(body);
  const from = new Date(Date.now() - 14 * 24 * 60 * 60_000);
  const to = new Date(Date.now() + 90 * 24 * 60 * 60_000);
  const events: CalendarEvent[] = [];
  let componentCount = 0;
  for (const component of Object.values(parsed)) {
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
    const instances = ical.expandRecurringEvent(component, { from, to, includeOverrides: true, excludeExdates: true, expandOngoing: true });
    for (const instance of instances) {
      const event = normalizeInstance(sourceId, workspaceId, uid, instance);
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
    id: String(row.id), workspaceId: String(row.workspace_id), provider: "ics", label: String(row.label),
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
  getDatabase().prepare(`INSERT INTO calendar_sources
    (id, workspace_id, provider, label, encrypted_url, status, created_at, updated_at)
    VALUES (?, ?, 'ics', ?, ?, 'pending', ?, ?)`)
    .run(id, input.workspaceId, label, encrypt(url.toString()), now, now);
  return publicSource(sourceRow(id)!);
}

export async function refreshCalendarSource(id: string) {
  const row = sourceRow(id);
  if (!row) throw new Error("Calendar source not found");
  const now = Date.now();
  const claimed = getDatabase().prepare(`UPDATE calendar_sources SET status='syncing', updated_at=?
    WHERE id=? AND (status!='syncing' OR updated_at < ?)`)
    .run(now, id, now - 15 * 60_000);
  if (Number(claimed.changes) !== 1) throw new Error("Calendar synchronization is already running");
  try {
    const body = await fetchCalendar(decrypt(String(row.encrypted_url)));
    const events = await parseCalendar(id, String(row.workspace_id), body);
    const database = getDatabase();
    database.exec("BEGIN IMMEDIATE");
    try {
      const sourceStillExists = database.prepare("SELECT 1 FROM calendar_sources WHERE id = ?").get(id);
      if (!sourceStillExists) throw new Error("Calendar source was disconnected during synchronization");
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
    const message = error instanceof Error ? error.message.slice(0, 500) : "Calendar refresh failed";
    getDatabase().prepare("UPDATE calendar_sources SET status='error', last_sync_at=?, last_error=?, updated_at=? WHERE id=?")
      .run(now, message, now, id);
    throw new Error(message);
  }
}

export async function processCalendarRefreshes(now = Date.now()) {
  const rows = getDatabase().prepare(`SELECT id FROM calendar_sources
    WHERE (status != 'syncing' OR updated_at <= ?)
      AND (last_sync_at IS NULL OR last_sync_at <= ?)
    ORDER BY COALESCE(last_sync_at, 0) LIMIT 2`).all(now - 15 * 60_000, now - 30 * 60_000);
  let refreshed = 0;
  for (const row of rows) {
    try { await refreshCalendarSource(String((row as { id: string }).id)); refreshed += 1; }
    catch { /* State is persisted without leaking the feed URL to logs. */ }
  }
  return { due: rows.length, refreshed };
}

/** After a restore: the event cache was emptied, so every restored source is fetched again. A failure is logged without the feed address. */
export async function refreshAllCalendarSources() {
  const rows = getDatabase().prepare("SELECT id FROM calendar_sources").all() as Array<{ id: string }>;
  for (const row of rows) {
    try { await refreshCalendarSource(String(row.id)); }
    catch (error) { console.error("Calendar refresh after a restore failed:", error instanceof Error ? error.message.slice(0, 200) : "error"); }
  }
}

export function deleteCalendarSource(id: string) {
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
  const events = listCalendarEvents(workspaceId, from, to).filter((event) => event.busy);
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
