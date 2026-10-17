import { createHash } from "node:crypto";
import http from "node:http";
import https from "node:https";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { resolvedTarget } from "./calendar-net";

// Read-only CalDAV client for iCloud (RFC 4791). It discovers the calendars of one Apple ID (current-user-principal →
// calendar-home-set → the calendar collections) and reads the events of one calendar in a time range (calendar-query
// REPORT). It writes nothing to the calendar. Requests go only to iCloud's CalDAV hosts over HTTPS on port 443; the
// Basic authorization header is never sent anywhere else, also not on a redirect. Every failure carries a fixed message
// without the Apple ID, the password, the account number in iCloud's addresses or any address.

export const DAV_NS = "DAV:";
export const CALDAV_NS = "urn:ietf:params:xml:ns:caldav";
export const APPLE_ICAL_NS = "http://apple.com/ns/ical/";
export const CALENDARSERVER_NS = "http://calendarserver.org/ns/";

export const ICLOUD_CALDAV_START = "https://caldav.icloud.com/";
export const MAX_PROPFIND_BYTES = 2 * 1024 * 1024;
// The same cap as an ICS feed (lib/calendar.ts): one calendar is read with one REPORT, so this also bounds the calendar.
export const MAX_REPORT_BYTES = 2 * 1024 * 1024;
export const MAX_CALENDAR_RESOURCES = 5000;
export const MAX_CALENDARS = 100;
const MAX_REDIRECTS = 3;
const REQUEST_TIMEOUT_MS = 10_000;
const REQUEST_DEADLINE_MS = 12_000;

export class CalDavError extends Error {}
/** Apple answered 401 or 403: the app-specific password (or the Apple ID) was refused. */
export class CalDavAuthError extends CalDavError {}

export interface CalDavCredentials { username: string; password: string }
export interface CalDavHttpRequest { url: URL; method: "PROPFIND" | "REPORT"; headers: Record<string, string>; body: string; maxBytes: number }
export interface CalDavHttpResponse { status: number; location: string | null; body: string }
export type CalDavTransport = (request: CalDavHttpRequest) => Promise<CalDavHttpResponse>;
export interface CalDavOptions {
  transport: CalDavTransport;
  /** Where discovery starts. */
  startUrl: URL;
  /** One more origin that counts as iCloud: only the browser-test mock server (see `calDavTestOverride`). */
  extraOrigin: string | null;
}
export interface DiscoveredCalendar { id: string; url: string; displayName: string; color: string | null; ctag: string | null; syncToken: string | null }
export interface CalDavDiscovery { principalUrl: string; homeUrl: string; calendars: DiscoveredCalendar[] }

/** iCloud's CalDAV hosts: caldav.icloud.com and its partitions pNN-caldav.icloud.com, HTTPS on port 443, no user info. */
export function isAllowedCalDavUrl(url: URL, extraOrigin: string | null = null) {
  if (url.username || url.password) return false;
  if (extraOrigin && url.origin === extraOrigin) return true;
  if (url.protocol !== "https:" || (url.port && url.port !== "443")) return false;
  const host = url.hostname.toLowerCase();
  return host === "caldav.icloud.com" || /^p\d{1,4}-caldav\.icloud\.com$/.test(host);
}

/** The opaque identifier the browser sees for a calendar; the collection address itself never leaves the server. */
export function calendarKey(collectionUrl: string) {
  return createHash("sha256").update(`lumi-caldav-calendar\0${collectionUrl}`).digest("base64url").slice(0, 24);
}

// ---------------------------------------------------------------------------------------------------------------------
// Transport

function collect(response: http.IncomingMessage, maxBytes: number, resolve: (value: CalDavHttpResponse) => void, reject: (error: Error) => void) {
  const status = response.statusCode || 0;
  const location = typeof response.headers.location === "string" ? response.headers.location : null;
  // Only a multistatus answer is read; anything else is judged by its status alone.
  if (status !== 207 && status !== 200) { response.resume(); resolve({ status, location, body: "" }); return; }
  const declared = Number(response.headers["content-length"] || 0);
  if (declared > maxBytes) { response.destroy(); reject(new CalDavError("iCloud response is too large")); return; }
  const chunks: Buffer[] = [];
  let size = 0;
  response.on("data", (chunk: Buffer) => {
    size += chunk.length;
    if (size > maxBytes) { response.destroy(); reject(new CalDavError("iCloud response is too large")); return; }
    chunks.push(chunk);
  });
  response.on("end", () => resolve({ status, location, body: Buffer.concat(chunks).toString("utf8") }));
  response.on("error", reject);
}

