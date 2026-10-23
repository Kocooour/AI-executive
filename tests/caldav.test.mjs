import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomBytes, scryptSync } from "node:crypto";
import test, { after, beforeEach } from "node:test";

// iCloud calendar over CalDAV (read-only). Everything runs against a fake iCloud transport: no network.
const dataDir = mkdtempSync(path.join(os.tmpdir(), "lumi-caldav-"));
process.env.AI_EXECUTIVE_DATA_DIR = dataDir;
process.env.AI_EXECUTIVE_AUTH_ENABLED = "true";
process.env.AI_EXECUTIVE_SESSION_SECRET = randomBytes(48).toString("base64");
const salt = randomBytes(16);
process.env.AI_EXECUTIVE_PASSWORD_HASH = `scrypt:${salt.toString("base64url")}:${scryptSync("owner-password-for-tests", salt, 64, { N: 16384, r: 8, p: 1 }).toString("base64url")}`;
process.env.AI_EXECUTIVE_INTEGRATION_TOKEN = randomBytes(32).toString("hex");
after(() => rmSync(dataDir, { recursive: true, force: true }));

const store = await import("../lib/server-store.ts");
const caldav = await import("../lib/caldav.ts");
const calendar = await import("../lib/calendar.ts");
const icloud = await import("../lib/icloud-calendar.ts");
const migrations = await import("../lib/schema-migrations.ts");
const auth = await import("../lib/auth.ts");
const icloudRoute = await import("../app/api/calendar/icloud/route.ts");
const calendarRoute = await import("../app/api/calendar/route.ts");

const db = () => store.getDatabase();
const count = (table, where = "1=1", ...args) => Number(db().prepare(`SELECT COUNT(*) AS value FROM ${table} WHERE ${where}`).get(...args).value);

// ---------------------------------------------------------------------------------------------------------------------
// A fake iCloud

const APPLE_ID = "jana.novakova@icloud.com";
const PASSWORD = "abcd-efgh-ijkl-mnop";
const DSID = "1234567890";
const HOME = `https://p42-caldav.icloud.com/${DSID}/calendars/`;
const day = 24 * 60 * 60_000;
const ymd = (time) => new Date(time).toISOString().slice(0, 10).replace(/-/g, "");
const tomorrow = ymd(Date.now() + day);
const inTwoDays = ymd(Date.now() + 2 * day);

const vevent = (uid, lines) => ["BEGIN:VEVENT", `UID:${uid}`, "DTSTAMP:20260101T000000Z", ...lines, "END:VEVENT"].join("\r\n");
const vcalendar = (...events) => ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Apple Inc.//iCloud//EN", ...events, "END:VCALENDAR"].join("\r\n");
const homeEvents = () => [
  vcalendar(vevent("weekly-1", [`DTSTART:${tomorrow}T090000Z`, `DTEND:${tomorrow}T100000Z`, "SUMMARY:Týdenní porada", "RRULE:FREQ=WEEKLY;COUNT=3"])),
  vcalendar(vevent("allday-1", [`DTSTART;VALUE=DATE:${inTwoDays}`, `DTEND;VALUE=DATE:${ymd(Date.now() + 3 * day)}`, "SUMMARY:Dovolená", "TRANSP:TRANSPARENT"])),
  vcalendar(vevent("cancelled-1", [`DTSTART:${tomorrow}T130000Z`, `DTEND:${tomorrow}T140000Z`, "SUMMARY:Zrušeno", "STATUS:CANCELLED"])),
  vcalendar(vevent("private-1", [`DTSTART:${tomorrow}T150000Z`, `DTEND:${tomorrow}T160000Z`, "SUMMARY:Lékař & vyšetření", "CLASS:PRIVATE"])),
];
const workEvents = () => [vcalendar(vevent("work-1", [`DTSTART:${tomorrow}T110000Z`, `DTEND:${tomorrow}T120000Z`, "SUMMARY:Klient <A&B>"]))];
const xmlEscape = (value) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Writes multistatus XML with configurable prefixes; `defaultDav` uses a default namespace for DAV: instead of a prefix. */
function writer({ d = "d", c = "c", defaultDav = false } = {}) {
  const D = (name) => defaultDav ? name : `${d}:${name}`;
  const ns = `${defaultDav ? 'xmlns="DAV:"' : `xmlns:${d}="DAV:"`} xmlns:${c}="urn:ietf:params:xml:ns:caldav" xmlns:ap="http://apple.com/ns/ical/" xmlns:cs="http://calendarserver.org/ns/"`;
  const response = (href, props, status = "HTTP/1.1 200 OK") =>
    `<${D("response")}><${D("href")}>${href}</${D("href")}><${D("propstat")}><${D("prop")}>${props}</${D("prop")}><${D("status")}>${status}</${D("status")}></${D("propstat")}></${D("response")}>`;
  return {
    D, C: (name) => `${c}:${name}`,
    multistatus: (...responses) => `<?xml version="1.0" encoding="UTF-8"?>\n<${D("multistatus")} ${ns}>${responses.join("")}</${D("multistatus")}>`,
    response,
  };
}

