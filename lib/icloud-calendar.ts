import { randomUUID } from "node:crypto";
import { calendarKey, discoverCalendars, type CalDavCredentials, type CalDavDiscovery } from "./caldav";
import { calDavAccountRow, calDavCredentials, calDavOptions, decrypt, encrypt, markCalDavAccount } from "./calendar";
import { ensureDailyBackup, getDatabase, readSnapshot } from "./server-store";

// The iCloud account behind the CalDAV calendars (read-only, E1). One account per instance. The browser only ever sees a
// masked Apple ID, states, counts and an opaque identifier per calendar; never the Apple ID, the password or an address.
// Writers of the backed-up tables call ensureDailyBackup() before their transaction. Network calls (discovery) happen
// before these synchronous writers are called, so the route can check the restore fence right before each write.

export const MAX_SELECTED_CALENDARS = 50;

export interface ICloudCalendarChoice { id: string; name: string; color: string | null; selected: boolean; workspaceId: string | null }
export interface ICloudCalendarState {
  id: string;
  sourceId: string;
  label: string;
  workspaceId: string;
  status: string;
  eventCount: number;
  lastSuccessAt: number | null;
  lastError: string;
}
export interface ICloudAccountState {
  label: string;
  status: "ready" | "pending" | "stale" | "syncing" | "error" | "auth_failed";
  lastSuccessAt: number | null;
  lastError: string;
  calendars: ICloudCalendarState[];
}

export function parseAppleId(value: unknown) {
  const appleId = typeof value === "string" ? value.trim() : "";
  if (!appleId || appleId.length > 254 || !/^[^\s@:]+@[^\s@:]+\.[^\s@:]+$/.test(appleId)) throw new Error("Apple ID is invalid");
  return appleId;
}

/** Apple shows the password as xxxx-xxxx-xxxx-xxxx in lowercase letters; it is accepted with or without the dashes. */
export function parseAppPassword(value: unknown) {
  const compact = typeof value === "string" ? value.trim().replace(/-/g, "").toLowerCase() : "";
  if (!/^[a-z]{16}$/.test(compact)) throw new Error("App-specific password must look like xxxx-xxxx-xxxx-xxxx");
  return compact.match(/.{4}/g)!.join("-");
}

export function maskAppleId(appleId: string) {
  const at = appleId.lastIndexOf("@");
  const local = appleId.slice(0, at);
  return `${local.slice(0, 1)}***@${appleId.slice(at + 1)}`.slice(0, 254);
}

function workspaceExists(workspaceId: string) {
  return workspaceId !== "all" && readSnapshot().entities.some((entity) => entity.type === "workspace" && entity.workspaceId === workspaceId);
}

function accountRow() {
  return getDatabase().prepare("SELECT * FROM calendar_accounts WHERE provider = 'icloud' ORDER BY created_at LIMIT 1").get() as Record<string, unknown> | undefined;
}

export function requireAccount() {
  const account = accountRow();
  if (!account) throw new Error("No iCloud account is connected");
  return account;
}

export function storedCredentials(account: Record<string, unknown>) {
  return calDavCredentials(account);
}

export function discoverICloud(credentials: CalDavCredentials) {
  return discoverCalendars(credentials, calDavOptions());
}

/** The calendars of a discovery as the browser sees them, with the current selection when an account exists. */
export function calendarChoices(discovery: CalDavDiscovery): ICloudCalendarChoice[] {
  const account = accountRow();
  const selected = new Map<string, string>();
  if (account) {
    for (const source of getDatabase().prepare("SELECT encrypted_url, workspace_id FROM calendar_sources WHERE account_id = ?").all(String(account.id)) as Array<{ encrypted_url: string; workspace_id: string }>) {
      try { selected.set(calendarKey(decrypt(source.encrypted_url)), source.workspace_id); } catch { /* unreadable after a key change */ }
    }
  }
  return discovery.calendars.map((calendar) => ({
    id: calendar.id, name: calendar.displayName, color: calendar.color,
    selected: selected.has(calendar.id), workspaceId: selected.get(calendar.id) ?? null,
  }));
}

