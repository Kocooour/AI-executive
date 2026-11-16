// Browser-independent TLS proxy and HTTPS auth smoke for disposable Safari gate.
import { readFileSync } from "node:fs";
import https from "node:https";
import http from "node:http";

export const SAFARI_GATE_PREFLIGHT_PATH = "/__lumi_safari_gate__/fresh-origin";
const OWNER_COOKIE_NAME = "ai_executive_session";
const GATE_COOKIE_PREFIX = "__Host-lumi_safari_gate_";

// Cookies are host-scoped, NOT port-scoped. Each launch uses its own name in
// Safari; the loopback proxy translates only that name to the unchanged owner
// cookie expected by Next. An old Safari session can never authenticate a new
// run, even when the browser sends all 127.0.0.1 cookies to every port.
export function safariGateBrowserCookieName(nonce) {
  if (!/^[a-f0-9]{32}$/.test(nonce)) throw new Error("invalid Safari gate cookie nonce");
  return GATE_COOKIE_PREFIX + nonce;
}

function assertGateCookieName(name) {
  if (typeof name !== "string" ||
      !/^__Host-lumi_safari_gate_[a-f0-9]{32}$/.test(name)) {
    throw new Error("invalid Safari gate browser cookie name");
  }
  return name;
}

export function gateOwnerCookieFromBrowserHeader(cookieHeader, browserCookieName) {
  assertGateCookieName(browserCookieName);
  if (typeof cookieHeader !== "string") return undefined;
  const matched = cookieHeader.split(";").map(part => part.trim())
    .filter(part => part.startsWith(browserCookieName + "="));
  // Ambiguous duplicate cookies fail closed rather than choose a stale token.
  if (matched.length !== 1) return undefined;
  const value = matched[0].slice(browserCookieName.length + 1);
  if (!/^[A-Za-z0-9_.-]{1,2048}$/.test(value)) return undefined;
  return OWNER_COOKIE_NAME + "=" + value;
}

// Never let an upstream cookie escape under the production name. Fail closed
// on an unexpected Set-Cookie: only owner login/logout may issue one here.
export function gateSetCookiesForBrowser(setCookieHeader, browserCookieName) {
  assertGateCookieName(browserCookieName);
  if (setCookieHeader === undefined) return undefined;
  const cookies = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  if (!cookies.every(cookie =>
    typeof cookie === "string" && cookie.startsWith(OWNER_COOKIE_NAME + "="))) {
    throw new Error("unexpected cookie emitted by local Safari gate");
  }
  return cookies.map(cookie =>
    browserCookieName + cookie.slice(OWNER_COOKIE_NAME.length));
}

// Checks the browser's persistent origin state, not the server's test data.
// Never clears anything automatically.
export function safariGatePreflightHtml() {
  return String.raw`<!doctype html>
<html lang="cs"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Lumi — kontrola izolace Safari</title>
<style>body{font:16px -apple-system,system-ui,sans-serif;max-width:44rem;
margin:3rem auto;padding:0 1rem;line-height:1.55}
button{font:inherit;padding:.6rem 1.2rem}</style></head><body>
<h1>Kontrola testovacího profilu Safari</h1>
<p id="status" role="status">Kontroluji místní data tohoto webu…</p>
<p id="detail"></p>
<button id="continue" disabled>Pokračovat do testovací Lumi</button>
<script>
(async () => {
  const status = document.getElementById("status");
  const detail = document.getElementById("detail");
  const button = document.getElementById("continue");
  try {
    if (!("indexedDB" in window) ||
        typeof indexedDB.databases !== "function" ||
        !("caches" in window) ||
        !("serviceWorker" in navigator) ||
        typeof navigator.serviceWorker.getRegistrations !== "function") {
      throw new Error("Safari neposkytuje všechny potřebné kontroly úložiště.");
    }
    const [databases, cacheKeys, registrations] = await Promise.all([
      indexedDB.databases(), caches.keys(),
      navigator.serviceWorker.getRegistrations()
    ]);
    const counts = {
      indexedDB: databases.length, cacheStorage: cacheKeys.length,
      serviceWorkers: registrations.length,
      localStorage: localStorage.length, sessionStorage: sessionStorage.length,
      serviceWorkerController: navigator.serviceWorker.controller ? 1 : 0
    };
    if (Object.values(counts).some(value => value !== 0)) {
      status.textContent = "STOP: Tento web již obsahuje data předchozí relace.";
      detail.textContent = "V Safari smažte data tohoto testovacího webu, zavřete jeho karty a otevřete adresu znovu. Nemažte data produkční Lumi.";
      console.error("LUMI_SAFARI_GATE_ORIGIN_REUSED", JSON.stringify(counts));
      return;
    }
    status.textContent = "Původ je čistý. Lze pokračovat v ručním Safari testu.";
    detail.textContent = "V testovací Lumi se přihlaste jednorázovým heslem z terminálu.";
    console.info("LUMI_SAFARI_GATE_ORIGIN_CLEAN");
    button.disabled = false;
    button.addEventListener("click", () =>
      location.replace("/?view=Calendar&scope=personal"), { once: true });
  } catch (error) {
    status.textContent = "STOP: Čistotu Safari dat nelze ověřit.";
    detail.textContent = "Test není průkazný; ověřte podporu API v Safari Web Inspectoru.";
    console.error("LUMI_SAFARI_GATE_ORIGIN_INCONCLUSIVE", String(error));
  }
})();
</script></body></html>`;
}