function fakeICloud({ appleId = APPLE_ID, password = PASSWORD, style = {}, home = homeEvents, work = workEvents, hook } = {}) {
  const log = [];
  const state = { expected: `Basic ${Buffer.from(`${appleId}:${password}`).toString("base64")}`, home, work };
  const w = writer(style);
  const { D, C } = w;
  const ok = (body) => ({ status: 207, location: null, body });
  const calendarsXml = () => w.multistatus(
    w.response(`/${DSID}/calendars/`, `<${D("resourcetype")}><${D("collection")}/></${D("resourcetype")}>`),
    w.response(`/${DSID}/calendars/home/`, `<${D("resourcetype")}><${D("collection")}/><${C("calendar")}/></${D("resourcetype")}><${D("displayname")}>Domov &amp; rodina</${D("displayname")}>`
      + `<${C("supported-calendar-component-set")}><${C("comp")} name="VEVENT"/></${C("supported-calendar-component-set")}><ap:calendar-color>#FF2968FF</ap:calendar-color><cs:getctag>ctag-1</cs:getctag>`),
    w.response(`https://p42-caldav.icloud.com:443/${DSID}/calendars/work/`, `<${D("resourcetype")}><${D("collection")}/><${C("calendar")}/></${D("resourcetype")}><${D("displayname")}>Práce</${D("displayname")}>`
      + `<${C("supported-calendar-component-set")}><${C("comp")} name="VEVENT"/><${C("comp")} name="VTODO"/></${C("supported-calendar-component-set")}>`),
    w.response(`/${DSID}/calendars/tasks/`, `<${D("resourcetype")}><${D("collection")}/><${C("calendar")}/></${D("resourcetype")}><${D("displayname")}>Připomínky</${D("displayname")}>`
      + `<${C("supported-calendar-component-set")}><${C("comp")} name="VTODO"/></${C("supported-calendar-component-set")}>`),
    w.response(`/${DSID}/calendars/inbox/`, `<${D("resourcetype")}><${D("collection")}/><${C("schedule-inbox")}/></${D("resourcetype")}>`),
    w.response(`/${DSID}/calendars/notification/`, `<${D("resourcetype")}><${D("collection")}/><cs:notification/></${D("resourcetype")}>`),
  );
  const report = (bodies) => w.multistatus(...bodies.map((body, index) => w.response(`/${DSID}/calendars/x/${index}.ics`,
    `<${D("getetag")}>"${index}"</${D("getetag")}><${C("calendar-data")}>${index % 2 ? `<![CDATA[${body}]]>` : xmlEscape(body)}</${C("calendar-data")}>`)));
  const transport = async (request) => {
    log.push({ url: request.url.toString(), method: request.method, authorization: request.headers.Authorization, depth: request.headers.Depth, body: request.body });
    if (hook) { const answer = await hook(request, log); if (answer) return answer; }
    if (request.headers.Authorization !== state.expected) return { status: 401, location: null, body: "" };
    const url = request.url.toString();
    if (request.method === "PROPFIND" && url === "https://caldav.icloud.com/") {
      return ok(w.multistatus(w.response("/", `<${D("current-user-principal")}><${D("href")}>/${DSID}/principal/</${D("href")}></${D("current-user-principal")}>`)));
    }
    if (request.method === "PROPFIND" && url === `https://caldav.icloud.com/${DSID}/principal/`) {
      return ok(w.multistatus(w.response(`/${DSID}/principal/`, `<${C("calendar-home-set")}><${D("href")}>https://p42-caldav.icloud.com:443/${DSID}/calendars/</${D("href")}></${C("calendar-home-set")}>`)));
    }
    if (request.method === "PROPFIND" && url === HOME) return ok(calendarsXml());
    if (request.method === "REPORT" && url === `${HOME}home/`) return ok(report(state.home()));
    if (request.method === "REPORT" && url === `${HOME}work/`) return ok(report(state.work()));
    return { status: 404, location: null, body: "" };
  };
  return {
    log, state,
    options: { transport, startUrl: new URL(caldav.ICLOUD_CALDAV_START), extraOrigin: null },
    setPassword(value) { state.expected = `Basic ${Buffer.from(`${appleId}:${value}`).toString("base64")}`; },
  };
}

const credentials = { username: APPLE_ID, password: PASSWORD };

// ---------------------------------------------------------------------------------------------------------------------
// Routes

const sessionToken = auth.createSessionToken();
let clientCounter = 0;
function routeRequest(method, body, { origin = "http://localhost:3000", session = true, headers = {} } = {}) {
  clientCounter += 1;
  return new Request("http://localhost:3000/api/calendar/icloud", {
    method,
    headers: {
      ...(method === "POST" ? { "content-type": "application/json" } : {}),
      ...(origin ? { origin } : {}),
      ...(session ? { cookie: `ai_executive_session=${sessionToken}` } : {}),
      "x-forwarded-for": `10.77.${Math.floor(clientCounter / 200)}.${(clientCounter % 200) + 1}`,
      "x-lumi-restore-generation": String(store.readSnapshot().restoreGeneration ?? 0),
      ...headers,
    },
    body: method === "POST" ? JSON.stringify(body) : undefined,
  });
}
const post = async (body, options) => {
  const response = await icloudRoute.POST(routeRequest("POST", body, options));
  return { status: response.status, headers: response.headers, text: await response.text() };
};
const getState = async () => JSON.parse(await (await icloudRoute.GET(routeRequest("GET"))).text());

function ensureWorkspace(id, title) {
  const snapshot = store.readSnapshot();
  if (snapshot.entities.some((entity) => entity.type === "workspace" && entity.workspaceId === id)) return;
  const personal = snapshot.entities.find((entity) => entity.id === "workspace:personal");
  const entity = { ...personal, id: `workspace:${id}`, workspaceId: id, title, properties: { kind: "shared", role: "owner", members: [{ id: "owner", role: "owner" }] } };
  const result = store.replaceSnapshot(snapshot.revision, [...snapshot.entities, entity], snapshot.relations, [], [], snapshot.restoreGeneration);
  assert.equal(result.conflict, false);
}

function dumpDatabase() {
  const tables = db().prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name);
  return tables.map((table) => JSON.stringify(db().prepare(`SELECT * FROM "${table}"`).all())).join("\n");
}

function resetCalDav() {
  db().exec("DELETE FROM calendar_events WHERE source_id IN (SELECT id FROM calendar_sources WHERE provider = 'caldav'); DELETE FROM calendar_sources WHERE provider = 'caldav'; DELETE FROM calendar_accounts");
}

beforeEach(() => { calendar.setCalDavOptionsForTests(null); });

// ---------------------------------------------------------------------------------------------------------------------

test("the migration creates calendar_accounts and calendar_sources.account_id, and running it again changes nothing", () => {
  const columns = db().prepare("PRAGMA table_info(calendar_sources)").all().map((row) => row.name);
  assert.ok(columns.includes("account_id"));
  const accountColumns = db().prepare("PRAGMA table_info(calendar_accounts)").all().map((row) => row.name);
  for (const column of ["id", "provider", "label", "encrypted_credentials", "principal_url", "home_url", "status", "last_error", "last_success_at", "revision", "created_at", "updated_at"]) {
    assert.ok(accountColumns.includes(column), column);
  }
  assert.deepEqual(migrations.runSchemaMigrations(db()), []);
  // The step itself is idempotent too (a database that has the column already, e.g. after a partial manual repair).
  const migration = migrations.schemaMigrations.find((item) => item.id === "2026-10-calendar-accounts-caldav");
  const scratch = new DatabaseSync(":memory:");
  scratch.exec("CREATE TABLE calendar_sources (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, provider TEXT NOT NULL, label TEXT NOT NULL, encrypted_url TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)");
  scratch.exec("INSERT INTO calendar_sources VALUES ('ics-1', 'personal', 'ics', 'Feed', 'x', 'ready', 1, 1)");
  migration.up(scratch);
  migration.up(scratch);
  assert.deepEqual(scratch.prepare("SELECT id, provider, account_id FROM calendar_sources").all().map((row) => ({ ...row })), [{ id: "ics-1", provider: "ics", account_id: null }]);
  scratch.close();
});