function send(request: http.ClientRequest, body: string, reject: (error: Error) => void) {
  const deadline = setTimeout(() => request.destroy(new CalDavError("iCloud could not be reached")), REQUEST_DEADLINE_MS);
  request.on("close", () => clearTimeout(deadline));
  request.on("timeout", () => request.destroy(new CalDavError("iCloud could not be reached")));
  request.on("error", reject);
  request.end(body);
}

/** The real transport: HTTPS to a validated public address that is pinned for the connection. */
export const httpsCalDavTransport: CalDavTransport = async (input) => {
  const target = await resolvedTarget(input.url);
  return new Promise((resolve, reject) => {
    const request = https.request({
      protocol: "https:", hostname: input.url.hostname, port: 443, path: `${input.url.pathname}${input.url.search}`,
      method: input.method, headers: { ...input.headers, "Content-Length": String(Buffer.byteLength(input.body)) },
      servername: input.url.hostname,
      lookup: (_hostname, options, callback) => {
        if (typeof options === "object" && options.all) callback(null, [target]);
        else callback(null, target.address, target.family);
      },
      timeout: REQUEST_TIMEOUT_MS,
    }, (response) => collect(response, input.maxBytes, resolve, reject));
    send(request, input.body, reject);
  });
};

/** Plain HTTP to the loopback mock server of the browser tests; used only for the origin `calDavTestOverride` returns. */
const loopbackCalDavTransport: CalDavTransport = (input) => new Promise((resolve, reject) => {
  const request = http.request({
    protocol: "http:", hostname: input.url.hostname, port: input.url.port, path: `${input.url.pathname}${input.url.search}`,
    method: input.method, headers: { ...input.headers, "Content-Length": String(Buffer.byteLength(input.body)) }, timeout: REQUEST_TIMEOUT_MS,
  }, (response) => collect(response, input.maxBytes, resolve, reject));
  send(request, input.body, reject);
});

/**
 * The browser tests point discovery at a local mock server. It needs two settings of the server process together:
 * `AI_EXECUTIVE_E2E=true` and `AI_EXECUTIVE_E2E_CALDAV_URL` with an http:// address on the loopback interface. Nothing a
 * request carries can set either; without both (or with any other address) only iCloud is used.
 */
export function calDavTestOverride(): URL | null {
  if (process.env.AI_EXECUTIVE_E2E !== "true") return null;
  const raw = process.env.AI_EXECUTIVE_E2E_CALDAV_URL || "";
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" || url.username || url.password || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return null;
    return url;
  } catch { return null; }
}

export function defaultCalDavOptions(): CalDavOptions {
  const override = calDavTestOverride();
  if (!override) return { transport: httpsCalDavTransport, startUrl: new URL(ICLOUD_CALDAV_START), extraOrigin: null };
  return {
    transport: (input) => input.url.origin === override.origin ? loopbackCalDavTransport(input) : httpsCalDavTransport(input),
    startUrl: override,
    extraOrigin: override.origin,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// XML with namespaces

export interface XmlElement { ns: string; name: string; attributes: Record<string, string>; children: XmlElement[]; text: string }

const parser = new XMLParser({
  preserveOrder: true, ignoreAttributes: false, attributeNamePrefix: "", parseTagValue: false, parseAttributeValue: false,
  trimValues: false, processEntities: false, htmlEntities: false, ignoreDeclaration: true, ignorePiTags: true, cdataPropName: "#cdata",
});

const namedEntities: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: "\"", apos: "'" };
/** The five predefined XML entities and numeric references, in one pass (so `&amp;#65;` stays `&#65;`). */
function decodeText(value: string) {
  return value.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, entity: string) => {
    if (entity[0] === "#") {
      const code = entity[1] === "x" || entity[1] === "X" ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return namedEntities[entity.toLowerCase()] ?? whole;
  });
}

type RawNode = Record<string, unknown>;

function toElement(tag: string, node: RawNode, scope: Map<string, string>): XmlElement {
  const attributes = (node[":@"] || {}) as Record<string, string>;
  let local = scope;
  const plain: Record<string, string> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (key === "xmlns" || key.startsWith("xmlns:")) {
      if (local === scope) local = new Map(scope);
      local.set(key === "xmlns" ? "" : key.slice(6), decodeText(String(value)));
    } else {
      // Unprefixed attributes (the only ones CalDAV uses, such as comp's `name`) by their local name.
      plain[key.slice(key.indexOf(":") + 1)] = decodeText(String(value));
    }
  }
  const colon = tag.indexOf(":");
  const prefix = colon >= 0 ? tag.slice(0, colon) : "";
  const name = colon >= 0 ? tag.slice(colon + 1) : tag;
  const element: XmlElement = { ns: local.get(prefix) ?? "", name, attributes: plain, children: [], text: "" };
  for (const child of (node[tag] || []) as RawNode[]) {
    if ("#text" in child) { element.text += decodeText(String(child["#text"])); continue; }
    if ("#cdata" in child) {
      for (const part of (child["#cdata"] || []) as RawNode[]) element.text += String(part["#text"] ?? "");
      continue;
    }
    const childTag = Object.keys(child).find((key) => key !== ":@");
    if (childTag) element.children.push(toElement(childTag, child, local));
  }
  return element;
}