/** The selection a request names, mapped to calendars of a server-side discovery (an address from the client is never used). */
export function parseSelection(value: unknown, discovery: CalDavDiscovery) {
  if (!Array.isArray(value) || value.length === 0) throw new Error("Choose at least one calendar");
  if (value.length > MAX_SELECTED_CALENDARS) throw new Error("Too many calendars are selected");
  const seen = new Set<string>();
  return value.map((item) => {
    const id = typeof item?.id === "string" ? item.id : "";
    const workspaceId = typeof item?.workspaceId === "string" ? item.workspaceId : "";
    const calendar = discovery.calendars.find((candidate) => candidate.id === id);
    if (!calendar || seen.has(id)) throw new Error("A selected calendar is no longer available in iCloud");
    seen.add(id);
    if (!workspaceExists(workspaceId)) throw new Error("Workspace not found");
    return { calendar, workspaceId };
  });
}

function insertSources(accountId: string, selection: ReturnType<typeof parseSelection>, now: number) {
  const insert = getDatabase().prepare(`INSERT INTO calendar_sources
    (id, workspace_id, provider, label, encrypted_url, status, created_at, updated_at, account_id)
    VALUES (?, ?, 'caldav', ?, ?, 'pending', ?, ?, ?)`);
  for (const { calendar, workspaceId } of selection) insert.run(randomUUID(), workspaceId, calendar.displayName, encrypt(calendar.url), now, now, accountId);
}

function transaction<T>(write: () => T): T {
  const database = getDatabase();
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = write();
    database.exec("COMMIT");
    return result;
  } catch (error) { database.exec("ROLLBACK"); throw error; }
}

/** Stores the account and its selected calendars (after a successful discovery with these credentials). */
export function storeICloudAccount(credentials: CalDavCredentials, discovery: CalDavDiscovery, selectionInput: unknown) {
  const selection = parseSelection(selectionInput, discovery);
  if (accountRow()) throw new Error("An iCloud account is already connected");
  const id = randomUUID();
  const now = Date.now();
  ensureDailyBackup();
  transaction(() => {
    if (accountRow()) throw new Error("An iCloud account is already connected");
    getDatabase().prepare(`INSERT INTO calendar_accounts
      (id, provider, label, encrypted_credentials, principal_url, home_url, status, last_error, last_success_at, revision, created_at, updated_at)
      VALUES (?, 'icloud', ?, ?, ?, ?, 'ready', NULL, NULL, 1, ?, ?)`)
      .run(id, maskAppleId(credentials.username), encrypt(JSON.stringify(credentials)), encrypt(discovery.principalUrl), encrypt(discovery.homeUrl), now, now);
    insertSources(id, selection, now);
  });
  return id;
}

/** Replaces the stored password (validated by a discovery with it) and lifts a refused-password stop. */
export function replaceICloudPassword(accountId: string, credentials: CalDavCredentials, discovery: CalDavDiscovery) {
  const now = Date.now();
  ensureDailyBackup();
  transaction(() => {
    const changed = getDatabase().prepare(`UPDATE calendar_accounts SET encrypted_credentials=?, principal_url=?, home_url=?, status='ready',
      last_error=NULL, revision=revision+1, updated_at=? WHERE id=?`)
      .run(encrypt(JSON.stringify(credentials)), encrypt(discovery.principalUrl), encrypt(discovery.homeUrl), now, accountId);
    if (Number(changed.changes) !== 1) throw new Error("No iCloud account is connected");
    // The calendars are fetched again with the new password.
    getDatabase().prepare("UPDATE calendar_sources SET status='pending', last_error=NULL, updated_at=? WHERE account_id=? AND status='error'").run(now, accountId);
  });
}