test("discovery follows principal → calendar home → collections and keeps only calendars that hold events", async () => {
  const fake = fakeICloud();
  const discovery = await caldav.discoverCalendars(credentials, fake.options);
  assert.equal(discovery.principalUrl, `https://caldav.icloud.com/${DSID}/principal/`);
  assert.equal(discovery.homeUrl, HOME);
  assert.deepEqual(discovery.calendars.map((item) => item.displayName), ["Domov & rodina", "Práce"]);
  assert.equal(discovery.calendars[0].url, `${HOME}home/`);
  assert.equal(discovery.calendars[0].color, "#FF2968");
  assert.equal(discovery.calendars[0].ctag, "ctag-1");
  assert.equal(discovery.calendars[1].url, `${HOME}work/`);
  assert.equal(discovery.calendars[0].id, caldav.calendarKey(`${HOME}home/`));
  assert.ok(!discovery.calendars[0].id.includes(DSID));
  assert.deepEqual(fake.log.map((entry) => [entry.method, entry.depth]), [["PROPFIND", "0"], ["PROPFIND", "0"], ["PROPFIND", "1"]]);
  for (const entry of fake.log) assert.equal(entry.authorization, `Basic ${Buffer.from(`${APPLE_ID}:${PASSWORD}`).toString("base64")}`);
});

test("namespaces are matched by URI, not by prefix (default namespace, other prefixes)", async () => {
  for (const style of [{ defaultDav: true, c: "cal" }, { d: "D", c: "C" }, { d: "x0", c: "x1" }]) {
    const discovery = await caldav.discoverCalendars(credentials, fakeICloud({ style }).options);
    assert.deepEqual(discovery.calendars.map((item) => item.displayName), ["Domov & rodina", "Práce"], JSON.stringify(style));
  }
  // A prefix bound to another namespace does not count as DAV: even when it is spelled "d".
  const wrong = `<?xml version="1.0"?><d:multistatus xmlns:d="urn:example:not-dav"><d:response><d:href>/x/</d:href></d:response></d:multistatus>`;
  await assert.rejects(caldav.discoverCalendars(credentials, { ...fakeICloud().options, transport: async () => ({ status: 207, location: null, body: wrong }) }), /unreadable/);
});

test("REPORT data becomes events identical in shape to an ICS feed: recurrence, all-day, cancelled dropped, private masked", async () => {
  const fake = fakeICloud();
  const range = calendar.calendarWindow();
  const bodies = await caldav.fetchCalendarObjects(credentials, `${HOME}home/`, range, fake.options);
  assert.equal(bodies.length, 4);
  const report = fake.log.at(-1);
  assert.equal(report.method, "REPORT");
  assert.equal(report.depth, "1");
  assert.match(report.body, /<c:time-range start="\d{8}T\d{6}Z" end="\d{8}T\d{6}Z"\/>/);
  const fromCalDav = await calendar.parseCalendar("source-1", "personal", bodies);
  // The same events as one ICS feed.
  const feed = vcalendar(...homeEvents().map((body) => body.split("\r\n").slice(3, -1).join("\r\n")));
  const fromIcs = await calendar.parseCalendar("source-1", "personal", feed);
  const sort = (events) => [...events].sort((a, b) => a.occurrenceKey.localeCompare(b.occurrenceKey));
  assert.deepEqual(sort(fromCalDav), sort(fromIcs));
  assert.equal(fromCalDav.filter((event) => event.uid === "weekly-1").length, 3);
  const allDay = fromCalDav.find((event) => event.uid === "allday-1");
  assert.equal(allDay.allDay, true);
  assert.equal(allDay.busy, false);
  assert.equal(fromCalDav.some((event) => event.uid === "cancelled-1"), false);
  const privateEvent = fromCalDav.find((event) => event.uid === "private-1");
  assert.equal(privateEvent.title, "Soukromá událost");
  assert.equal(privateEvent.private, true);
  assert.ok(!JSON.stringify(fromCalDav).includes("Lékař"));
  assert.deepEqual(Object.keys(fromCalDav[0]).sort(), ["allDay", "busy", "end", "id", "occurrenceKey", "private", "recurring", "sourceId", "start", "status", "timezone", "title", "transparency", "uid", "workspaceId"]);
  // Whether an event repeats comes from its definition.
  assert.ok(fromCalDav.filter((event) => event.uid === "weekly-1").every((event) => event.recurring === true));
  assert.equal(allDay.recurring, false);
  // A yearly series has one repeat in the cached window and is still recurring.
  const yearly = await calendar.parseCalendar("s", "personal", vcalendar(vevent("yearly-1", [`DTSTART:${tomorrow}T090000Z`, `DTEND:${tomorrow}T100000Z`, "SUMMARY:Výroční schůzka", "RRULE:FREQ=YEARLY"])));
  assert.equal(yearly.length, 1);
  assert.equal(yearly[0].recurring, true);
  // Escaped text and CDATA both arrive as the original iCalendar text.
  const work = await caldav.fetchCalendarObjects(credentials, `${HOME}work/`, range, fake.options);
  assert.equal((await calendar.parseCalendar("s", "personal", work))[0].title, "Klient <A&B>");
});

test("only iCloud hosts are allowed; a redirect or an href elsewhere is refused before anything is sent there", async () => {
  const allowed = ["https://caldav.icloud.com/", "https://p42-caldav.icloud.com/1/", "https://p01-caldav.icloud.com:443/x", "https://CALDAV.icloud.com/"];
  const refused = ["http://caldav.icloud.com/", "https://caldav.icloud.com:8443/", "https://evil.example/", "https://caldav.icloud.com.evil.example/",
    "https://p42-caldav.icloud.com.evil.example/", "https://user:pw@caldav.icloud.com/", "https://px-caldav.icloud.com/", "https://icloud.com/", "https://127.0.0.1/"];
  for (const url of allowed) assert.equal(caldav.isAllowedCalDavUrl(new URL(url)), true, url);
  for (const url of refused) assert.equal(caldav.isAllowedCalDavUrl(new URL(url)), false, url);

  // A redirect to another host: refused, and no request (with or without the Authorization header) reaches it.
  const redirected = fakeICloud({ hook: async (request) => request.url.hostname === "caldav.icloud.com" ? { status: 301, location: "https://evil.example/steal", body: "" } : null });
  await assert.rejects(caldav.discoverCalendars(credentials, redirected.options), (error) => error instanceof caldav.CalDavError && /outside iCloud/.test(error.message));
  assert.deepEqual(redirected.log.map((entry) => new URL(entry.url).hostname), ["caldav.icloud.com"]);

  // A principal pointing to another host.
  const foreignHref = fakeICloud({ hook: async (request) => request.url.toString() === "https://caldav.icloud.com/"
    ? { status: 207, location: null, body: writer().multistatus(writer().response("/", "<d:current-user-principal><d:href>https://evil.example/p/</d:href></d:current-user-principal>")) } : null });
  await assert.rejects(caldav.discoverCalendars(credentials, foreignHref.options), /outside iCloud/);
  assert.ok(foreignHref.log.every((entry) => caldav.isAllowedCalDavUrl(new URL(entry.url))));

  // A redirect to an iCloud partition is followed (with the header), up to three times.
  let hops = 0;
  const partition = fakeICloud({ hook: async (request) => request.url.toString() === "https://caldav.icloud.com/" && hops++ === 0 ? { status: 302, location: "https://p07-caldav.icloud.com/", body: "" }
    : request.url.toString() === "https://p07-caldav.icloud.com/" ? { status: 307, location: "https://caldav.icloud.com/", body: "" } : null });
  assert.equal((await caldav.discoverCalendars(credentials, partition.options)).calendars.length, 2);
  const loop = fakeICloud({ hook: async () => ({ status: 302, location: "https://p01-caldav.icloud.com/", body: "" }) });
  await assert.rejects(caldav.discoverCalendars(credentials, loop.options), /redirected too many times/);
  assert.equal(loop.log.length, 4);
});