/** Parses a DAV response. A document type (and with it any entity definition) is refused before parsing (no XXE). */
export function parseDavXml(text: string): XmlElement {
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new CalDavError("iCloud returned an unreadable response");
  if (XMLValidator.validate(text) !== true) throw new CalDavError("iCloud returned an unreadable response");
  let nodes: RawNode[];
  try { nodes = parser.parse(text) as RawNode[]; } catch { throw new CalDavError("iCloud returned an unreadable response"); }
  const root = nodes.find((node) => Object.keys(node).some((key) => key !== ":@" && !key.startsWith("#")));
  if (!root) throw new CalDavError("iCloud returned an unreadable response");
  const tag = Object.keys(root).find((key) => key !== ":@")!;
  return toElement(tag, root, new Map([["xml", "http://www.w3.org/XML/1998/namespace"]]));
}

const childrenOf = (element: XmlElement | undefined, ns: string, name: string) =>
  element ? element.children.filter((child) => child.ns === ns && child.name === name) : [];
const childOf = (element: XmlElement | undefined, ns: string, name: string) => childrenOf(element, ns, name)[0];

interface DavResponse { href: string; props: XmlElement[] }

/** The responses of a multistatus with the properties of their successful (200) propstats. */
function multistatus(text: string): DavResponse[] {
  const root = parseDavXml(text);
  if (root.ns !== DAV_NS || root.name !== "multistatus") throw new CalDavError("iCloud returned an unreadable response");
  return childrenOf(root, DAV_NS, "response").map((response) => {
    const props: XmlElement[] = [];
    for (const propstat of childrenOf(response, DAV_NS, "propstat")) {
      const status = childOf(propstat, DAV_NS, "status")?.text || "";
      if (!/^\s*HTTP\/\d(?:\.\d)?\s+200\b/.test(status)) continue;
      for (const prop of childrenOf(propstat, DAV_NS, "prop")) props.push(...prop.children);
    }
    return { href: (childOf(response, DAV_NS, "href")?.text || "").trim(), props };
  });
}

const prop = (response: DavResponse, ns: string, name: string) => response.props.find((item) => item.ns === ns && item.name === name);

// ---------------------------------------------------------------------------------------------------------------------
// Requests

function resolveHref(href: string, base: URL, options: CalDavOptions) {
  let url: URL;
  try { url = new URL(href, base); } catch { throw new CalDavError("iCloud pointed to an address outside iCloud"); }
  url.hash = "";
  if (!isAllowedCalDavUrl(url, options.extraOrigin)) throw new CalDavError("iCloud pointed to an address outside iCloud");
  return url;
}

async function davRequest(
  credentials: CalDavCredentials, method: "PROPFIND" | "REPORT", start: URL, depth: "0" | "1", body: string, maxBytes: number, options: CalDavOptions,
) {
  const authorization = `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`, "utf8").toString("base64")}`;
  let url = start;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    // Checked before every hop: the credentials are only ever sent to an allowed host.
    if (!isAllowedCalDavUrl(url, options.extraOrigin)) throw new CalDavError("iCloud pointed to an address outside iCloud");
    let response: CalDavHttpResponse;
    try {
      response = await options.transport({
        url, method, body, maxBytes,
        headers: { Authorization: authorization, Depth: depth, "Content-Type": "application/xml; charset=utf-8", Accept: "application/xml, text/xml", "User-Agent": "Lumi-Calendar/1" },
      });
    } catch (error) {
      if (error instanceof CalDavError) throw error;
      throw new CalDavError("iCloud could not be reached");
    }
    if ([301, 302, 307, 308].includes(response.status) && response.location) {
      try { url = new URL(response.location, url); } catch { throw new CalDavError("iCloud pointed to an address outside iCloud"); }
      continue;
    }
    if (response.status === 401 || response.status === 403) throw new CalDavAuthError("Apple refused the app-specific password");
    if (response.status === 404 || response.status === 410) throw new CalDavError("iCloud calendar no longer exists");
    if (response.status !== 207 && response.status !== 200) throw new CalDavError("iCloud server returned an error");
    if (Buffer.byteLength(response.body) > maxBytes) throw new CalDavError("iCloud response is too large");
    return { url, body: response.body };
  }
  throw new CalDavError("iCloud redirected too many times");
}

const PRINCIPAL_BODY = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>`;
const HOME_BODY = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-home-set/></d:prop></d:propfind>`;
const CALENDARS_BODY = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:a="http://apple.com/ns/ical/" xmlns:cs="http://calendarserver.org/ns/">
<d:prop><d:resourcetype/><d:displayname/><c:supported-calendar-component-set/><a:calendar-color/><cs:getctag/><d:sync-token/></d:prop></d:propfind>`;

