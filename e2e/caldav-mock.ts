import http from "node:http";

// A small stand-in for iCloud's CalDAV service for the browser tests. The test instance is pointed at it only through
// AI_EXECUTIVE_E2E=true together with AI_EXECUTIVE_E2E_CALDAV_URL (playwright.config.ts); see calDavTestOverride in
// lib/caldav.ts. It answers the three discovery PROPFINDs and the calendar-query REPORT with synthetic data.

export const mockAppleId = "jana.testova@icloud.com";
const dsid = "9876543210";
const day = 24 * 60 * 60_000;
const ymd = (time: number) => new Date(time).toISOString().slice(0, 10).replace(/-/g, "");

const vcalendar = (uid: string, lines: string[]) => ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Lumi tests//EN", "BEGIN:VEVENT", `UID:${uid}`,
  "DTSTAMP:20260101T000000Z", ...lines, "END:VEVENT", "END:VCALENDAR"].join("\r\n");
const escapeXml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function multistatus(responses: string[]) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<multistatus xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:A="http://apple.com/ns/ical/">${responses.join("")}</multistatus>`;
}
const response = (href: string, props: string) => `<response><href>${href}</href><propstat><prop>${props}</prop><status>HTTP/1.1 200 OK</status></propstat></response>`;

export interface CalDavMock {
  url: string;
  setPassword(password: string): void;
  requests: Array<{ method: string; path: string }>;
  close(): Promise<void>;
}

export async function startCalDavMock(port: number, password: string): Promise<CalDavMock> {
  let expected = `Basic ${Buffer.from(`${mockAppleId}:${password}`).toString("base64")}`;
  const requests: CalDavMock["requests"] = [];
  const tomorrow = ymd(Date.now() + day);
  const calendars: Record<string, { name: string; color: string; events: string[] }> = {
    home: { name: "Domov", color: "#34C759FF", events: [
      vcalendar("e2e-weekly", [`DTSTART:${tomorrow}T080000Z`, `DTEND:${tomorrow}T090000Z`, "SUMMARY:Týdenní porada iCloud", "RRULE:FREQ=WEEKLY;COUNT=2"]),
      vcalendar("e2e-private", [`DTSTART:${tomorrow}T120000Z`, `DTEND:${tomorrow}T130000Z`, "SUMMARY:Tajná schůzka", "CLASS:PRIVATE"]),
    ] },
    work: { name: "Práce", color: "#FF9500FF", events: [
      vcalendar("e2e-client", [`DTSTART:${tomorrow}T100000Z`, `DTEND:${tomorrow}T110000Z`, "SUMMARY:Schůzka s klientem iCloud"]),
    ] },
  };
  const server = http.createServer((request, reply) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const path = request.url || "/";
      requests.push({ method: request.method || "", path });
      const send = (status: number, text = "") => { reply.writeHead(status, { "content-type": "application/xml; charset=utf-8" }); reply.end(text); };
      if (request.headers.authorization !== expected) return send(401);
      if (request.method === "PROPFIND" && path === "/") {
        return send(207, multistatus([response("/", `<current-user-principal><href>/${dsid}/principal/</href></current-user-principal>`)]));
      }
      if (request.method === "PROPFIND" && path === `/${dsid}/principal/`) {
        return send(207, multistatus([response(path, `<C:calendar-home-set><href>/${dsid}/calendars/</href></C:calendar-home-set>`)]));
      }
      if (request.method === "PROPFIND" && path === `/${dsid}/calendars/`) {
        return send(207, multistatus([
          response(path, "<resourcetype><collection/></resourcetype>"),
          ...Object.entries(calendars).map(([key, calendar]) => response(`/${dsid}/calendars/${key}/`,
            `<resourcetype><collection/><C:calendar/></resourcetype><displayname>${calendar.name}</displayname><A:calendar-color>${calendar.color}</A:calendar-color>`
            + `<C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set>`)),
          response(`/${dsid}/calendars/reminders/`, `<resourcetype><collection/><C:calendar/></resourcetype><displayname>Připomínky</displayname>`
            + `<C:supported-calendar-component-set><C:comp name="VTODO"/></C:supported-calendar-component-set>`),
        ]));
      }
      const match = /^\/\d+\/calendars\/([a-z]+)\/$/.exec(path);
      if (request.method === "REPORT" && match && calendars[match[1]]) {
        return send(207, multistatus(calendars[match[1]].events.map((event, index) =>
          response(`${path}${index}.ics`, `<getetag>"${index}"</getetag><C:calendar-data>${escapeXml(event)}</C:calendar-data>`))));
      }
      send(404);
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", () => resolve()); });
  return {
    url: `http://127.0.0.1:${port}/`,
    requests,
    setPassword(next) { expected = `Basic ${Buffer.from(`${mockAppleId}:${next}`).toString("base64")}`; },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