test("a 401 or 403 is an authentication failure; other failures are fixed messages without addresses", async () => {
  await assert.rejects(caldav.discoverCalendars({ username: APPLE_ID, password: "wron-gpas-swor-dxxx" }, fakeICloud().options), (error) => error instanceof caldav.CalDavAuthError);
  await assert.rejects(caldav.discoverCalendars(credentials, fakeICloud({ hook: async () => ({ status: 403, location: null, body: "" }) }).options), (error) => error instanceof caldav.CalDavAuthError);
  await assert.rejects(caldav.discoverCalendars(credentials, fakeICloud({ hook: async () => ({ status: 503, location: null, body: "" }) }).options), /^Error: iCloud server returned an error$|iCloud server returned an error/);
  await assert.rejects(caldav.discoverCalendars(credentials, fakeICloud({ hook: async () => { throw new Error(`connect ECONNREFUSED p42-caldav.icloud.com/${DSID}`); } }).options),
    (error) => error.message === "iCloud could not be reached");
  await assert.rejects(caldav.fetchCalendarObjects(credentials, `${HOME}gone/`, calendar.calendarWindow(), fakeICloud().options), /no longer exists/);
});

test("a document type (XXE) and malformed XML are refused", () => {
  const xxe = `<?xml version="1.0"?><!DOCTYPE d [<!ENTITY x SYSTEM "file:///etc/passwd">]><d:multistatus xmlns:d="DAV:"><d:response><d:href>&x;</d:href></d:response></d:multistatus>`;
  assert.throws(() => caldav.parseDavXml(xxe), /unreadable/);
  assert.throws(() => caldav.parseDavXml(`<!doctype x><x/>`), /unreadable/);
  assert.throws(() => caldav.parseDavXml(`<d:multistatus xmlns:d="DAV:"><d:response></d:multistatus>`), /unreadable/);
  assert.throws(() => caldav.parseDavXml(`not xml at all`), /unreadable/);
  // A document type inside the body markup is refused too; inside CDATA it is data.
  assert.throws(() => caldav.parseDavXml(`<d:a xmlns:d="DAV:"><!DOCTYPE x></d:a>`), /unreadable/);
  const cdata = caldav.parseDavXml(`<?xml version="1.0"?><d:a xmlns:d="DAV:"><![CDATA[<!DOCTYPE html> <!ENTITY x "y">]]></d:a>`);
  assert.equal(cdata.text, `<!DOCTYPE html> <!ENTITY x "y">`);
  // Predefined and numeric entities are decoded once.
  const parsed = caldav.parseDavXml(`<d:a xmlns:d="DAV:">A &amp;#65; &#66; &lt;&gt;</d:a>`);
  assert.equal(parsed.text, "A &#65; B <>");
});

test("an event whose description contains a document type in CDATA is kept", async () => {
  const body = vcalendar(vevent("doctype-1", [`DTSTART:${tomorrow}T070000Z`, `DTEND:${tomorrow}T073000Z`, "SUMMARY:Newsletter", "DESCRIPTION:<!DOCTYPE html><html>…</html>"]));
  const fake = fakeICloud({ home: () => [body, body.replace("doctype-1", "doctype-2")] });
  const bodies = await caldav.fetchCalendarObjects(credentials, `${HOME}home/`, calendar.calendarWindow(), fake.options);
  assert.equal(bodies.length, 2);
  // The second resource went as CDATA (odd index in the fake), the first escaped; both survive.
  const events = await calendar.parseCalendar("s", "personal", bodies);
  assert.deepEqual(events.map((event) => event.uid).sort(), ["doctype-1", "doctype-2"]);
});

test("size and count limits hold for PROPFIND, REPORT and the calendar as a whole", async () => {
  const huge = "x".repeat(caldav.MAX_PROPFIND_BYTES + 1);
  await assert.rejects(caldav.discoverCalendars(credentials, fakeICloud({ hook: async () => ({ status: 207, location: null, body: huge }) }).options), /too large/);
  await assert.rejects(caldav.fetchCalendarObjects(credentials, `${HOME}home/`, calendar.calendarWindow(),
    fakeICloud({ hook: async (request) => request.method === "REPORT" ? { status: 207, location: null, body: huge } : null }).options), /too large/);
  const many = Array.from({ length: caldav.MAX_CALENDAR_RESOURCES + 1 }, (_, index) => vcalendar(vevent(`m${index}`, [`DTSTART:${tomorrow}T080000Z`, "SUMMARY:x"])));
  const tooMany = fakeICloud({ hook: async (request) => request.method === "REPORT"
    ? { status: 207, location: null, body: writer().multistatus(...many.map((body, index) => writer().response(`/${index}.ics`, `<c:calendar-data>${body}</c:calendar-data>`))) } : null });
  await assert.rejects(caldav.fetchCalendarObjects(credentials, `${HOME}home/`, calendar.calendarWindow(), tooMany.options), /too large|too many components/);
  // Across several bodies the existing ICS limits apply to the total.
  const big = vcalendar(vevent("big", [`DTSTART:${tomorrow}T080000Z`, `SUMMARY:${"y".repeat(1024 * 1024)}`]));
  await assert.rejects(calendar.parseCalendar("s", "personal", [big, big, big]), /Calendar feed is too large/);
  // 5001 events spread over two resources: each alone is within the limit, together they are not.
  const half = (offset) => vcalendar(...Array.from({ length: 2501 }, (_, index) => vevent(`c${offset + index}`, [`DTSTART:${tomorrow}T080000Z`, `DTEND:${tomorrow}T081000Z`])));
  await calendar.parseCalendar("s", "personal", [half(0)]);
  await assert.rejects(calendar.parseCalendar("s", "personal", [half(0), half(10_000)]), /too many (components|occurrences)/);
});

