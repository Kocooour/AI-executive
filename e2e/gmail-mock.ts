import http from "node:http";

export const mockGmailAddress = "e2e.reader@example.com";
export const mockGmailRefresh = "e2e-only-refresh-secret";
export const mockGmailAccess = "e2e-only-access-secret";
export const mockGmailScope = "https://www.googleapis.com/auth/gmail.readonly";

export interface GmailMock {
  requests: Array<{ path: string; method: string; body: string; authorization: string | undefined }>;
  close(): Promise<void>;
}

export async function startGmailMock(port: number): Promise<GmailMock> {
  const requests: GmailMock["requests"] = [];
  const server = http.createServer((request, reply) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const path = request.url || "/";
      requests.push({ path, method: request.method || "", body, authorization: request.headers.authorization });
      const respond = (status: number, value: object) => {
        reply.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
        reply.end(JSON.stringify(value));
      };
      if (request.method === "POST" && path === "/token") {
        const form = new URLSearchParams(body);
        if (form.get("client_id") !== "lumi-e2e-only" || form.get("client_secret") !== "test-only-not-google")
          return respond(401, { error: "invalid_client" });
        if (form.get("grant_type") === "authorization_code") {
          if (form.get("code") !== "E2E-FAKE-CODE" || !form.get("code_verifier"))
            return respond(401, { error: "invalid_grant" });
          return respond(200, { access_token: mockGmailAccess, refresh_token: mockGmailRefresh, scope: mockGmailScope });
        }
        if (form.get("grant_type") === "refresh_token" && form.get("refresh_token") === mockGmailRefresh)
          return respond(200, { access_token: mockGmailAccess });
        return respond(401, { error: "invalid_grant" });
      }
      if (request.headers.authorization !== "Bearer " + mockGmailAccess)
        return respond(401, { error: "invalid_access_token" });
      if (request.method === "GET" && path === "/gmail/v1/users/me/profile")
        return respond(200, { emailAddress: mockGmailAddress });
      if (request.method === "GET" && path.startsWith("/gmail/v1/users/me/messages?"))
        return respond(200, { messages: [{ id: "abc123def456" }] });
      if (request.method === "GET" && path.startsWith("/gmail/v1/users/me/messages/abc123def456?") &&
          new URL(path, "http://127.0.0.1").searchParams.get("format") === "full")
        return respond(200, { threadId: "thread-e2e", payload: {
          mimeType: "text/plain",
          headers: [
            { name: "Subject", value: "Gmail OAuth E2E" },
            { name: "From", value: "tester@example.com" },
            { name: "To", value: mockGmailAddress },
            { name: "Date", value: "Wed, 21 Oct 2026 10:00:00 +0200" },
          ],
          body: { data: Buffer.from("E2E zpráva pro vytvoření úkolu.").toString("base64url") },
        } });
      if (request.method === "GET" && path.startsWith("/gmail/v1/users/me/messages/abc123def456?"))
        return respond(200, { threadId: "thread-e2e", snippet: "Zpráva z lokálního mocku",
          labelIds: ["INBOX", "UNREAD"], payload: { headers: [
            { name: "Subject", value: "Gmail OAuth E2E" },
            { name: "From", value: "tester@example.com" },
            { name: "Date", value: "Wed, 21 Oct 2026 10:00:00 +0200" },
          ] },
        });
      return respond(404, { error: "not_found" });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
  });
  return { requests, close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}