export function createSafariGateTlsProxy(certPath, keyPath, externalPort, internalPort, browserCookieName) {
  assertGateCookieName(browserCookieName);
  return https.createServer({
    cert: readFileSync(certPath), key: readFileSync(keyPath),
  }, (request, response) => {
    if (request.headers.host !== "127.0.0.1:" + externalPort) {
      response.writeHead(421, { "cache-control": "no-store" });
      response.end();
      return;
    }
    if (request.method === "GET" && request.url === SAFARI_GATE_PREFLIGHT_PATH) {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      });
      response.end(safariGatePreflightHtml());
      return;
    }
    const headers = {
      ...request.headers,
      host: "127.0.0.1:" + internalPort,
      "x-forwarded-host": "127.0.0.1:" + externalPort,
      "x-forwarded-proto": "https",
      "x-forwarded-for": "127.0.0.1",
      "x-real-ip": "127.0.0.1",
    };
    // Drop EVERY browser cookie other than this launch's random namespace.
    // Older gate cookies, the production-named cookie and unrelated host
    // cookies must never reach Next.
    delete headers.cookie;
    const ownerCookie = gateOwnerCookieFromBrowserHeader(
      request.headers.cookie, browserCookieName);
    if (ownerCookie) headers.cookie = ownerCookie;
    const upstream = http.request({
      hostname: "127.0.0.1", port: internalPort,
      path: request.url, method: request.method, headers,
    }, upstreamResponse => {
      const replyHeaders = { ...upstreamResponse.headers };
      try {
        const mapped = gateSetCookiesForBrowser(
          upstreamResponse.headers["set-cookie"], browserCookieName);
        if (mapped !== undefined) replyHeaders["set-cookie"] = mapped;
      } catch {
        upstreamResponse.resume();
        response.writeHead(502);
        response.end();
        return;
      }
      response.writeHead(upstreamResponse.statusCode || 502, replyHeaders);
      upstreamResponse.pipe(response);
    });
    upstream.on("error", () => {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
    request.on("aborted", () => upstream.destroy());
    request.pipe(upstream);
  });
}