test("connect through the route stores an encrypted account with masked label; no secret reaches the database, a response or the security log", async () => {
  resetCalDav();
  ensureWorkspace("work", "Work");
  const fake = fakeICloud();
  calendar.setCalDavOptionsForTests(fake.options);
  const discovered = await post({ action: "discover", appleId: APPLE_ID, appPassword: "ABCDEFGHIJKLMNOP" });
  assert.equal(discovered.status, 200, discovered.text);
  assert.equal(discovered.headers.get("cache-control"), "no-store");
  const { calendars } = JSON.parse(discovered.text);
  assert.deepEqual(calendars.map((item) => item.name), ["Domov & rodina", "Práce"]);
  assert.equal(count("calendar_accounts"), 0, "discover stores nothing");
  const connected = await post({ action: "connect", appleId: APPLE_ID, appPassword: PASSWORD, calendars: [
    { id: calendars[0].id, workspaceId: "personal" }, { id: calendars[1].id, workspaceId: "work" }] });
  assert.equal(connected.status, 200, connected.text);
  const { account } = JSON.parse(connected.text);
  assert.equal(account.label, "j***@icloud.com");
  assert.equal(account.status, "ready");
  assert.deepEqual(account.calendars.map((item) => [item.label, item.workspaceId, item.eventCount]), [["Domov & rodina", "personal", 5], ["Práce", "work", 1]]);
  // Events are in the cache in the usual shape, per workspace, and planning sees a fresh calendar.
  const now = Date.now();
  const personalEvents = calendar.listCalendarEvents("personal", now - day, now + 30 * day);
  assert.ok(personalEvents.some((event) => event.title === "Týdenní porada"));
  assert.ok(calendar.listCalendarEvents("work", now - day, now + 30 * day).every((event) => event.title === "Klient <A&B>"));
  const caldavSources = calendar.listCalendarSources().filter((source) => source.provider === "caldav");
  assert.equal(caldavSources.length, 2);
  assert.ok(caldavSources.every((source) => source.status === "ready" && source.accountId));
  assert.equal(calendar.calendarAvailability("personal", new Date(now + day).toISOString().slice(0, 10), "UTC", "08:00", "18:00").fresh, true);

  const secrets = [APPLE_ID, "jana.novakova", PASSWORD, PASSWORD.replace(/-/g, ""), DSID, "p42-caldav", "caldav.icloud.com"];
  const everything = [dumpDatabase(), discovered.text, connected.text, JSON.stringify(await getState())].join("\n");
  for (const secret of secrets) assert.ok(!everything.includes(secret), `${secret} leaked`);
  const events = db().prepare("SELECT action, outcome, details FROM security_events WHERE action LIKE 'calendar.icloud.%'").all();
  assert.ok(events.some((event) => event.action === "calendar.icloud.connect" && event.outcome === "allowed"));
  // The credential round-trips through the encryption.
  const row = db().prepare("SELECT * FROM calendar_accounts").get();
  assert.deepEqual(calendar.calDavCredentials(row), credentials);
  // A second account is refused.
  const second = await post({ action: "connect", appleId: APPLE_ID, appPassword: PASSWORD, calendars: [{ id: calendars[0].id, workspaceId: "personal" }] });
  assert.equal(second.status, 400);
  assert.equal(JSON.parse(second.text).error, "An iCloud account is already connected");
  assert.equal(count("calendar_accounts"), 1);
});

test("a wrong password is refused with a clear message and stores nothing; malformed input is refused before Apple is asked", async () => {
  resetCalDav();
  const fake = fakeICloud();
  calendar.setCalDavOptionsForTests(fake.options);
  const before = count("calendar_sources");
  const wrong = await post({ action: "connect", appleId: APPLE_ID, appPassword: "wxyz-wxyz-wxyz-wxyz", calendars: [{ id: "x", workspaceId: "personal" }] });
  assert.equal(wrong.status, 400);
  assert.equal(JSON.parse(wrong.text).error, "Apple refused the app-specific password");
  assert.equal(JSON.parse(wrong.text).code, "auth");
  assert.equal(count("calendar_accounts"), 0);
  assert.equal(count("calendar_sources"), before);
  assert.ok(!dumpDatabase().includes("wxyz-wxyz"));
  assert.ok(db().prepare("SELECT 1 FROM security_events WHERE action = 'calendar.icloud.connect' AND outcome = 'rejected'").get());
  const requests = fake.log.length;
  for (const [appleId, appPassword, message] of [["no-at-sign", PASSWORD, "Apple ID is invalid"], [APPLE_ID, "short", "App-specific password must look like xxxx-xxxx-xxxx-xxxx"],
    [APPLE_ID, "abcd-efgh-ijkl-mno1", "App-specific password must look like xxxx-xxxx-xxxx-xxxx"], [`${"a".repeat(250)}@x.cz`, PASSWORD, "Apple ID is invalid"]]) {
    const refused = await post({ action: "discover", appleId, appPassword });
    assert.equal(refused.status, 400);
    assert.equal(JSON.parse(refused.text).error, message);
  }
  assert.equal(fake.log.length, requests, "Apple was not asked for malformed input");
  // A connect with an unknown calendar id (an address from the client is never used) stores nothing.
  const unknown = await post({ action: "connect", appleId: APPLE_ID, appPassword: PASSWORD, calendars: [{ id: "https://evil.example/cal/", workspaceId: "personal" }] });
  assert.equal(JSON.parse(unknown.text).error, "A selected calendar is no longer available in iCloud");
  assert.equal(count("calendar_accounts"), 0);
});

test("a refused password stops automatic refreshes until it is replaced; replacing it recovers", async () => {
  resetCalDav();
  const fake = fakeICloud();
  calendar.setCalDavOptionsForTests(fake.options);
  const discovery = await caldav.discoverCalendars(credentials, fake.options);
  const accountId = icloud.storeICloudAccount(credentials, discovery, [{ id: discovery.calendars[0].id, workspaceId: "personal" }]);
  await calendar.refreshCalDavAccount(accountId);
  assert.equal(icloud.getICloudAccountState().status, "ready");
  // The owner revokes the password at Apple.
  fake.setPassword("newp-assw-ordx-xxxx");
  db().exec("UPDATE calendar_sources SET last_sync_at = 0 WHERE provider = 'caldav'");
  await calendar.processCalendarRefreshes();
  const state = icloud.getICloudAccountState();
  assert.equal(state.status, "auth_failed");
  assert.equal(state.lastError, "Apple refused the app-specific password");
  assert.ok(state.calendars.every((item) => item.lastError === "Apple refused the app-specific password"));
  // The scheduler does not contact Apple again for this account.
  const requests = fake.log.length;
  db().exec("UPDATE calendar_sources SET last_sync_at = 0 WHERE provider = 'caldav'");
  await calendar.processCalendarRefreshes(Date.now() + 2 * 60 * 60_000);
  await calendar.processCalendarRefreshes(Date.now() + 4 * 60 * 60_000);
  assert.equal(fake.log.length, requests);
  // Neither does a manual refresh or a calendar listing.
  const manual = await post({ action: "refresh" });
  assert.equal(manual.status, 502);
  assert.equal(JSON.parse(manual.text).code, "auth");
  assert.equal((await post({ action: "calendars" })).status, 400);
  assert.equal(fake.log.length, requests);
  // Planning treats the calendar as not fresh.
  assert.equal(calendar.calendarAvailability("personal", new Date(Date.now() + day).toISOString().slice(0, 10), "UTC", "08:00", "18:00").fresh, false);
  // A wrong new password is refused and changes nothing; the right one recovers.
  const stillWrong = await post({ action: "update-password", appPassword: "abcd-abcd-abcd-abcd" });
  assert.equal(stillWrong.status, 400);
  assert.equal(icloud.getICloudAccountState().status, "auth_failed");
  const fixed = await post({ action: "update-password", appPassword: "newp-assw-ordx-xxxx" });
  assert.equal(fixed.status, 200, fixed.text);
  const recovered = JSON.parse(fixed.text).account;
  assert.equal(recovered.status, "ready");
  assert.ok(recovered.calendars.every((item) => item.status === "ready" && item.lastError === ""));
  assert.equal(calendar.calDavCredentials(db().prepare("SELECT * FROM calendar_accounts").get()).password, "newp-assw-ordx-xxxx");
  assert.ok(!dumpDatabase().includes("newp-assw-ordx-xxxx"));
});