/** Changes which calendars are read and their workspaces. A calendar that moves to another workspace is fetched again. */
export function applyICloudSelection(accountId: string, discovery: CalDavDiscovery, selectionInput: unknown) {
  const selection = parseSelection(selectionInput, discovery);
  const now = Date.now();
  ensureDailyBackup();
  transaction(() => {
    const database = getDatabase();
    if (!calDavAccountRow(accountId)) throw new Error("No iCloud account is connected");
    const existing = database.prepare("SELECT id, encrypted_url, workspace_id FROM calendar_sources WHERE account_id = ?").all(accountId) as Array<{ id: string; encrypted_url: string; workspace_id: string }>;
    const byKey = new Map<string, { id: string; workspace_id: string }>();
    for (const source of existing) {
      let key = `unreadable:${source.id}`;
      try { key = calendarKey(decrypt(source.encrypted_url)); } catch { /* removed below unless selected again */ }
      byKey.set(key, source);
    }
    const wanted = new Set(selection.map((item) => item.calendar.id));
    for (const [key, source] of byKey) {
      if (wanted.has(key)) continue;
      database.prepare("DELETE FROM calendar_events WHERE source_id = ?").run(source.id);
      database.prepare("DELETE FROM calendar_sources WHERE id = ?").run(source.id);
    }
    const added: typeof selection = [];
    for (const item of selection) {
      const source = byKey.get(item.calendar.id);
      if (!source) { added.push(item); continue; }
      if (source.workspace_id === item.workspaceId) {
        database.prepare("UPDATE calendar_sources SET label=?, updated_at=? WHERE id=?").run(item.calendar.displayName, now, source.id);
        continue;
      }
      database.prepare("DELETE FROM calendar_events WHERE source_id = ?").run(source.id);
      database.prepare(`UPDATE calendar_sources SET workspace_id=?, label=?, status='pending', last_sync_at=NULL, last_success_at=NULL,
        event_count=0, revision=revision+1, updated_at=? WHERE id=?`).run(item.workspaceId, item.calendar.displayName, now, source.id);
    }
    insertSources(accountId, added, now);
    database.prepare("UPDATE calendar_accounts SET revision=revision+1, updated_at=? WHERE id=? AND status != 'syncing'").run(now, accountId);
  });
}

/** Removes the account, its calendars and their cached events in one transaction. */
export function disconnectICloud(accountId: string) {
  ensureDailyBackup();
  return transaction(() => {
    const database = getDatabase();
    database.prepare("DELETE FROM calendar_events WHERE source_id IN (SELECT id FROM calendar_sources WHERE account_id = ?)").run(accountId);
    database.prepare("DELETE FROM calendar_sources WHERE account_id = ?").run(accountId);
    return Number(database.prepare("DELETE FROM calendar_accounts WHERE id = ?").run(accountId).changes) === 1;
  });
}

/** A discovery with the stored credentials that Apple refused stops automatic refreshes, like a refused refresh. */
export function recordRefusedPassword(accountId: string) {
  ensureDailyBackup();
  markCalDavAccount(accountId, "auth_failed", "Apple refused the app-specific password");
}

export function getICloudAccountState(): ICloudAccountState | null {
  const account = accountRow();
  if (!account) return null;
  const sources = getDatabase().prepare("SELECT * FROM calendar_sources WHERE account_id = ? ORDER BY created_at").all(String(account.id)) as Array<Record<string, unknown>>;
  const lastSuccessAt = account.last_success_at == null ? null : Number(account.last_success_at);
  const stored = String(account.status);
  const status: ICloudAccountState["status"] = stored === "auth_failed" || stored === "error" || stored === "syncing" ? stored
    : !lastSuccessAt ? "pending" : Date.now() - lastSuccessAt > 24 * 60 * 60_000 ? "stale" : "ready";
  return {
    label: String(account.label), status, lastSuccessAt, lastError: String(account.last_error || ""),
    calendars: sources.map((source) => {
      let id = `unreadable-${String(source.id).slice(0, 8)}`;
      try { id = calendarKey(decrypt(String(source.encrypted_url))); } catch { /* the calendar key changed */ }
      return {
        id, sourceId: String(source.id), label: String(source.label), workspaceId: String(source.workspace_id), status: String(source.status),
        eventCount: Number(source.event_count || 0), lastSuccessAt: source.last_success_at == null ? null : Number(source.last_success_at),
        lastError: String(source.last_error || ""),
      };
    }),
  };
}

export function iCloudAccountId() {
  return accountRow()?.id as string | undefined;
}
