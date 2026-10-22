// Types and the request helper shared by the Gmail account settings (Settings -> Mail) and the
// Gmail reader (Inbox -> From mail). Both talk to the same endpoints with the same workspace scoping.
export type Account = { id: string; email: string; workspaceId: string };
export type Message = { id: string; subject: string; from: string; to: string; date: string; snippet: string; unread: boolean };
export type Folder = "inbox" | "sent";
export type Detail = { id: string; threadId: string; subject: string; from: string; to: string; date: string; text: string; truncated: boolean };
export type Thread = { id: string; total: number; omitted: number; messages: Message[] };
export type SyncState = { accountId: string; workspaceId: string; enabled: boolean; retentionDays: number; lastSyncedAt: number | null; indexedCount: number; reconciliationPending?: number; historyPending?: boolean; discoveryPending?: boolean };

export async function gmailJson(url: string, body: Record<string, unknown> | undefined, loadFailed: string) {
  const response = await fetch(url, body ? { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(body), cache: "no-store" } : { cache: "no-store" });
  const result = await response.json() as Record<string, unknown>;
  if (!response.ok) throw new Error(typeof result.error === "string" ? result.error : loadFailed);
  return result;
}