test("select changes calendars and workspaces; a calendar that moves is fetched again into its new workspace", async () => {
  resetCalDav();
  ensureWorkspace("work", "Work");
  const fake = fakeICloud();
  calendar.setCalDavOptionsForTests(fake.options);
  const discovery = await caldav.discoverCalendars(credentials, fake.options);
  const [home, work] = discovery.calendars;
  const accountId = icloud.storeICloudAccount(credentials, discovery, [{ id: home.id, workspaceId: "personal" }]);
  await calendar.refreshCalDavAccount(accountId);
  const listed = JSON.parse((await post({ action: "calendars" })).text).calendars;
  assert.deepEqual(listed.map((item) => [item.name, item.selected, item.workspaceId]), [["Domov & rodina", true, "personal"], ["Práce", false, null]]);
  const changed = await post({ action: "select", calendars: [{ id: home.id, workspaceId: "work" }, { id: work.id, workspaceId: "personal" }] });
  assert.equal(changed.status, 200, changed.text);
  const now = Date.now();
  assert.ok(calendar.listCalendarEvents("work", now - day, now + 30 * day).some((event) => event.title === "Týdenní porada"));
  const personal = calendar.listCalendarEvents("personal", now - day, now + 30 * day);
  assert.ok(personal.length > 0 && personal.every((event) => event.title === "Klient <A&B>"));
  assert.deepEqual(JSON.parse(changed.text).account.calendars.map((item) => [item.label, item.workspaceId]).sort(), [["Domov & rodina", "work"], ["Práce", "personal"]]);
  // Removing a calendar removes its events.
  await post({ action: "select", calendars: [{ id: work.id, workspaceId: "personal" }] });
  assert.equal(calendar.listCalendarEvents("work", now - day, now + 30 * day).length, 0);
  assert.equal((await post({ action: "select", calendars: [] })).status, 400);
});

test("disconnect removes the account, its calendars and their events in one transaction, and leaves ICS sources alone", async () => {
  resetCalDav();
  const fake = fakeICloud();
  calendar.setCalDavOptionsForTests(fake.options);
  db().prepare(`INSERT INTO calendar_sources (id, workspace_id, provider, label, encrypted_url, status, created_at, updated_at) VALUES ('ics-keep', 'personal', 'ics', 'Feed', ?, 'ready', 1, 1)`).run(calendar.encrypt("https://example.com/feed.ics"));
  db().prepare(`INSERT INTO calendar_events (id, source_id, workspace_id, occurrence_key, payload, start_at, end_at, updated_at) VALUES ('ics-event', 'ics-keep', 'personal', 'k', '{}', 1, 2, 1)`).run();
  const discovery = await caldav.discoverCalendars(credentials, fake.options);
  const accountId = icloud.storeICloudAccount(credentials, discovery, discovery.calendars.map((item) => ({ id: item.id, workspaceId: "personal" })));
  await calendar.refreshCalDavAccount(accountId);
  assert.ok(count("calendar_events", "source_id IN (SELECT id FROM calendar_sources WHERE account_id = ?)", accountId) > 0);
  // A failure in the middle rolls everything back.
  db().exec(`CREATE TRIGGER fail_account_delete BEFORE DELETE ON calendar_accounts BEGIN SELECT RAISE(ABORT, 'boom'); END`);
  assert.throws(() => icloud.disconnectICloud(accountId), /boom/);
  db().exec("DROP TRIGGER fail_account_delete");
  assert.equal(count("calendar_sources", "account_id = ?", accountId), 2);
  assert.ok(count("calendar_events", "source_id IN (SELECT id FROM calendar_sources WHERE account_id = ?)", accountId) > 0);
  const accountSources = db().prepare("SELECT id FROM calendar_sources WHERE account_id = ?").all(accountId).map((row) => row.id);
  const removed = await post({ action: "disconnect" });
  assert.equal(removed.status, 200);
  assert.equal(count("calendar_accounts"), 0);
  assert.equal(count("calendar_sources", "provider = 'caldav'"), 0);
  for (const id of accountSources) assert.equal(count("calendar_events", "source_id = ?", id), 0);
  assert.equal(count("calendar_sources", "id = 'ics-keep'"), 1);
  assert.equal(count("calendar_events", "id = 'ics-event'"), 1);
  assert.equal((await getState()).account, null);
  db().exec("DELETE FROM calendar_events WHERE source_id = 'ics-keep'; DELETE FROM calendar_sources WHERE id = 'ics-keep'");
});

test("a restore keeps the account and its calendars, clears their events and fetches them again", async () => {
  resetCalDav();
  const fake = fakeICloud();
  calendar.setCalDavOptionsForTests(fake.options);
  const discovery = await caldav.discoverCalendars(credentials, fake.options);
  const accountId = icloud.storeICloudAccount(credentials, discovery, [{ id: discovery.calendars[0].id, workspaceId: "personal" }]);
  await calendar.refreshCalDavAccount(accountId);
  const backup = store.createBackup("manual");
  // After the backup: the account is removed.
  icloud.disconnectICloud(accountId);
  store.restoreBackup(backup.name);
  assert.equal(count("calendar_accounts"), 1);
  assert.equal(count("calendar_sources", "provider = 'caldav' AND account_id = ?", accountId), 1);
  assert.equal(count("calendar_events"), 0);
  assert.deepEqual(calendar.calDavCredentials(calendar.calDavAccountRow(accountId)), credentials);
  await calendar.refreshAllCalendarSources();
  assert.ok(count("calendar_events") > 0);
  assert.equal(icloud.getICloudAccountState().status, "ready");
});