function hrefProperty(responses: DavResponse[], ns: string, name: string) {
  for (const response of responses) {
    const value = prop(response, ns, name);
    const href = childOf(value, DAV_NS, "href")?.text.trim();
    if (href) return href;
  }
  throw new CalDavError("iCloud returned an unreadable response");
}

const sameCollection = (a: URL, b: URL) => a.origin === b.origin && a.pathname.replace(/\/+$/, "") === b.pathname.replace(/\/+$/, "");

/** Validates the credentials (Apple answers 401 otherwise) and lists the calendars that hold events. Writes nothing. */
export async function discoverCalendars(credentials: CalDavCredentials, options: CalDavOptions = defaultCalDavOptions()): Promise<CalDavDiscovery> {
  const principalAnswer = await davRequest(credentials, "PROPFIND", options.startUrl, "0", PRINCIPAL_BODY, MAX_PROPFIND_BYTES, options);
  const principalUrl = resolveHref(hrefProperty(multistatus(principalAnswer.body), DAV_NS, "current-user-principal"), principalAnswer.url, options);
  const homeAnswer = await davRequest(credentials, "PROPFIND", principalUrl, "0", HOME_BODY, MAX_PROPFIND_BYTES, options);
  const homeUrl = resolveHref(hrefProperty(multistatus(homeAnswer.body), CALDAV_NS, "calendar-home-set"), homeAnswer.url, options);
  const listAnswer = await davRequest(credentials, "PROPFIND", homeUrl, "1", CALENDARS_BODY, MAX_PROPFIND_BYTES, options);
  const calendars: DiscoveredCalendar[] = [];
  for (const response of multistatus(listAnswer.body)) {
    if (!response.href) continue;
    const url = resolveHref(response.href, listAnswer.url, options);
    if (sameCollection(url, homeUrl) || sameCollection(url, listAnswer.url)) continue;
    const types = prop(response, DAV_NS, "resourcetype");
    if (!childOf(types, CALDAV_NS, "calendar")) continue;
    // Without the property a calendar accepts every component type (RFC 4791, 5.2.3); iCloud always states it.
    const componentSet = prop(response, CALDAV_NS, "supported-calendar-component-set");
    if (componentSet && !childrenOf(componentSet, CALDAV_NS, "comp").some((comp) => (comp.attributes.name || "").trim().toUpperCase() === "VEVENT")) continue;
    const displayName = (prop(response, DAV_NS, "displayname")?.text || "").replace(/\s+/g, " ").trim().slice(0, 120) || "iCloud";
    const color = (prop(response, APPLE_ICAL_NS, "calendar-color")?.text || "").trim();
    calendars.push({
      id: calendarKey(url.toString()), url: url.toString(), displayName,
      color: /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(color) ? color.slice(0, 7) : null,
      ctag: prop(response, CALENDARSERVER_NS, "getctag")?.text.trim() || null,
      syncToken: prop(response, DAV_NS, "sync-token")?.text.trim() || null,
    });
    if (calendars.length > MAX_CALENDARS) throw new CalDavError("iCloud returned an unreadable response");
  }
  return { principalUrl: principalUrl.toString(), homeUrl: homeUrl.toString(), calendars };
}

function davTime(value: Date) {
  return value.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/** The iCalendar text of every event of one calendar that overlaps the range (one calendar-query REPORT). */
export async function fetchCalendarObjects(
  credentials: CalDavCredentials, collectionUrl: string, range: { from: Date; to: Date }, options: CalDavOptions = defaultCalDavOptions(),
): Promise<string[]> {
  const url = new URL(collectionUrl);
  const body = `<?xml version="1.0" encoding="utf-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/><c:calendar-data/></d:prop>
<c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="${davTime(range.from)}" end="${davTime(range.to)}"/></c:comp-filter></c:comp-filter></c:filter>
</c:calendar-query>`;
  const answer = await davRequest(credentials, "REPORT", url, "1", body, MAX_REPORT_BYTES, options);
  const bodies: string[] = [];
  for (const response of multistatus(answer.body)) {
    if (response.href) resolveHref(response.href, answer.url, options);
    const data = prop(response, CALDAV_NS, "calendar-data")?.text || "";
    if (!data.includes("BEGIN:VCALENDAR")) continue;
    bodies.push(data);
    if (bodies.length > MAX_CALENDAR_RESOURCES) throw new Error("Calendar contains too many components");
  }
  return bodies;
}