// No browser cookies or storage are touched. TLS verification is always on.
export function httpsGateRequest({ port, ca, method = "GET", endpoint, headers = {}, body = "" }) {
  return new Promise((resolve, reject) => {
    const request = https.request({
      hostname: "127.0.0.1", port, method, path: endpoint, ca,
      headers: { host: "127.0.0.1:" + port, ...headers },
    }, response => {
      const chunks = [];
      let received = 0;
      response.on("data", chunk => {
        received += chunk.length;
        if (received > 256 * 1024) {
          request.destroy(new Error("HTTPS smoke response exceeds limit"));
        } else chunks.push(chunk);
      });
      response.on("end", () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
      response.on("error", reject);
    });
    request.setTimeout(10000, () => request.destroy(new Error("HTTPS smoke timeout")));
    request.on("error", reject);
    request.end(body);
  });
}

function parseJson(response) {
  try { return JSON.parse(response.body); }
  catch { throw new Error("local HTTPS smoke returned invalid JSON"); }
}

// The shell flag is compiled by Next; a green API smoke alone would miss an
// off-profile HTML shell with no Quick Capture button. Read SSR output over
// the authenticated, CA-verified HTTPS proxy before handing the URL to Safari.
export function assertSafariGateV1ShellHtml(html) {
  if (typeof html !== "string" || !html.includes('data-design-system="lumi-v1"')) {
    throw new Error("Safari gate built without the v1 shell (Quick Capture unavailable)");
  }
}

export async function verifySafariGateHttps({ port, ca, password, browserCookieName }) {
  assertGateCookieName(browserCookieName);
  const request = (endpoint, options = {}) =>
    httpsGateRequest({ port, ca, endpoint, ...options });
  const anonymous = await request("/api/auth/status");
  if (anonymous.status !== 200) throw new Error("HTTPS auth status not reachable");
  const before = parseJson(anonymous);
  if (before.enabled !== true || before.configured !== true ||
      before.authenticated !== false) {
    throw new Error("HTTPS auth status is not isolated and anonymous");
  }
  // A stale production-named owner cookie must never authenticate the gate.
  const stale = await request("/api/auth/status", {
    headers: { cookie: OWNER_COOKIE_NAME + "=stale.some-signature" },
  });
  if (stale.status !== 200 || parseJson(stale).authenticated !== false) {
    throw new Error("HTTPS proxy accepted an unrelated owner cookie");
  }
  const origin = "https://127.0.0.1:" + port;
  const payload = JSON.stringify({ password });
  const login = await request("/api/auth/login", {
    method: "POST", body: payload,
    headers: {
      origin, "content-type": "application/json",
      "content-length": Buffer.byteLength(payload),
    },
  });
  if (login.status !== 200) throw new Error("HTTPS login failed");
  const setCookie = login.headers["set-cookie"];
  const ownerCookie = (Array.isArray(setCookie) ? setCookie : []).find(value =>
    value.startsWith(browserCookieName + "="));
  if (!ownerCookie || !/;\s*secure(?:;|$)/i.test(ownerCookie) ||
      !/;\s*httponly(?:;|$)/i.test(ownerCookie) ||
      !/;\s*samesite=strict(?:;|$)/i.test(ownerCookie)) {
    throw new Error("HTTPS login did not set the expected Secure owner cookie");
  }
  const cookie = ownerCookie.split(";")[0];
  const authenticated = await request("/api/auth/status", {
    headers: { cookie },
  });
  if (authenticated.status !== 200 ||
      parseJson(authenticated).authenticated !== true) {
    throw new Error("owner session cookie failed through the HTTPS proxy");
  }
  // No browser-visible owner cookie may bypass the per-run namespace.
  const originalCookie = OWNER_COOKIE_NAME + "=" +
    cookie.slice(browserCookieName.length + 1);
  const bypass = await request("/api/auth/status", {
    headers: { cookie: originalCookie },
  });
  if (bypass.status !== 200 || parseJson(bypass).authenticated !== false) {
    throw new Error("proxy leaked host-wide owner cookie scope");
  }
  const ownerPage = await request("/", { headers: { cookie } });
  if (ownerPage.status !== 200 ||
      !String(ownerPage.headers["content-type"] || "").includes("text/html")) {
    throw new Error("Safari gate owner HTML not reachable");
  }
  assertSafariGateV1ShellHtml(ownerPage.body);
  const areasResponse = await request("/api/target-staging/notes/create-targets", {
    headers: { cookie },
  });
  if (areasResponse.status !== 200) {
    throw new Error("private Quick Capture Areas endpoint failed over HTTPS");
  }
  const areas = parseJson(areasResponse).areas;
  if (!Array.isArray(areas) || !areas.some(area => area.title === "Tvoření")) {
    throw new Error("synthetic private Tvoření Area is missing from Quick Capture");
  }
  return true;
}