test("a restore that lands while iCloud is being asked makes connect write nothing (fence after discovery)", async () => {
  resetCalDav();
  const backup = store.createBackup("manual");
  let restored = false;
  const fake = fakeICloud({ hook: async () => { if (!restored) { restored = true; store.restoreBackup(backup.name); } return null; } });
  calendar.setCalDavOptionsForTests(fake.options);
  const discovery = await caldav.discoverCalendars(credentials, fakeICloud().options);
  restored = false;
  const answer = await post({ action: "connect", appleId: APPLE_ID, appPassword: PASSWORD, calendars: [{ id: discovery.calendars[0].id, workspaceId: "personal" }] });
  assert.equal(restored, true);
  assert.equal(answer.status, 409);
  assert.equal(JSON.parse(answer.text).code, "restored");
  assert.equal(count("calendar_accounts"), 0);
});

test("a refused password found while listing calendars is not recorded when a restore landed meanwhile (fence)", async () => {
  resetCalDav();
  const fake = fakeICloud();
  calendar.setCalDavOptionsForTests(fake.options);
  const discovery = await caldav.discoverCalendars(credentials, fake.options);
  const accountId = icloud.storeICloudAccount(credentials, discovery, [{ id: discovery.calendars[0].id, workspaceId: "personal" }]);
  const backup = store.createBackup("manual");
  const before = { ...db().prepare("SELECT status, revision, updated_at FROM calendar_accounts WHERE id = ?").get(accountId) };
  let restored = false;
  calendar.setCalDavOptionsForTests({ ...fake.options, transport: async () => {
    if (!restored) { restored = true; store.restoreBackup(backup.name); }
    return { status: 401, location: null, body: "" };
  } });
  const answer = await post({ action: "calendars" });
  assert.equal(restored, true);
  assert.equal(answer.status, 409);
  assert.equal(JSON.parse(answer.text).code, "restored");
  assert.deepEqual({ ...db().prepare("SELECT status, revision, updated_at FROM calendar_accounts WHERE id = ?").get(accountId) }, before);
  // Without a restore the refusal is recorded.
  calendar.setCalDavOptionsForTests({ ...fake.options, transport: async () => ({ status: 401, location: null, body: "" }) });
  assert.equal((await post({ action: "select", calendars: [] })).status, 400);
  assert.equal(icloud.getICloudAccountState().status, "auth_failed");
});

test("a refresh that ends after the password was replaced does not overwrite the new account state", async () => {
  resetCalDav();
  const fake = fakeICloud();
  calendar.setCalDavOptionsForTests(fake.options);
  const discovery = await caldav.discoverCalendars(credentials, fake.options);
  const accountId = icloud.storeICloudAccount(credentials, discovery, [{ id: discovery.calendars[0].id, workspaceId: "personal" }]);
  const replaced = { username: APPLE_ID, password: "zzzz-zzzz-zzzz-zzzz" };
  calendar.setCalDavOptionsForTests({ ...fake.options, transport: async (request) => {
    // While the old password is refused, the owner saves a new one.
    if (request.method === "REPORT") { icloud.replaceICloudPassword(accountId, replaced, discovery); return { status: 401, location: null, body: "" }; }
    return fake.options.transport(request);
  } });
  await assert.rejects(calendar.refreshCalDavAccount(accountId), (error) => error instanceof caldav.CalDavAuthError);
  const row = db().prepare("SELECT status, last_error FROM calendar_accounts WHERE id = ?").get(accountId);
  assert.equal(row.status, "ready");
  assert.equal(row.last_error, null);
  // A disconnect during a refresh leaves nothing behind either.
  calendar.setCalDavOptionsForTests({ ...fake.options, transport: async (request) => {
    if (request.method === "REPORT") icloud.disconnectICloud(accountId);
    return fake.options.transport(request);
  } });
  await calendar.refreshCalDavAccount(accountId).catch(() => undefined);
  assert.equal(count("calendar_accounts"), 0);
  assert.equal(count("calendar_sources", "account_id = ?", accountId), 0);
});

test("a calendar moved to another workspace during its fetch gets no events of the old workspace (ICS too)", async () => {
  resetCalDav();
  ensureWorkspace("work", "Work");
  const fake = fakeICloud();
  const discovery = await caldav.discoverCalendars(credentials, fake.options);
  const [home] = discovery.calendars;
  const accountId = icloud.storeICloudAccount(credentials, discovery, [{ id: home.id, workspaceId: "personal" }]);
  const sourceId = db().prepare("SELECT id FROM calendar_sources WHERE account_id = ?").get(accountId).id;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let reports = 0;
  calendar.setCalDavOptionsForTests({ ...fake.options, transport: async (request) => {
    if (request.method === "REPORT" && reports++ === 0) await gate;
    return fake.options.transport(request);
  } });
  const running = calendar.refreshCalendarSource(sourceId);
  await new Promise((resolve) => setTimeout(resolve, 20));
  // While the first fetch waits, the calendar moves to Work.
  icloud.applyICloudSelection(accountId, discovery, [{ id: home.id, workspaceId: "work" }]);
  const moved = { ...db().prepare("SELECT workspace_id, status, revision, last_error FROM calendar_sources WHERE id = ?").get(sourceId) };
  release();
  await assert.rejects(running, (error) => calendar.isSourceChanged(error));
  assert.equal(count("calendar_events", "source_id = ? AND workspace_id = 'personal'", sourceId), 0);
  assert.equal(count("calendar_events", "source_id = ?", sourceId), 0);
  assert.deepEqual({ ...db().prepare("SELECT workspace_id, status, revision, last_error FROM calendar_sources WHERE id = ?").get(sourceId) }, moved);
  assert.equal(moved.workspace_id, "work");
  assert.equal(moved.status, "pending");
  // The account refresh fetches it again for its new workspace.
  await calendar.refreshCalDavAccount(accountId);
  assert.ok(count("calendar_events", "source_id = ? AND workspace_id = 'work'", sourceId) > 0);
  assert.equal(count("calendar_events", "source_id = ? AND workspace_id != 'work'", sourceId), 0);
  resetCalDav();

  // ICS: the same rule, with a source whose revision changes while its (failing) fetch runs: no error state is written over it.
  db().prepare(`INSERT INTO calendar_sources (id, workspace_id, provider, label, encrypted_url, status, created_at, updated_at, revision) VALUES ('ics-move', 'personal', 'ics', 'Feed', ?, 'ready', 1, 1, 3)`)
    .run(calendar.encrypt("https://127.0.0.1/feed.ics"));
  const icsRun = calendar.refreshCalendarSource("ics-move");
  db().prepare("UPDATE calendar_sources SET workspace_id = 'work', status = 'pending', revision = revision + 1 WHERE id = 'ics-move'").run();
  await assert.rejects(icsRun);
  assert.deepEqual({ ...db().prepare("SELECT workspace_id, status, last_error FROM calendar_sources WHERE id = 'ics-move'").get() }, { workspace_id: "work", status: "pending", last_error: null });
  db().exec("DELETE FROM calendar_sources WHERE id = 'ics-move'");
});

test("an unknown action is refused without a rate-limit bucket; a second account is refused before Apple is asked", async () => {
  // More unknown requests from one client than any bucket allows: none is rate limited, so none was counted.
  for (let index = 0; index < 40; index += 1) {
    const answer = await icloudRoute.POST(new Request("http://localhost:3000/api/calendar/icloud", { method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:3000", cookie: `ai_executive_session=${sessionToken}`, "x-forwarded-for": "10.99.0.1",
        "x-lumi-restore-generation": String(store.readSnapshot().restoreGeneration ?? 0) },
      body: JSON.stringify({ action: `made-up-${index}` }) }));
    assert.equal(answer.status, 400);
    assert.equal(JSON.parse(await answer.text()).error, "Unknown action");
  }
  resetCalDav();
  const fake = fakeICloud();
  calendar.setCalDavOptionsForTests(fake.options);
  const discovery = await caldav.discoverCalendars(credentials, fake.options);
  icloud.storeICloudAccount(credentials, discovery, [{ id: discovery.calendars[0].id, workspaceId: "personal" }]);
  const requests = fake.log.length;
  const second = await post({ action: "connect", appleId: "someone.else@icloud.com", appPassword: "kkkk-kkkk-kkkk-kkkk", calendars: [{ id: discovery.calendars[0].id, workspaceId: "personal" }] });
  assert.equal(second.status, 400);
  assert.equal(JSON.parse(second.text).error, "An iCloud account is already connected");
  assert.equal(fake.log.length, requests, "the second Apple ID was not sent to Apple");
  resetCalDav();
});

test("event counts use the plural forms of the interface language", async () => {
  const { copy } = await import("../app/ui/copy.ts");
  const { pluralText } = await import("../lib/plural.ts");
  assert.deepEqual([1, 3, 5, 0].map((value) => pluralText("cs", value, copy.cs.pluEvents)), ["1 událost", "3 události", "5 událostí", "0 událostí"]);
  assert.deepEqual([1, 2].map((value) => pluralText("en", value, copy.en.pluEvents)), ["1 event", "2 events"]);
});

test("the routes need the owner session from the same origin; the integration token is refused", async () => {
  const noSession = await icloudRoute.GET(routeRequest("GET", undefined, { session: false }));
  assert.equal(noSession.status, 401);
  assert.equal((await post({ action: "discover" }, { session: false })).status, 401);
  assert.equal((await post({ action: "discover", appleId: APPLE_ID, appPassword: PASSWORD }, { origin: "https://evil.example" })).status, 403);
  assert.equal((await post({ action: "discover", appleId: APPLE_ID, appPassword: PASSWORD }, { origin: null })).status, 403);
  const bearer = { session: false, headers: { authorization: `Bearer ${process.env.AI_EXECUTIVE_INTEGRATION_TOKEN}` } };
  assert.equal((await icloudRoute.GET(routeRequest("GET", undefined, bearer))).status, 401);
  assert.equal((await post({ action: "disconnect" }, bearer)).status, 401);
  assert.equal((await post({ action: "nonsense" })).status, 400);
});

test("the general calendar route lists iCloud calendars as sources and refreshes them through their account", async () => {
  resetCalDav();
  const fake = fakeICloud();
  calendar.setCalDavOptionsForTests(fake.options);
  const discovery = await caldav.discoverCalendars(credentials, fake.options);
  icloud.storeICloudAccount(credentials, discovery, [{ id: discovery.calendars[0].id, workspaceId: "personal" }]);
  const now = Date.now();
  const listed = JSON.parse(await (await calendarRoute.GET(new Request(`http://localhost:3000/api/calendar?workspaceId=personal&from=${now - day}&to=${now + 14 * day}`,
    { headers: { cookie: `ai_executive_session=${sessionToken}`, "x-forwarded-for": "10.88.0.1" } }))).text());
  const source = listed.sources.find((item) => item.provider === "caldav");
  assert.ok(source);
  assert.ok(!JSON.stringify(listed).includes(DSID));
  const refreshed = await calendarRoute.POST(new Request("http://localhost:3000/api/calendar", { method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost:3000", cookie: `ai_executive_session=${sessionToken}`, "x-forwarded-for": "10.88.0.2",
      "x-lumi-restore-generation": String(store.readSnapshot().restoreGeneration ?? 0) },
    body: JSON.stringify({ action: "refresh", sourceId: source.id }) }));
  assert.equal(refreshed.status, 200, await refreshed.clone().text());
  assert.equal(JSON.parse(await refreshed.text()).source.status, "ready");
  assert.equal(icloud.getICloudAccountState().status, "ready");
  resetCalDav();
});

test("the browser-test override needs both settings and a loopback http address", () => {
  const keep = { e2e: process.env.AI_EXECUTIVE_E2E, url: process.env.AI_EXECUTIVE_E2E_CALDAV_URL };
  try {
    delete process.env.AI_EXECUTIVE_E2E;
    process.env.AI_EXECUTIVE_E2E_CALDAV_URL = "http://127.0.0.1:4999/";
    assert.equal(caldav.calDavTestOverride(), null);
    assert.equal(caldav.defaultCalDavOptions().startUrl.toString(), "https://caldav.icloud.com/");
    process.env.AI_EXECUTIVE_E2E = "true";
    assert.equal(caldav.calDavTestOverride()?.origin, "http://127.0.0.1:4999");
    for (const url of ["https://evil.example/", "http://10.0.0.1:80/", "http://user:pw@127.0.0.1:1/", "file:///etc/passwd"]) {
      process.env.AI_EXECUTIVE_E2E_CALDAV_URL = url;
      assert.equal(caldav.calDavTestOverride(), null, url);
    }
    process.env.AI_EXECUTIVE_E2E_CALDAV_URL = "http://127.0.0.1:4999/";
    const options = caldav.defaultCalDavOptions();
    assert.equal(caldav.isAllowedCalDavUrl(new URL("http://127.0.0.1:4999/x"), options.extraOrigin), true);
    assert.equal(caldav.isAllowedCalDavUrl(new URL("http://127.0.0.1:5000/x"), options.extraOrigin), false);
  } finally {
    if (keep.e2e === undefined) delete process.env.AI_EXECUTIVE_E2E; else process.env.AI_EXECUTIVE_E2E = keep.e2e;
    if (keep.url === undefined) delete process.env.AI_EXECUTIVE_E2E_CALDAV_URL; else process.env.AI_EXECUTIVE_E2E_CALDAV_URL = keep.url;
  }
});
