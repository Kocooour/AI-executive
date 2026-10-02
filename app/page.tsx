"use client";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
} from "@simplewebauthn/browser";
import {
  db,
  ensureDefaultWorkspace,
  personalWorkspaceId,
  seed,
  migratePropertyRelations,
  type Entity,
  type EntityType,
} from "../lib/db";
import { buildContext, type ContextBundle } from "../lib/context";
import type { AIMessage } from "../lib/ai-provider";
import { mergeSnapshots, type ServerSnapshot } from "../lib/server-sync";

interface BackupSummary {
  name: string;
  createdAt: number;
  entityCount: number;
  relationCount: number;
  error?: string;
}

interface PasskeySummary {
  id: string;
  label: string;
  rpId: string;
  createdAt: number;
  lastUsedAt: number | null;
  backedUp: boolean;
}

interface NotificationPreferences {
  enabled: boolean;
  timezone: string;
  workdayStart: string;
  workdayEnd: string;
  workdays: number[];
  briefingEnabled: boolean;
  morningBriefEnabled: boolean;
  morningBriefTime: string;
  eveningReviewEnabled: boolean;
  eveningReviewTime: string;
  briefingWorkspaceId: string;
  briefingPush: boolean;
  briefingTelegram: boolean;
  dailyTaskCapacity: number;
}

interface ExecutiveBriefing {
  id: string;
  kind: "morning" | "evening";
  workspaceId: string;
  workspaceName: string;
  localDate: string;
  title: string;
  summary: string;
  topTasks: Array<{ id: string; title: string; reason: string }>;
  overdueCount: number;
  riskCount: number;
  completedCount: number;
  remainingCount: number;
  capacity: number;
  overloaded: boolean;
  suggestions: string[];
  createdAt: number;
}

interface DayPlanItem {
  taskId: string;
  title: string;
  estimatedMinutes: number;
  reason: "overdue" | "today" | "deadline" | "priority";
  start?: string;
  end?: string;
}

interface DayPlan {
  revision: number;
  workspaceId: string;
  date: string;
  timezone: string;
  calendar: "ready" | "missing" | "stale" | "non-workday";
  freeMinutes: number | null;
  requiredMinutes: number;
  overloaded: boolean;
  existingBlocks: DayPlanItem[];
  planBlocks: DayPlanItem[];
  unscheduled: DayPlanItem[];
}

interface PACTAgentSummary {
  id: string;
  name: string;
  version: number;
  instructions: string;
  tools: string[];
  triggerModes: string[];
}

interface PACTAgentRunSummary {
  id: string;
  agentId: string;
  workspaceId: string;
  triggerMode: string;
  status: "running" | "completed" | "failed";
  inputSummary: string;
  outputSummary: string | null;
  createdAt: number;
  completedAt: number | null;
}

interface PACTAgentResult {
  agentId: string;
  title: string;
  summary: string;
  recommendations: string[];
  createdAt: number;
}

interface CaptureSuggestion {
  projectId: string;
  projectTitle: string;
  areaId: string;
  areaTitle: string;
  priority: "none" | "low" | "medium" | "high";
  estimatedMinutes: number;
  scheduledStart: string;
  scheduledEnd: string;
  scheduledDate: string;
  scheduledOptions: Array<{ start: string; end: string; date: string }>;
  confidence: "low" | "medium" | "high";
  reasons: string[];
  constraints: string[];
}

interface CalendarSourceState {
  id: string;
  workspaceId: string;
  label: string;
  status: string;
  configured: boolean;
  lastSyncAt: number | null;
  lastSuccessAt: number | null;
  lastError: string;
  eventCount: number;
  revision: number;
}

interface CalendarEvent {
  id: string;
  sourceId: string;
  workspaceId: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  timezone: string;
  status: string;
  busy: boolean;
  private: boolean;
}

interface DurableContextItem {
  id: string;
  workspaceId: string;
  scope: "me" | "work" | "family" | "rules" | "project" | "workspace";
  sensitivity: "normal" | "sensitive";
  provenance: "owner" | "imported" | "ai-suggested";
  status: "active" | "archived" | "pending";
  title: string;
  content: string;
  projectId?: string;
  createdAt: number;
  updatedAt: number;
}

interface NotificationState {
  publicKey: string;
  subscriptionCount: number;
  preferences: NotificationPreferences;
}

interface AIProposal {
  id: string;
  summary: string;
  changes: Array<{ label: string; value: string }>;
  expiresAt: number;
}

interface AssistantMessage extends AIMessage {
  proposal?: AIProposal;
  actionId?: string;
  resolved?: boolean;
}

const views = [
    "Home",
    "Inbox",
    "Today",
    "Overdue",
    "Upcoming",
    "Anytime",
    "Someday",
    "Completed",
    "Projects",
    "Areas",
    "Notes",
    "Agents",
  ];
const moreViews = [
  "Inbox",
  "Overdue",
  "Upcoming",
  "Anytime",
  "Someday",
  "Completed",
  "Areas",
  "Notes",
  "Agents",
  "Settings",
];
const viewIcons: Record<string, string> = {
  Home: "⌂",
  Inbox: "↓",
  Today: "○",
  Overdue: "!",
  Upcoming: "→",
  Anytime: "•",
  Someday: "☾",
  Completed: "✓",
  Projects: "◇",
  Areas: "◎",
  Notes: "▤",
  Agents: "◇",
  Settings: "⚙",
  More: "•••",
};
const mobileViews = ["Home", "Today", "+", "Projects", "More"];
type Language = "cs" | "en";
type ThemeMode = "system" | "light" | "dark";
const copy: Record<Language, Record<string, string>> = {
  en: {
    Home: "Home", Inbox: "Inbox", Today: "Today", Overdue: "Overdue",
    Upcoming: "Upcoming", Anytime: "Anytime", Someday: "Someday",
    Completed: "Completed", Projects: "Projects", Areas: "Areas",
    Notes: "Notes", Agents: "Agents", Settings: "Settings", More: "More", Search: "Search",
    new: "New", search: "Search everything", askAi: "Ask AI",
    appearance: "Appearance", systemTheme: "System", lightTheme: "Light", darkTheme: "Dark",
    switchLight: "Switch to light mode", switchDark: "Switch to dark mode",
    goodMorning: "Good morning", goodAfternoon: "Good afternoon", goodEvening: "Good evening",
    homeSubtitle: "Here is the shape of your day.", seeAll: "See all",
    nothingToday: "Nothing planned for today.", addTask: "Add a task",
    inboxDescription: "Items waiting to be organized.", openInbox: "Open inbox",
    noProjects: "No active projects.", noUpcoming: "Nothing scheduled yet.", recent: "Recent",
    priority: "Priority", sort: "Sort", all: "All", manual: "Manual", date: "Date",
    newest: "Newest", high: "High", medium: "Medium", low: "Low", none: "None",
    nothingHere: "Nothing here yet.", moveToSection: "Move item", add: "Add",
    currentView: "Current view", allWork: "All my work", createIn: "Create new items in",
    workspaceName: "Workspace name", save: "Save", workspaceSaved: "Workspace saved.",
    role: "Role", newWorkspace: "New shared workspace", create: "Create",
    openStartup: "Open on startup", language: "Language", english: "English", czech: "Czech",
    dataAi: "Data & AI", storedItems: "Stored items", relations: "Relations",
    serverSync: "Server sync", synced: "Synced", syncing: "Syncing…", offline: "Offline", connecting: "Connecting…", installApp: "Install app",
    access: "Access", reminders: "Reminders", backups: "Backups",
    yesterday: "Yesterday", tomorrow: "Tomorrow", deadline: "deadline", dueSoon: "Due soon",
    quickCapture: "Quick Capture", addNote: "Add note", workspace: "Workspace",
    noteTitle: "Note title", taskTitle: "Task title", taskPrompt: "What needs to be done?",
    untitledTask: "Untitled task", cancel: "Cancel", list: "List", when: "When",
    project: "Project", area: "Area", task: "Task", note: "Note", reminder: "Reminder", taskNotes: "Task notes",
    captureExample: "Try “Call Peter tomorrow” or “Service 25 Sep #high”",
    albertSuggestion: "Albert’s suggestion", suggesting: "Albert is preparing a suggestion…",
    useSuggestion: "Use Albert’s suggestion", confidence: "Confidence", duration: "Estimated duration",
    minutes: "minutes", plannedTime: "Suggested time", noFreeSlot: "No reliable free slot found",
    noPlannedTime: "Do not schedule yet",
    whySuggested: "Why", constraintsUsed: "Constraints used", suggestionUnavailable: "Suggestion is temporarily unavailable.", retry: "Retry",
    moveItemNamed: "Move", dragToMove: "Drag to reorder or move",
    openTasks: "Open tasks", checklist: "Checklist", addChecklistItem: "Add checklist item",
    repeat: "Repeat", never: "Never", daily: "Daily", weekly: "Weekly", monthly: "Monthly", yearly: "Yearly",
    every: "Every", repeatFrom: "Repeat from", scheduledDate: "Scheduled date", completionDate: "Completion date",
    nextWorkday: "Remind at next workday start", history: "History", moveSomeday: "Move to Someday",
    reopen: "Reopen", complete: "Complete", delete: "Delete", notesPlaceholder: "Notes…",
    manageWorkspaces: "Manage workspaces", password: "Password", signIn: "Sign in",
    checkingAccess: "Checking access…", setupRequired: "Setup required", signInPasskey: "Sign in with passkey",
    checking: "Checking…", workspaceDataInfo: "Your workspace data is stored in the server database and cached locally for fast access. AI uses the server provider when configured and falls back to a local preview otherwise.",
    installedApp: "AI Executive is running as an installed app.", installHelp: "On iPhone, use Share → Add to Home Screen. On Mac, use your browser’s Install or Add to Dock command.",
    installed: "Installed", browserMode: "Browser mode", ownerSession: "This device has an authenticated owner session.",
    appBadge: "App icon badge", badgeApi: "Badge API", notificationPermission: "Notification permission",
    currentBadgeCount: "Current attention count", supported: "Supported", unsupported: "Not supported", allowed: "Allowed", notAllowed: "Not allowed",
    testBadge: "Test badge (1)", restoreBadge: "Restore current count", badgeTesting: "Testing the app icon badge…",
    badgeTestReady: "Test badge set to 1. Leave the app and check its Home Screen icon.",
    badgeRestored: "The current task count was applied to the app icon.", badgeInstallRequired: "Open Albert from its Home Screen icon; badges are unavailable in a regular Safari tab.",
    badgePermissionRequired: "Allow notifications for Albert before testing the badge.", badgeUnavailable: "This installation does not expose the App Badging API.",
    badgeFailed: "The badge could not be changed. Check the system Badges setting and try again.",
    badgeSystemHint: "iOS does not let websites read the system Badges switch. If the test still does not appear, open Settings → Apps → AI Executive → Notifications and enable Badges.",
    passkeyName: "Passkey name", confirmPassword: "Confirm current password", addPasskey: "Add passkey",
    waitingDevice: "Waiting for device…", remove: "Remove", signOut: "Sign out",
    reminderInfo: "Push reminders are sent by the server even when the app is closed. On iPhone, first install the app on the Home Screen and open the HTTPS address.",
    devices: "devices", noDevice: "No device", enableDevice: "Enable on this device", sendTest: "Send test",
    disableDevice: "Disable this device", scheduledReminders: "Send scheduled reminders", timezone: "Timezone",
    workdayStarts: "Workday starts", workdayEnds: "Workday ends", workingDays: "Working days",
    createBackup: "Create backup", noBackups: "No backups yet.", restore: "Restore",
    openCount: "open", dailyBrief: "Daily brief", morningBrief: "Morning brief", eveningReview: "Evening review",
    dayPlanTitle: "Albert’s day plan", dayPlanReady: "Available calendar time; proposed blocks need your approval.",
    dayPlanMissing: "Connect a calendar to get reliable time blocks. Tasks are listed without exact times.",
    dayPlanStale: "Refresh the calendar before scheduling exact times.", dayPlanNonWorkday: "This is outside your working days; no time blocks are suggested.",
    dayPlanOverloaded: "Today’s work exceeds the available capacity.", dayPlanExisting: "Already planned", dayPlanSuggested: "Suggested", dayPlanUnscheduled: "No suitable block",
    dayPlanEmpty: "No tasks need a new block today.", dayPlanChanged: "The plan changed. Review the updated suggestion.",
    dayPlanSyncFirst: "Sync your pending changes before confirming the plan.", dayPlanUndo: "Undo last accepted block",
    acceptBlock: "Accept", anotherTime: "Another time", moveTomorrow: "Tomorrow", skipPlanning: "Do not schedule",
    confirmDayPlanAction: "Confirm for task:",
    dayPlanReasonOverdue: "Overdue", dayPlanReasonToday: "Due today", dayPlanReasonDeadline: "Deadline soon", dayPlanReasonPriority: "High priority",
    capacityExceeded: "Capacity is exceeded.", capacityEstimate: "This is an indicative estimate without calendar and time estimates.",
    firstBrief: "Create the first brief or enable the automatic schedule in Settings.", todayCapacity: "Today’s capacity",
    calendarDisconnected: "Calendar not connected", freeHours: "h free", capacityUnknown: "Capacity unverified",
    calendarStale: "Calendar availability is unknown or stale. Do not use free-time planning now.", noBlockingEvent: "No blocking event during working hours today.",
    allDay: "All day", busy: "busy", freeTime: "free time", nearestFree: "Nearest free slots:", readOnlyEvents: "Events are read-only. Overlaps count as busy time only once.",
    calendarReadonly: "Calendar · read only", calendarInfo: "Connect a private HTTPS link in ICS format. The address is encrypted on the server, is never returned to the browser after saving, and AI Executive cannot change the calendar.",
    readOnly: "Read only", notConnected: "Not connected", sourceName: "Source name", privateIcs: "Private ICS link", connectLoad: "Connect and load",
    events: "events", syncFailed: "Synchronization failed", lastSync: "last", refresh: "Refresh", disconnect: "Disconnect",
    proactiveInfo: "Automatic morning brief and evening review. Tasks are never changed without a proposal, your confirmation, and an Undo option.",
    createNow: "Create now", automaticBriefs: "Automatic daily briefs", morningTime: "Morning time", eveningTime: "Evening time",
    dailyCapacity: "Indicative daily capacity", briefPush: "Short push notification", briefTelegram: "Details including task names to the configured Telegram chat",
    backupInfo: "Daily safety copies are created automatically before changes.", items: "items",
    context: "Context", assistant: "Assistant", todayBrief: "Today’s brief", confirm: "Confirm",
    undoAi: "Undo AI change", working: "Working…", send: "Send", itemChanged: "Item changed", undo: "Undo",
    agentsIntro: "Run focused AIfréd agents for one workspace. Agents can read only their allowed context and tools; changes remain approval-bound.",
    runAgent: "Run agent", latestResult: "Latest result", runHistory: "Run history", noAgentRuns: "No agent has run in this workspace yet.",
    completedRun: "Completed", failedRun: "Failed", runningRun: "Running", recommendations: "Recommendations",
  },
  cs: {
    Home: "Domů", Inbox: "Doručené", Today: "Dnes", Overdue: "Po termínu",
    Upcoming: "Nadcházející", Anytime: "Kdykoli", Someday: "Někdy",
    Completed: "Dokončené", Projects: "Projekty", Areas: "Oblasti",
    Notes: "Poznámky", Agents: "Agenti", Settings: "Nastavení", More: "Více", Search: "Hledání",
    new: "Nový", search: "Hledat ve všem", askAi: "Zeptat se AI",
    appearance: "Vzhled", systemTheme: "Podle systému", lightTheme: "Světlý", darkTheme: "Tmavý",
    switchLight: "Přepnout na světlý režim", switchDark: "Přepnout na tmavý režim",
    goodMorning: "Dobré ráno", goodAfternoon: "Dobré odpoledne", goodEvening: "Dobrý večer",
    homeSubtitle: "Takhle vypadá váš dnešní den.", seeAll: "Zobrazit vše",
    nothingToday: "Na dnešek není nic naplánováno.", addTask: "Přidat úkol",
    inboxDescription: "Položky čekající na roztřídění.", openInbox: "Otevřít doručené",
    noProjects: "Žádné aktivní projekty.", noUpcoming: "Nic dalšího není naplánováno.", recent: "Nedávné",
    priority: "Priorita", sort: "Řazení", all: "Vše", manual: "Ručně", date: "Datum",
    newest: "Nejnovější", high: "Vysoká", medium: "Střední", low: "Nízká", none: "Žádná",
    nothingHere: "Zatím tu nic není.", moveToSection: "Přesunout položku", add: "Přidat",
    currentView: "Aktuální pohled", allWork: "Všechna práce", createIn: "Nové položky vytvářet v",
    workspaceName: "Název workspace", save: "Uložit", workspaceSaved: "Workspace uložen.",
    role: "Role", newWorkspace: "Nový sdílený workspace", create: "Vytvořit",
    openStartup: "Otevřít po spuštění", language: "Jazyk", english: "Angličtina", czech: "Čeština",
    dataAi: "Data a AI", storedItems: "Uložené položky", relations: "Vztahy",
    serverSync: "Synchronizace", synced: "Synchronizováno", syncing: "Synchronizuji…", offline: "Offline", connecting: "Připojuji…", installApp: "Instalace aplikace",
    access: "Přístup", reminders: "Připomínky", backups: "Zálohy",
    yesterday: "Včera", tomorrow: "Zítra", deadline: "termín", dueSoon: "Termín se blíží",
    quickCapture: "Rychlé zadání", addNote: "Přidat poznámku", workspace: "Workspace",
    noteTitle: "Název poznámky", taskTitle: "Název úkolu", taskPrompt: "Co je potřeba udělat?",
    untitledTask: "Úkol bez názvu", cancel: "Zrušit", list: "Seznam", when: "Kdy",
    project: "Projekt", area: "Oblast", task: "Úkol", note: "Poznámka", reminder: "Připomínka", taskNotes: "Poznámky k úkolu",
    captureExample: "Zkuste „Zavolat Petrovi zítra“ nebo „Servis 25. 9. #high“",
    albertSuggestion: "Albertův návrh", suggesting: "Albert připravuje návrh…",
    useSuggestion: "Použít Albertův návrh", confidence: "Jistota", duration: "Odhadovaná náročnost",
    minutes: "minut", plannedTime: "Navržený čas", noFreeSlot: "Spolehlivý volný blok nebyl nalezen",
    noPlannedTime: "Zatím neplánovat",
    whySuggested: "Proč", constraintsUsed: "Použitá omezení", suggestionUnavailable: "Návrh se teď nepodařilo připravit.", retry: "Zkusit znovu",
    moveItemNamed: "Přesunout", dragToMove: "Přetažením změnit pořadí nebo umístění",
    openTasks: "Otevřené úkoly", checklist: "Kontrolní seznam", addChecklistItem: "Přidat položku",
    repeat: "Opakování", never: "Nikdy", daily: "Denně", weekly: "Týdně", monthly: "Měsíčně", yearly: "Ročně",
    every: "Každých", repeatFrom: "Opakovat od", scheduledDate: "Plánovaného data", completionDate: "Data dokončení",
    nextWorkday: "Připomenout na začátku příštího pracovního dne", history: "Historie", moveSomeday: "Přesunout na Někdy",
    reopen: "Znovu otevřít", complete: "Dokončit", delete: "Smazat", notesPlaceholder: "Poznámky…",
    manageWorkspaces: "Spravovat workspace", password: "Heslo", signIn: "Přihlásit se",
    checkingAccess: "Ověřuji přístup…", setupRequired: "Je nutné dokončit nastavení", signInPasskey: "Přihlásit se passkeyem",
    checking: "Ověřuji…", workspaceDataInfo: "Data workspace jsou uložená v databázi serveru a pro rychlý přístup také v místní mezipaměti. AI používá nakonfigurovaného poskytovatele na serveru, jinak místní náhled.",
    installedApp: "AI Executive běží jako nainstalovaná aplikace.", installHelp: "Na iPhonu použijte Sdílet → Přidat na plochu. Na Macu použijte v prohlížeči Instalovat nebo Přidat do Docku.",
    installed: "Nainstalováno", browserMode: "Režim prohlížeče", ownerSession: "Toto zařízení má ověřenou relaci vlastníka.",
    appBadge: "Odznak na ikoně aplikace", badgeApi: "API odznaku", notificationPermission: "Oprávnění oznámení",
    currentBadgeCount: "Aktuální počet důležitých úkolů", supported: "Podporováno", unsupported: "Nepodporováno", allowed: "Povoleno", notAllowed: "Nepovoleno",
    testBadge: "Otestovat odznak (1)", restoreBadge: "Obnovit skutečný počet", badgeTesting: "Testuji odznak na ikoně…",
    badgeTestReady: "Testovací odznak je nastavený na 1. Opusťte aplikaci a zkontrolujte její ikonu na ploše.",
    badgeRestored: "Na ikonu byl nastaven aktuální počet úkolů.", badgeInstallRequired: "Otevřete Alberta jeho ikonou na ploše; v běžném panelu Safari nejsou odznaky dostupné.",
    badgePermissionRequired: "Před testem odznaku povolte Albertovi oznámení.", badgeUnavailable: "Tato instalace neposkytuje API pro odznak aplikace.",
    badgeFailed: "Odznak se nepodařilo změnit. Zkontrolujte systémové nastavení Odznaky a zkuste to znovu.",
    badgeSystemHint: "iOS webu neumožňuje zjistit stav systémového přepínače Odznaky. Pokud se test neukáže, otevřete Nastavení → Aplikace → AI Executive → Oznámení a zapněte Odznaky.",
    passkeyName: "Název passkeye", confirmPassword: "Potvrďte současné heslo", addPasskey: "Přidat passkey",
    waitingDevice: "Čekám na zařízení…", remove: "Odebrat", signOut: "Odhlásit se",
    reminderInfo: "Push připomínky odesílá server, i když je aplikace zavřená. Na iPhonu ji nejprve přidejte na plochu a otevřete přes HTTPS adresu.",
    devices: "zařízení", noDevice: "Žádné zařízení", enableDevice: "Povolit na tomto zařízení", sendTest: "Poslat test",
    disableDevice: "Zakázat na tomto zařízení", scheduledReminders: "Posílat naplánované připomínky", timezone: "Časové pásmo",
    workdayStarts: "Začátek pracovního dne", workdayEnds: "Konec pracovního dne", workingDays: "Pracovní dny",
    createBackup: "Vytvořit zálohu", noBackups: "Zatím nejsou žádné zálohy.", restore: "Obnovit",
    openCount: "otevřeno", dailyBrief: "Denní přehled", morningBrief: "Ranní přehled", eveningReview: "Večerní rekapitulace",
    dayPlanTitle: "Albertův plán dne", dayPlanReady: "Volný čas v kalendáři; navržené bloky čekají na schválení.",
    dayPlanMissing: "Pro spolehlivé časové bloky připojte kalendář. Úkoly jsou zatím bez přesného času.",
    dayPlanStale: "Před plánováním přesného času obnovte kalendář.", dayPlanNonWorkday: "Dnes není pracovní den; časové bloky nenavrhuji.",
    dayPlanOverloaded: "Dnešní práce přesahuje dostupnou kapacitu.", dayPlanExisting: "Již naplánováno", dayPlanSuggested: "Návrh", dayPlanUnscheduled: "Bez vhodného bloku",
    dayPlanEmpty: "Dnes není potřeba plánovat další úkoly.", dayPlanChanged: "Plán se změnil. Zkontrolujte nový návrh.",
    dayPlanSyncFirst: "Před potvrzením plánu synchronizujte čekající změny.", dayPlanUndo: "Vrátit poslední přijatý blok",
    acceptBlock: "Přijmout", anotherTime: "Jiný čas", moveTomorrow: "Zítra", skipPlanning: "Neplánovat",
    confirmDayPlanAction: "Potvrdit pro úkol:",
    dayPlanReasonOverdue: "Po termínu", dayPlanReasonToday: "Na dnes", dayPlanReasonDeadline: "Blízký termín", dayPlanReasonPriority: "Vysoká priorita",
    capacityExceeded: "Kapacita je překročena.", capacityEstimate: "Jde o orientační odhad bez kalendáře a časových odhadů.",
    firstBrief: "Vytvořte první přehled nebo zapněte automatický plán v Nastavení.", todayCapacity: "Dnešní kapacita",
    calendarDisconnected: "Kalendář není připojen", freeHours: "h volno", capacityUnknown: "Kapacita neověřena",
    calendarStale: "Dostupnost kalendáře je neznámá nebo zastaralá. Plán podle volných bloků nyní nepoužívejte.", noBlockingEvent: "V pracovní době dnes nemáte žádnou blokující událost.",
    allDay: "Celý den", busy: "obsazeno", freeTime: "volný čas", nearestFree: "Nejbližší volné bloky:", readOnlyEvents: "Události jsou pouze pro čtení. Překryvy se do obsazeného času počítají jen jednou.",
    calendarReadonly: "Kalendář · pouze pro čtení", calendarInfo: "Připojte soukromý HTTPS odkaz ve formátu ICS. Adresa se na serveru šifruje, po uložení se už do prohlížeče nevrací a AI Executive nemůže kalendář měnit.",
    readOnly: "Pouze pro čtení", notConnected: "Nepřipojeno", sourceName: "Název zdroje", privateIcs: "Soukromý ICS odkaz", connectLoad: "Připojit a načíst",
    events: "událostí", syncFailed: "Synchronizace selhala", lastSync: "naposledy", refresh: "Obnovit", disconnect: "Odpojit",
    proactiveInfo: "Automatický ranní přehled a večerní rekapitulace. Úkoly nikdy nemění bez návrhu, vašeho potvrzení a možnosti Zpět.",
    createNow: "Vytvořit teď", automaticBriefs: "Automatické denní přehledy", morningTime: "Čas ráno", eveningTime: "Čas večer",
    dailyCapacity: "Orientační denní kapacita", briefPush: "Stručné push upozornění", briefTelegram: "Detail včetně názvů úkolů do nakonfigurovaného Telegram chatu",
    backupInfo: "Denní bezpečnostní kopie se vytvářejí automaticky před změnami.", items: "položek",
    context: "Kontext", assistant: "Asistent", todayBrief: "Dnešní přehled", confirm: "Potvrdit",
    undoAi: "Vrátit změnu AI", working: "Pracuji…", send: "Odeslat", itemChanged: "Položka změněna", undo: "Zpět",
    agentsIntro: "Spouštějte specializované agenty AIfréda nad jedním workspace. Agenti vidí jen povolený kontext a nástroje; změny nadále vyžadují potvrzení.",
    runAgent: "Spustit agenta", latestResult: "Poslední výsledek", runHistory: "Historie běhů", noAgentRuns: "V tomto workspace zatím žádný agent neběžel.",
    completedRun: "Dokončeno", failedRun: "Selhalo", runningRun: "Probíhá", recommendations: "Doporučení",
  },
};
const ymd = (d = new Date()) =>
  [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, "0"),
    String(d.getDate()).padStart(2, "0"),
  ].join("-");
const manualOrder = (entity: Entity, scope = `${entity.type}:all`) => {
  const stored = entity.properties.manualOrders;
  const workspaceScope = `${entity.workspaceId}:${scope}`;
  const value = Number(
    stored && typeof stored === "object" && !Array.isArray(stored)
      ? (stored as Record<string, unknown>)[workspaceScope] ??
        (stored as Record<string, unknown>)[scope]
      : entity.properties.manualOrder,
  );
  return Number.isFinite(value) ? value : entity.createdAt;
};
const byManualOrder = (scope?: string) => (a: Entity, b: Entity) =>
  manualOrder(a, scope) - manualOrder(b, scope) || a.createdAt - b.createdAt || a.id.localeCompare(b.id);
const addLocalDays = (date: Date, days: number) => {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
};
const friendlyDate = (value: unknown, language: Language) => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return typeof value === "string" ? value : "";
  }
  if (value === ymd(addLocalDays(new Date(), -1))) return copy[language].yesterday;
  if (value === ymd()) return copy[language].Today;
  if (value === ymd(addLocalDays(new Date(), 1))) return copy[language].tomorrow;
  return new Date(`${value}T12:00:00`).toLocaleDateString(language === "cs" ? "cs-CZ" : "en-GB", {
    day: "numeric",
    month: "short",
    year: new Date(`${value}T12:00:00`).getFullYear() === new Date().getFullYear()
      ? undefined
      : "numeric",
  });
};
const taskDueTone = (entity: Entity, todayValue: string) => {
  if (entity.type !== "task" || entity.status !== "open") return "";
  const dueDates = [entity.properties.when, entity.properties.deadline]
    .filter((value): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value));
  if (dueDates.some((due) => due < todayValue)) return "dueOverdue";
  const tomorrowValue = ymd(addLocalDays(new Date(), 1));
  if (dueDates.some((due) => due >= todayValue && due <= tomorrowValue)) return "dueSoon";
  return "";
};
const taskDueSummary = (entity: Entity, todayValue: string, language: Language) => {
  const dueDates = [entity.properties.when, entity.properties.deadline]
    .filter((value): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value))
    .sort();
  const overdueDate = dueDates.find((due) => due < todayValue);
  if (overdueDate) return `${copy[language].Overdue} · ${friendlyDate(overdueDate, language)}`;
  const tomorrowValue = ymd(addLocalDays(new Date(), 1));
  const soonDate = dueDates.find((due) => due <= tomorrowValue);
  return soonDate ? `${copy[language].dueSoon} · ${friendlyDate(soonDate, language)}` : "";
};
const taskMatchesView = (task: Entity, targetView: string, todayValue: string) => {
  if (targetView === "Completed") return task.status === "completed";
  if (task.status !== "open") return false;
  const properties = task.properties;
  if (targetView === "Inbox") return properties.inbox === true;
  if (targetView === "Today") {
    return properties.today === true || properties.when === todayValue ||
      (typeof properties.when === "string" && properties.when < todayValue);
  }
  if (targetView === "Overdue") {
    return typeof properties.when === "string" && properties.when < todayValue;
  }
  if (targetView === "Upcoming") {
    return typeof properties.when === "string" && properties.when > todayValue;
  }
  if (targetView === "Anytime") {
    return !properties.when && !properties.someday && properties.inbox !== true;
  }
  if (targetView === "Someday") return properties.someday === true;
  return true;
};
const toLocalDateTime = (value: unknown) => {
  if (typeof value !== "string" || !value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.length === 16 ? value : "";
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
};
const fromLocalDateTime = (value: string) =>
  value ? new Date(value).toISOString() : "";
const zonedDateTimeToIso = (dateValue: string, timeValue: string, timeZone: string) => {
  const [year, month, date] = dateValue.split("-").map(Number);
  const [hour, minute] = timeValue.split(":").map(Number);
  const desired = Date.UTC(year, month - 1, date, hour, minute);
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  let candidate = desired;
  for (let iteration = 0; iteration < 2; iteration += 1) {
    const values = Object.fromEntries(
      formatter.formatToParts(new Date(candidate)).map((part) => [part.type, part.value]),
    );
    const represented = Date.UTC(
      Number(values.year),
      Number(values.month) - 1,
      Number(values.day),
      Number(values.hour),
      Number(values.minute),
    );
    candidate += desired - represented;
  }
  return new Date(candidate).toISOString();
};
const urlBase64ToUint8Array = (base64: string) => {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from([...raw].map((character) => character.charCodeAt(0)));
};

export default function App() {
  const [items, setItems] = useState<Entity[]>([]),
    [relations, setRelations] = useState<any[]>([]),
    [view, setView] = useState("Today"),
    [text, setText] = useState(""),
    [selected, setSelected] = useState<Entity | null>(null),
    [query, setQuery] = useState(""),
    [capture, setCapture] = useState(false),
    [captureType, setCaptureType] = useState<"task" | "note">("task"),
    [captureProjectId, setCaptureProjectId] = useState(""),
    [draft, setDraft] = useState(""),
    [captureSuggestion, setCaptureSuggestion] = useState<CaptureSuggestion | null>(null),
    [captureSuggestionBusy, setCaptureSuggestionBusy] = useState(false),
    [captureSuggestionError, setCaptureSuggestionError] = useState(""),
    [useCaptureSuggestion, setUseCaptureSuggestion] = useState(true),
    [undo, setUndo] = useState<Entity | null>(null),
    [context, setContext] = useState<ContextBundle | null>(null),
    [assistantOpen, setAssistantOpen] = useState(false),
    [moreOpen, setMoreOpen] = useState(false),
    [startupView, setStartupView] = useState("Today"),
    [workspaceDraft, setWorkspaceDraft] = useState("Personal"),
    [newWorkspaceDraft, setNewWorkspaceDraft] = useState(""),
    [activeWorkspaceId, setActiveWorkspaceId] = useState("personal"),
    [writeWorkspaceId, setWriteWorkspaceId] = useState("personal"),
    [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false),
    [settingsSaved, setSettingsSaved] = useState(false),
    [language, setLanguage] = useState<Language>("cs"),
    [themeMode, setThemeMode] = useState<ThemeMode>("system"),
    [resolvedTheme, setResolvedTheme] = useState<"light" | "dark">("light"),
    [themeReady, setThemeReady] = useState(false),
    [syncStatus, setSyncStatus] = useState<
      "connecting" | "synced" | "syncing" | "offline"
    >("connecting"),
    [backups, setBackups] = useState<BackupSummary[]>([]),
    [backupStatus, setBackupStatus] = useState(""),
    [standalone, setStandalone] = useState(false),
    [notificationState, setNotificationState] = useState<NotificationState | null>(null),
    [badgeNow, setBadgeNow] = useState(() => Date.now()),
    [badgeStatus, setBadgeStatus] = useState(""),
    [notificationStatus, setNotificationStatus] = useState(""),
    [briefings, setBriefings] = useState<ExecutiveBriefing[]>([]),
    [briefingBusy, setBriefingBusy] = useState(false),
    [dayPlan, setDayPlan] = useState<DayPlan | null>(null),
    [dayPlanStatus, setDayPlanStatus] = useState(""),
    [dayPlanBusy, setDayPlanBusy] = useState(false),
    [dayPlanUndo, setDayPlanUndo] = useState<{ actionId: string; workspaceId: string; date: string } | null>(null),
    [pactAgents, setPactAgents] = useState<PACTAgentSummary[]>([]),
    [agentRuns, setAgentRuns] = useState<PACTAgentRunSummary[]>([]),
    [agentResult, setAgentResult] = useState<PACTAgentResult | null>(null),
    [agentBusyId, setAgentBusyId] = useState(""),
    [agentStatus, setAgentStatus] = useState(""),
    [calendarSources, setCalendarSources] = useState<CalendarSourceState[]>([]),
    [calendarEvents, setCalendarEvents] = useState<CalendarEvent[]>([]),
    [calendarLabel, setCalendarLabel] = useState("Outlook calendar"),
    [calendarUrl, setCalendarUrl] = useState(""),
    [calendarBusy, setCalendarBusy] = useState(false),
    [calendarStatus, setCalendarStatus] = useState(""),
    [durableContext, setDurableContext] = useState<DurableContextItem[]>([]),
    [contextScope, setContextScope] = useState<DurableContextItem["scope"]>("me"),
    [contextSensitivity, setContextSensitivity] = useState<DurableContextItem["sensitivity"]>("normal"),
    [contextTitle, setContextTitle] = useState(""),
    [contextContent, setContextContent] = useState(""),
    [contextProjectId, setContextProjectId] = useState(""),
    [contextStatus, setContextStatus] = useState(""),
    [contextBusy, setContextBusy] = useState(false),
    [sortBy, setSortBy] = useState<"manual" | "date" | "priority" | "created">("manual"),
    [priorityFilter, setPriorityFilter] = useState("all"),
    [draggingId, setDraggingId] = useState(""),
    [dragTarget, setDragTarget] = useState(""),
    [checklistDraft, setChecklistDraft] = useState(""),
    [authState, setAuthState] = useState<
      "checking" | "ready" | "required" | "misconfigured"
    >("checking"),
    [authEnabled, setAuthEnabled] = useState(false),
    [authPassword, setAuthPassword] = useState(""),
    [authError, setAuthError] = useState(""),
    [passkeySupported, setPasskeySupported] = useState(false),
    [passkeyBusy, setPasskeyBusy] = useState(false),
    [passkeys, setPasskeys] = useState<PasskeySummary[]>([]),
    [passkeyLabel, setPasskeyLabel] = useState("My passkey"),
    [passkeyPassword, setPasskeyPassword] = useState(""),
    [passkeyStatus, setPasskeyStatus] = useState(""),
    [aiText, setAiText] = useState(""),
    [aiBusy, setAiBusy] = useState(false),
    [messages, setMessages] = useState<AssistantMessage[]>([]);
  const serverRevision = useRef(0);
  const tr = (key: string) => copy[language][key] || key;
  const deepLinkHandled = useRef(false);
  const captureOpener = useRef<HTMLElement | null>(null);
  const captureModalRef = useRef<HTMLFormElement | null>(null);
  const captureSuggestionVersion = useRef(0);
  const draggingIdRef = useRef("");
  const dragTargetRef = useRef("");
  const pointerDragRef = useRef({ id: "", startX: 0, startY: 0, active: false });
  const syncQueue = useRef<Promise<void>>(Promise.resolve());
  const notificationSettingsQueue = useRef<Promise<void>>(Promise.resolve());
  const localDataVersion = useRef(0);
  const calendarLoadVersion = useRef(0);
  const dayPlanLoadVersion = useRef(0);
  const calendarWorkspaceSelection = useRef("personal");
  calendarWorkspaceSelection.current = activeWorkspaceId === "all" ? writeWorkspaceId : activeWorkspaceId;
  const pendingKey = "ai-executive-pending-sync";
  const deletedKey = "ai-executive-pending-deletions";
  const revivedKey = "ai-executive-pending-revivals";
  const pendingDeletedIds = () => {
    try {
      return JSON.parse(localStorage.getItem(deletedKey) || "[]") as string[];
    } catch {
      return [];
    }
  };
  const pendingRevivedIds = () => {
    try {
      return JSON.parse(localStorage.getItem(revivedKey) || "[]") as string[];
    } catch {
      return [];
    }
  };
  async function load() {
    setItems(await db.entities.toArray());
    setRelations(await db.relations.toArray());
  }
  async function applySnapshot(snapshot: ServerSnapshot, expectedVersion?: number) {
    if (expectedVersion !== undefined && localDataVersion.current !== expectedVersion) return false;
    await db.transaction("rw", db.entities, db.relations, async () => {
      if (expectedVersion !== undefined && localDataVersion.current !== expectedVersion) {
        throw new Error("LOCAL_DATA_CHANGED");
      }
      await db.entities.clear();
      await db.relations.clear();
      if (snapshot.entities.length) await db.entities.bulkAdd(snapshot.entities);
      if (snapshot.relations.length)
        await db.relations.bulkAdd(snapshot.relations);
    });
    serverRevision.current = snapshot.revision;
    await load();
    return true;
  }
  async function putSnapshot(
    entities: Entity[],
    snapshotRelations: any[],
    baseRevision: number,
    deletedIds: string[] = [],
    revivedIds: string[] = [],
  ) {
    return fetch("/api/store", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseRevision,
        entities,
        relations: snapshotRelations,
        deletedIds,
        revivedIds,
      }),
    });
  }
  async function syncToServer() {
    const operation = syncQueue.current.then(async () => {
      setSyncStatus("syncing");
      localStorage.setItem(pendingKey, "1");
      const localVersion = localDataVersion.current;
      const localEntities = await db.entities.toArray();
      const localRelations = await db.relations.toArray();
      let response = await putSnapshot(
        localEntities,
        localRelations,
        serverRevision.current,
        pendingDeletedIds(),
        pendingRevivedIds(),
      );
      if (response.status === 409) {
        const current = (await response.json()) as ServerSnapshot;
        const deletedIds = new Set(pendingDeletedIds());
        const revivedIds = new Set(pendingRevivedIds());
        const filteredCurrent = {
          ...current,
          tombstones: (current.tombstones || []).filter((item) => !revivedIds.has(item.id)),
          entities: current.entities.filter((entity) => !deletedIds.has(entity.id)),
          relations: current.relations.filter(
            (relation) =>
              !deletedIds.has(relation.sourceEntityId) &&
              !deletedIds.has(relation.targetEntityId),
          ),
        };
        const merged = mergeSnapshots(
          filteredCurrent,
          localEntities,
          localRelations,
        );
        response = await putSnapshot(
          merged.entities,
          merged.relations,
          current.revision,
          pendingDeletedIds(),
          pendingRevivedIds(),
        );
      }
      if (!response.ok) throw new Error("Server synchronization failed");
      const saved = (await response.json()) as ServerSnapshot;
      let applied = false;
      try {
        applied = await applySnapshot(saved, localVersion);
      } catch (error) {
        if (!(error instanceof Error) || error.message !== "LOCAL_DATA_CHANGED") throw error;
      }
      if (!applied) {
        serverRevision.current = saved.revision;
        return;
      }
      localStorage.setItem("ai-executive-server-synced", "1");
      localStorage.removeItem(pendingKey);
      localStorage.removeItem(deletedKey);
      localStorage.removeItem(revivedKey);
      setSyncStatus("synced");
    });
    syncQueue.current = operation.catch(() => {
      setSyncStatus("offline");
    });
    return syncQueue.current;
  }
  async function pullFromServer() {
    await syncQueue.current;
    if (localStorage.getItem(pendingKey) === "1") {
      await syncToServer();
      return;
    }
    try {
      const pullVersion = localDataVersion.current;
      const response = await fetch("/api/store", { cache: "no-store" });
      if (!response.ok) throw new Error("Server synchronization failed");
      const snapshot = (await response.json()) as ServerSnapshot;
      await syncQueue.current;
      if (localStorage.getItem(pendingKey) === "1") {
        await syncToServer();
        return;
      }
      if (snapshot.revision > serverRevision.current) {
        try {
          await applySnapshot(snapshot, pullVersion);
        } catch (error) {
          if (!(error instanceof Error) || error.message !== "LOCAL_DATA_CHANGED") throw error;
        }
      }
      setSyncStatus("synced");
    } catch {
      setSyncStatus("offline");
    }
  }
  async function inspect(e: Entity) {
    setSelected(e);
    setContext(await buildContext(e.id, 2));
  }
  function closeDetail() {
    setSelected(null);
    setContext(null);
  }
  async function askAI(promptOverride?: string) {
    const prompt = typeof promptOverride === "string" ? promptOverride.trim() : aiText.trim();
    if (!prompt || aiBusy) return;
    const user: { role: "user"; content: string } = {
      role: "user",
      content: prompt,
    };
    const history = [...messages, user];
    setMessages(history);
    setAiText("");
    setAiBusy(true);
    try {
      await syncQueue.current;
      if (localStorage.getItem(pendingKey) === "1") await syncToServer();
      const response = await fetch("/api/ai", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messages: history.map(({ role, content }) => ({ role, content })),
          workspaceId: activeWorkspaceId,
          writeWorkspaceId,
          focusEntityId: context?.focus.id,
        }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "Assistant request failed.");
      setMessages([...history, {
        role: "assistant",
        content: result.message,
        proposal: result.proposal,
      }]);
    } catch (error) {
      setMessages([...history, {
        role: "assistant",
        content: error instanceof Error ? error.message : "Assistant request failed.",
      }]);
    } finally {
      setAiBusy(false);
    }
  }

  async function resolveAIProposal(proposalId: string, action: "confirm" | "cancel") {
    if (aiBusy) return;
    setAiBusy(true);
    try {
      const response = await fetch("/api/ai/actions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, proposalId }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "AI action failed.");
      setMessages((current) => [
        ...current.map((message) =>
          message.proposal?.id === proposalId || (action === "confirm" && message.actionId)
            ? { ...message, resolved: true }
            : message,
        ),
        {
          role: "assistant",
          content: action === "confirm" ? result.message : "Návrh jsem zahodil. Nic se nezměnilo.",
          actionId: result.actionId,
        },
      ]);
      if (action === "confirm") await pullFromServer();
    } catch (error) {
      setMessages((current) => [...current, {
        role: "assistant",
        content: error instanceof Error ? error.message : "AI action failed.",
      }]);
    } finally {
      setAiBusy(false);
    }
  }

  async function undoAIAction(actionId: string) {
    if (aiBusy) return;
    setAiBusy(true);
    try {
      const response = await fetch("/api/ai/actions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "undo", actionId }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "Undo failed.");
      setMessages((current) => [
        ...current.map((message) => message.actionId === actionId ? { ...message, resolved: true } : message),
        { role: "assistant", content: result.message },
      ]);
      await pullFromServer();
    } catch (error) {
      setMessages((current) => [...current, {
        role: "assistant",
        content: error instanceof Error ? error.message : "Undo failed.",
      }]);
    } finally {
      setAiBusy(false);
    }
  }
  useEffect(() => {
    setPasskeySupported(browserSupportsWebAuthn());
    fetch("/api/auth/status", { cache: "no-store" })
      .then((response) => response.json())
      .then((state) => {
        setAuthEnabled(Boolean(state.enabled));
        if (state.enabled && state.configured === false) {
          setAuthError("Authentication must be configured on the server before this app can be used.");
          setAuthState("misconfigured");
          return;
        }
        setAuthState(state.authenticated ? "ready" : "required");
      })
      .catch(() => {
        setAuthError("Authentication status is unavailable.");
        setAuthState("required");
      });
  }, []);

  async function loadBriefings(workspaceId = activeWorkspaceId === "all" ? writeWorkspaceId : activeWorkspaceId) {
    const response = await fetch(`/api/executive?workspaceId=${encodeURIComponent(workspaceId)}`, { cache: "no-store" });
    if (!response.ok) throw new Error("Executive briefing is unavailable");
    const data = await response.json();
    setBriefings(Array.isArray(data.briefings) ? data.briefings : []);
    setPactAgents(Array.isArray(data.agents) ? data.agents : []);
    setAgentRuns(Array.isArray(data.agentRuns) ? data.agentRuns : []);
  }

  async function loadDayPlan(workspaceId: string, date: string) {
    const version = ++dayPlanLoadVersion.current;
    const response = await fetch(`/api/day-plan?workspaceId=${encodeURIComponent(workspaceId)}&date=${date}`, { cache: "no-store" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Day plan unavailable");
    if (version === dayPlanLoadVersion.current && calendarWorkspaceSelection.current === workspaceId) setDayPlan(data as DayPlan);
    return data as DayPlan;
  }

  async function runBriefing(kind: "morning" | "evening") {
    if (briefingBusy) return;
    setBriefingBusy(true);
    setNotificationStatus("");
    try {
      const workspaceId = activeWorkspaceId === "all" ? writeWorkspaceId : activeWorkspaceId;
      const response = await fetch("/api/executive", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind, workspaceId }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Briefing failed");
      await loadBriefings(workspaceId);
    } catch (error) {
      setNotificationStatus(error instanceof Error ? error.message : "Briefing failed");
    } finally {
      setBriefingBusy(false);
    }
  }

  async function runPACTAgent(agentId: string) {
    if (agentBusyId) return;
    const workspaceId = activeWorkspaceId === "all" ? writeWorkspaceId : activeWorkspaceId;
    setAgentBusyId(agentId);
    setAgentStatus("");
    setAgentResult(null);
    try {
      const body = agentId === "morning-planner"
        ? { kind: "morning", workspaceId, language }
        : agentId === "evening-reviewer"
          ? { kind: "evening", workspaceId, language }
          : { agentId, workspaceId, language };
      const response = await fetch("/api/executive", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Agent run failed");
      if (data.agentResult) setAgentResult(data.agentResult as PACTAgentResult);
      if (data.briefing) {
        const briefing = data.briefing as ExecutiveBriefing;
        setAgentResult({
          agentId,
          title: briefing.title,
          summary: briefing.summary,
          recommendations: briefing.suggestions,
          createdAt: briefing.createdAt,
        });
      }
      await loadBriefings(workspaceId);
    } catch (error) {
      setAgentStatus(error instanceof Error ? error.message : "Agent run failed");
    } finally {
      setAgentBusyId("");
    }
  }

  async function loadCalendar(workspaceId = activeWorkspaceId === "all" ? writeWorkspaceId : activeWorkspaceId) {
    const loadVersion = ++calendarLoadVersion.current;
    const from = Date.now() - 24 * 60 * 60_000;
    const to = Date.now() + 14 * 24 * 60 * 60_000;
    const response = await fetch(`/api/calendar?workspaceId=${encodeURIComponent(workspaceId)}&from=${from}&to=${to}`, { cache: "no-store" });
    if (!response.ok) throw new Error("Calendar is unavailable");
    const data = await response.json();
    if (loadVersion !== calendarLoadVersion.current || calendarWorkspaceSelection.current !== workspaceId) return;
    setCalendarSources(Array.isArray(data.sources) ? data.sources : []);
    setCalendarEvents(Array.isArray(data.events) ? data.events : []);
  }

  async function calendarAction(action: "connect" | "refresh" | "disconnect", sourceId?: string) {
    if (calendarBusy) return;
    const workspaceId = activeWorkspaceId === "all" ? writeWorkspaceId : activeWorkspaceId;
    setCalendarBusy(true);
    setCalendarStatus("");
    try {
      const response = await fetch("/api/calendar", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, sourceId, workspaceId, label: calendarLabel, url: calendarUrl }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Calendar action failed");
      setCalendarUrl("");
      await loadCalendar(workspaceId);
      setCalendarStatus(action === "connect" ? "Kalendář je připojený pouze pro čtení." : action === "refresh" ? "Kalendář byl obnoven." : "Kalendář byl odpojen a jeho data odstraněna.");
    } catch (error) {
      setCalendarUrl("");
      await loadCalendar(workspaceId).catch(() => undefined);
      setCalendarStatus(error instanceof Error ? error.message : "Calendar action failed");
    } finally {
      setCalendarBusy(false);
    }
  }

  async function loadDurableContext(workspaceId = activeWorkspaceId === "all" ? writeWorkspaceId : activeWorkspaceId) {
    const response = await fetch(`/api/context?workspaceId=${encodeURIComponent(workspaceId)}`, { cache: "no-store" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Context is unavailable");
    setDurableContext(Array.isArray(data.items) ? data.items : []);
  }

  async function contextAction(action: "create" | "archive", id?: string) {
    if (contextBusy) return;
    const workspaceId = activeWorkspaceId === "all" ? writeWorkspaceId : activeWorkspaceId;
    setContextBusy(true);
    setContextStatus("");
    try {
      const response = await fetch("/api/context", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(action === "create" ? {
          action, workspaceId, scope: contextScope, sensitivity: contextSensitivity,
          title: contextTitle, content: contextContent,
          projectId: contextScope === "project" ? contextProjectId : undefined,
        } : { action, workspaceId, id }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Context action failed");
      if (action === "create") {
        setContextTitle(""); setContextContent(""); setContextProjectId("");
        setContextStatus(language === "cs" ? "Kontext byl uložen." : "Context saved.");
      }
      await loadDurableContext(workspaceId);
    } catch (error) {
      setContextStatus(error instanceof Error ? error.message : "Context action failed");
    } finally {
      setContextBusy(false);
    }
  }

  useEffect(() => {
    if (authState !== "ready") return;
    loadBriefings().catch(() => undefined);
    const workspaceId = activeWorkspaceId === "all" ? writeWorkspaceId : activeWorkspaceId;
    setCalendarSources([]);
    setCalendarEvents([]);
    loadCalendar(workspaceId).catch(() => undefined);
    loadDurableContext(workspaceId).catch(() => setContextStatus(language === "cs" ? "Kontext nelze načíst." : "Context is unavailable."));
  }, [authState, activeWorkspaceId, writeWorkspaceId]);

  useEffect(() => {
    if (view !== "Settings" || authState !== "ready") return;
    loadPasskeys().catch(() => setPasskeyStatus("Passkeys could not be loaded."));
  }, [view, authState]);

  useEffect(() => {
    const savedLanguage = localStorage.getItem("ai-executive-language");
    if (savedLanguage === "cs" || savedLanguage === "en") {
      setLanguage(savedLanguage);
    } else {
      setLanguage(navigator.language.toLowerCase().startsWith("cs") ? "cs" : "en");
    }
    const savedView = localStorage.getItem("ai-executive-startup-view");
    const savedWorkspace = localStorage.getItem(
      "ai-executive-active-workspace",
    );
    const savedWriteWorkspace = localStorage.getItem(
      "ai-executive-write-workspace",
    );
    if (savedView && views.includes(savedView)) {
      setStartupView(savedView);
      setView(savedView);
    }
    if (savedWorkspace) {
      setActiveWorkspaceId(savedWorkspace);
      setWriteWorkspaceId(
        savedWorkspace !== "all"
          ? savedWorkspace
          : savedWriteWorkspace || personalWorkspaceId,
      );
    }
    setStandalone(
      window.matchMedia("(display-mode: standalone)").matches ||
        Boolean((navigator as Navigator & { standalone?: boolean }).standalone),
    );
    async function initialize() {
      const initializationVersion = localDataVersion.current;
      try {
        const response = await fetch("/api/store", { cache: "no-store" });
        if (!response.ok) throw new Error("Server synchronization failed");
        let snapshot = (await response.json()) as ServerSnapshot;
        await ensureDefaultWorkspace();
        let localEntities = await db.entities.toArray();
        let localRelations = await db.relations.toArray();
        if (
          !localEntities.some((entity) => entity.type !== "workspace") &&
          !snapshot.entities.some((entity) => entity.type !== "workspace")
        ) {
          await seed();
          await migratePropertyRelations();
          localEntities = await db.entities.toArray();
          localRelations = await db.relations.toArray();
        } else if (localEntities.length) {
          await migratePropertyRelations();
          localEntities = await db.entities.toArray();
          localRelations = await db.relations.toArray();
        }
        const alreadySynchronized =
          localStorage.getItem("ai-executive-server-synced") === "1";
        const hasPendingChanges = localStorage.getItem(pendingKey) === "1";
        if (!alreadySynchronized || hasPendingChanges) {
          const deletedIds = new Set(pendingDeletedIds());
          const revivedIds = new Set(pendingRevivedIds());
          const filteredSnapshot = {
            ...snapshot,
            tombstones: (snapshot.tombstones || []).filter((item) => !revivedIds.has(item.id)),
            entities: snapshot.entities.filter(
              (entity) => !deletedIds.has(entity.id),
            ),
            relations: snapshot.relations.filter(
              (relation) =>
                !deletedIds.has(relation.sourceEntityId) &&
                !deletedIds.has(relation.targetEntityId),
            ),
          };
          const merged = mergeSnapshots(
            filteredSnapshot,
            localEntities,
            localRelations,
          );
          let saveResponse = await putSnapshot(
            merged.entities,
            merged.relations,
            snapshot.revision,
            pendingDeletedIds(),
            pendingRevivedIds(),
          );
          if (saveResponse.status === 409) {
            snapshot = (await saveResponse.json()) as ServerSnapshot;
            const retrySnapshot = {
              ...snapshot,
              tombstones: (snapshot.tombstones || []).filter(
                (item) => !revivedIds.has(item.id),
              ),
            };
            const retry = mergeSnapshots(
              retrySnapshot,
              merged.entities,
              merged.relations,
            );
            saveResponse = await putSnapshot(
              retry.entities,
              retry.relations,
              snapshot.revision,
              pendingDeletedIds(),
              pendingRevivedIds(),
            );
          }
          if (!saveResponse.ok) throw new Error("Initial synchronization failed");
          snapshot = (await saveResponse.json()) as ServerSnapshot;
        }
        if (localDataVersion.current !== initializationVersion) {
          serverRevision.current = snapshot.revision;
          await syncToServer();
          return;
        }
        await applySnapshot(snapshot, initializationVersion);
        localStorage.setItem("ai-executive-server-synced", "1");
        localStorage.removeItem(pendingKey);
        localStorage.removeItem(deletedKey);
        localStorage.removeItem(revivedKey);
        setSyncStatus("synced");
      } catch {
        await ensureDefaultWorkspace();
        await load();
        setSyncStatus("offline");
      }
    }
    initialize();
  }, []);

  async function login(event: React.FormEvent) {
    event.preventDefault();
    if (!window.isSecureContext) {
      setAuthError("Open the HTTPS address before signing in.");
      return;
    }
    setAuthError("");
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: authPassword }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        setAuthError(body.error || "Sign-in failed.");
        return;
      }
      setAuthPassword("");
      setAuthState("ready");
      await pullFromServer();
    } catch {
      setAuthError("The server could not be reached. Check your secure connection and try again.");
    }
  }

  async function signInWithPasskey() {
    setPasskeyBusy(true);
    setAuthError("");
    try {
      const optionsResponse = await fetch("/api/auth/passkeys/login/options", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const options = await optionsResponse.json();
      if (!optionsResponse.ok) throw new Error(options.error || "Passkey sign-in is unavailable.");
      const credential = await startAuthentication({ optionsJSON: options });
      const verifyResponse = await fetch("/api/auth/passkeys/login/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ challenge: options.challenge, response: credential }),
      });
      const result = await verifyResponse.json();
      if (!verifyResponse.ok) throw new Error(result.error || "Passkey sign-in failed.");
      setAuthState("ready");
      await pullFromServer();
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "Passkey sign-in failed.");
    } finally {
      setPasskeyBusy(false);
    }
  }

  async function loadPasskeys() {
    const response = await fetch("/api/auth/passkeys", { cache: "no-store" });
    if (!response.ok) throw new Error("Passkeys could not be loaded.");
    const body = await response.json();
    setPasskeys(body.passkeys || []);
  }

  async function registerPasskey() {
    setPasskeyBusy(true);
    setPasskeyStatus("");
    try {
      const optionsResponse = await fetch("/api/auth/passkeys/register/options", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: passkeyPassword }),
      });
      const options = await optionsResponse.json();
      if (!optionsResponse.ok) throw new Error(options.error || "Passkey registration is unavailable.");
      const credential = await startRegistration({ optionsJSON: options });
      const verifyResponse = await fetch("/api/auth/passkeys/register/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          challenge: options.challenge,
          response: credential,
          label: passkeyLabel.trim() || "Passkey",
        }),
      });
      const result = await verifyResponse.json();
      if (!verifyResponse.ok) throw new Error(result.error || "Passkey registration failed.");
      await loadPasskeys();
      setPasskeyPassword("");
      setPasskeyStatus("Passkey added. You can now use Face ID or Touch ID to sign in.");
    } catch (error) {
      setPasskeyStatus(error instanceof Error ? error.message : "Passkey registration failed.");
    } finally {
      setPasskeyBusy(false);
    }
  }

  async function removePasskey(id: string) {
    if (!window.confirm("Remove this passkey? Password sign-in will remain available.")) return;
    const response = await fetch("/api/auth/passkeys", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      setPasskeyStatus(body.error || "Passkey could not be removed.");
      return;
    }
    await loadPasskeys();
    setPasskeyStatus("Passkey removed.");
  }

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    setAuthState("required");
  }

  useEffect(() => {
    fetch("/api/notifications", { cache: "no-store" })
      .then((response) => response.ok ? response.json() : Promise.reject())
      .then((state) => setNotificationState(state as NotificationState))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!items.length || deepLinkHandled.current) return;
    const parameters = new URLSearchParams(window.location.search);
    const requestedView = parameters.get("view");
    const taskId = parameters.get("task");
    if (requestedView && views.includes(requestedView)) setView(requestedView);
    if (taskId) {
      const task = items.find((item) => item.id === taskId);
      if (task && task.type !== "workspace") {
        selectWorkspace(task.workspaceId);
        inspect(task);
      }
    }
    deepLinkHandled.current = true;
  }, [items]);

  useEffect(() => {
    if (!capture && captureOpener.current) {
      captureOpener.current.focus();
      captureOpener.current = null;
    }
  }, [capture]);

  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  useEffect(() => {
    const savedTheme = localStorage.getItem("ai-executive-theme");
    if (savedTheme === "system" || savedTheme === "light" || savedTheme === "dark") {
      setThemeMode(savedTheme);
    }
    setThemeReady(true);
  }, []);

  useEffect(() => {
    if (!themeReady) return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const applyTheme = () => {
      const resolved = themeMode === "system" ? (media.matches ? "dark" : "light") : themeMode;
      setResolvedTheme(resolved);
      document.documentElement.dataset.theme = resolved;
      document.documentElement.style.colorScheme = resolved;
      document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
        ?.setAttribute("content", resolved === "dark" ? "#1c1c1e" : "#f4f3f1");
    };
    applyTheme();
    if (themeMode === "system") media.addEventListener("change", applyTheme);
    return () => media.removeEventListener("change", applyTheme);
  }, [themeMode, themeReady]);

  useEffect(() => {
    if (view !== "Settings") return;
    Promise.all([
      fetch("/api/backups", { cache: "no-store" }).then((response) => response.json()),
      fetch("/api/notifications", { cache: "no-store" }).then((response) => response.json()),
    ])
      .then(([backupData, notificationData]) => {
        setBackups(Array.isArray(backupData.backups) ? backupData.backups : []);
        setNotificationState(notificationData as NotificationState);
      })
      .catch(() => setBackupStatus("Server settings are unavailable while offline."));
  }, [view]);

  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === "visible") pullFromServer();
    };
    window.addEventListener("focus", refresh);
    window.addEventListener("online", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      window.removeEventListener("online", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);

  useEffect(() => {
    const workspaceId =
      activeWorkspaceId === "all" ? writeWorkspaceId : activeWorkspaceId;
    const workspace = items.find(
      (entity) =>
        entity.type === "workspace" && entity.workspaceId === workspaceId,
    );
    const validWriteWorkspace = items.some(
      (entity) =>
        entity.type === "workspace" && entity.workspaceId === writeWorkspaceId,
    );
    if (items.some((entity) => entity.type === "workspace") && !validWriteWorkspace) {
      setWriteWorkspaceId(personalWorkspaceId);
      localStorage.setItem(
        "ai-executive-write-workspace",
        personalWorkspaceId,
      );
      return;
    }
    if (workspace) {
      setWorkspaceDraft(workspace.title);
    }
  }, [activeWorkspaceId, items, writeWorkspaceId]);

  useEffect(() => {
    const parsed = parseCapture(draft);
    if (!capture || captureType !== "task" || parsed.title.length < 3) {
      captureSuggestionVersion.current += 1;
      setCaptureSuggestion(null);
      setCaptureSuggestionBusy(false);
      setCaptureSuggestionError("");
      return;
    }
    const version = ++captureSuggestionVersion.current;
    const workspaceId = activeWorkspaceId === "all" ? writeWorkspaceId : activeWorkspaceId;
    setCaptureSuggestion(null);
    setCaptureSuggestionBusy(true);
    setCaptureSuggestionError("");
    const controller = new AbortController();
    const abortTimer = window.setTimeout(() => controller.abort(), 7000);
    const timer = window.setTimeout(async () => {
      try {
        const response = await fetch("/api/task-suggestions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            title: parsed.title,
            workspaceId,
            requestedDate: parsed.when || undefined,
            explicitPriority: parsed.priority,
            language,
          }),
          signal: controller.signal,
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || "Suggestion failed");
        if (captureSuggestionVersion.current !== version) return;
        const suggestion = body.suggestion as CaptureSuggestion;
        suggestion.scheduledOptions = Array.isArray(suggestion.scheduledOptions)
          ? suggestion.scheduledOptions
          : suggestion.scheduledStart
            ? [{ start: suggestion.scheduledStart, end: suggestion.scheduledEnd, date: suggestion.scheduledDate }]
            : [];
        if (captureProjectId) {
          const project = items.find((item) => item.id === captureProjectId && item.type === "project");
          suggestion.projectId = captureProjectId;
          suggestion.projectTitle = project?.title || suggestion.projectTitle;
        }
        setCaptureSuggestion(suggestion);
      } catch {
        if (captureSuggestionVersion.current === version) {
          setCaptureSuggestion(null);
          setCaptureSuggestionError(tr("suggestionUnavailable"));
        }
      } finally {
        window.clearTimeout(abortTimer);
        if (captureSuggestionVersion.current === version) setCaptureSuggestionBusy(false);
      }
    }, 650);
    return () => {
      window.clearTimeout(timer);
      window.clearTimeout(abortTimer);
      controller.abort();
    };
  }, [capture, captureType, draft, activeWorkspaceId, writeWorkspaceId, captureProjectId, items, language]);

  async function saveWorkspaceName() {
    const name = workspaceDraft.trim();
    if (!name || name.length > 120) return;
    const workspaceId =
      activeWorkspaceId === "all" ? writeWorkspaceId : activeWorkspaceId;
    const workspace = items.find(
      (entity) =>
        entity.type === "workspace" && entity.workspaceId === workspaceId,
    );
    if (!workspace) return;
    localDataVersion.current += 1;
    await db.entities.update(workspace.id, {
      title: name,
      updatedAt: Date.now(),
    });
    localDataVersion.current += 1;
    await syncToServer();
    await load();
    setSettingsSaved(true);
    window.setTimeout(() => setSettingsSaved(false), 1800);
  }

  function saveLanguage(nextLanguage: Language) {
    setLanguage(nextLanguage);
    localStorage.setItem("ai-executive-language", nextLanguage);
  }

  function saveTheme(nextTheme: ThemeMode) {
    setThemeReady(true);
    setThemeMode(nextTheme);
    localStorage.setItem("ai-executive-theme", nextTheme);
  }

  function selectWorkspace(workspaceId: string) {
    setActiveWorkspaceId(workspaceId);
    if (workspaceId !== "all") selectWriteWorkspace(workspaceId);
    localStorage.setItem("ai-executive-active-workspace", workspaceId);
    setMessages([]);
    setAiText("");
    setWorkspaceMenuOpen(false);
    closeDetail();
  }

  function selectWriteWorkspace(workspaceId: string) {
    setWriteWorkspaceId(workspaceId);
    localStorage.setItem("ai-executive-write-workspace", workspaceId);
  }

  async function createWorkspace() {
    const name = newWorkspaceDraft.trim();
    if (!name || name.length > 120) return;
    const workspaceId = crypto.randomUUID();
    const now = Date.now();
    localDataVersion.current += 1;
    await db.entities.add({
      id: `workspace:${workspaceId}`,
      type: "workspace",
      title: name,
      status: "active",
      workspaceId,
      properties: {
        kind: "shared",
        role: "owner",
        members: [{ id: "owner", role: "owner" }],
      },
      createdAt: now,
      updatedAt: now,
    });
    localDataVersion.current += 1;
    await syncToServer();
    await load();
    setNewWorkspaceDraft("");
    selectWorkspace(workspaceId);
  }
  async function enableNotifications() {
    setNotificationStatus("Requesting permission…");
    try {
      if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
        throw new Error("Push notifications are not supported in this browser.");
      }
      if (!window.isSecureContext) {
        throw new Error("Open the HTTPS address to enable notifications.");
      }
      const permission = await Notification.requestPermission();
      if (permission !== "granted") throw new Error("Notification permission was not granted.");
      const stateResponse = await fetch("/api/notifications", { cache: "no-store" });
      if (!stateResponse.ok) throw new Error("Notification service is unavailable.");
      const state = (await stateResponse.json()) as NotificationState;
      const registration = await navigator.serviceWorker.ready;
      let subscription = await registration.pushManager.getSubscription();
      if (!subscription) {
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(state.publicKey),
        });
      }
      const response = await fetch("/api/notifications", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "subscribe", subscription: subscription.toJSON() }),
      });
      if (!response.ok) throw new Error("The device could not be registered.");
      setNotificationState((await response.json()) as NotificationState);
      setNotificationStatus("Notifications enabled on this device.");
    } catch (error) {
      setNotificationStatus(error instanceof Error ? error.message : "Notifications could not be enabled.");
    }
  }
  async function disableNotifications() {
    setNotificationStatus("Disabling notifications…");
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) {
        await fetch("/api/notifications", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "unsubscribe", endpoint: subscription.endpoint }),
        });
        await subscription.unsubscribe();
      }
      const state = await fetch("/api/notifications", { cache: "no-store" }).then((response) => response.json());
      setNotificationState(state as NotificationState);
      setNotificationStatus("Notifications disabled on this device.");
    } catch {
      setNotificationStatus("Notifications could not be disabled.");
    }
  }
  async function testNotification() {
    setNotificationStatus("Sending test notification…");
    try {
      const response = await fetch("/api/notifications", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "test" }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "The test could not be sent.");
      if (result.sent) {
        setNotificationStatus(
          result.failed
            ? `Test sent to ${result.sent} device(s); ${result.failed} delivery failed.`
            : `Test sent to ${result.sent} device(s).`,
        );
      } else if (result.total) {
        setNotificationStatus(`Delivery failed for all ${result.total} registered device(s).`);
      } else {
        setNotificationStatus("No device is registered for notifications.");
      }
    } catch (error) {
      setNotificationStatus(error instanceof Error ? error.message : "The test could not be sent.");
    }
  }
  async function saveNotificationSettings(preferences: NotificationPreferences) {
    setNotificationState((current) => current ? { ...current, preferences } : current);
    notificationSettingsQueue.current = notificationSettingsQueue.current
      .catch(() => undefined)
      .then(async () => {
        const response = await fetch("/api/notifications", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "preferences", preferences }),
        });
        if (!response.ok) throw new Error();
        setNotificationStatus("Reminder settings saved.");
      })
      .catch(() => setNotificationStatus("Reminder settings could not be saved."));
    await notificationSettingsQueue.current;
  }
  async function createServerBackup() {
    setBackupStatus("Creating backup…");
    try {
      const response = await fetch("/api/backups", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "create" }),
      });
      if (!response.ok) throw new Error("Backup failed");
      const listResponse = await fetch("/api/backups", { cache: "no-store" });
      const data = await listResponse.json();
      setBackups(data.backups || []);
      setBackupStatus("Backup created.");
    } catch {
      setBackupStatus("Backup failed. Check the server connection.");
    }
  }
  async function restoreServerBackup(backup: BackupSummary) {
    if (
      !window.confirm(
        `Restore ${new Date(backup.createdAt).toLocaleString()}? A safety backup will be created first.`,
      )
    )
      return;
    setBackupStatus("Restoring backup…");
    try {
      const response = await fetch("/api/backups", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "restore", name: backup.name }),
      });
      if (!response.ok) throw new Error("Restore failed");
      const data = await response.json();
      await applySnapshot(data.snapshot as ServerSnapshot);
      localStorage.removeItem(pendingKey);
      localStorage.removeItem(deletedKey);
      localStorage.removeItem(revivedKey);
      setBackupStatus("Backup restored.");
      const listResponse = await fetch("/api/backups", { cache: "no-store" });
      const list = await listResponse.json();
      setBackups(list.backups || []);
    } catch {
      setBackupStatus("Restore failed. Current data was not changed.");
    }
  }
  const workspaces = items
      .filter((entity) => entity.type === "workspace")
      .sort((a, b) =>
        a.workspaceId === personalWorkspaceId
          ? -1
          : b.workspaceId === personalWorkspaceId
            ? 1
            : a.title.localeCompare(b.title),
      ),
    activeWorkspace = workspaces.find(
      (workspace) => workspace.workspaceId === activeWorkspaceId,
    ),
    writeWorkspace = workspaces.find(
      (workspace) => workspace.workspaceId === writeWorkspaceId,
    ) || workspaces[0],
    workspaceName =
      activeWorkspaceId === "all"
        ? tr("allWork")
        : activeWorkspace?.title || "Personal",
    scopedItems = items.filter(
      (entity) =>
        entity.type !== "workspace" &&
        (activeWorkspaceId === "all" ||
          entity.workspaceId === activeWorkspaceId),
    ),
    scopedRelations = relations.filter(
      (relation) =>
        activeWorkspaceId === "all" ||
        relation.workspaceId === activeWorkspaceId,
    ),
    tasks = scopedItems.filter((x) => x.type === "task"),
    projects = scopedItems.filter((x) => x.type === "project"),
    areas = scopedItems.filter((x) => x.type === "area"),
    today = ymd();
  const sidebarCounts: Record<string, number> = {
    Inbox: tasks.filter((task) => taskMatchesView(task, "Inbox", today)).length,
    Today: tasks.filter((task) => taskMatchesView(task, "Today", today)).length,
    Overdue: tasks.filter((task) => taskMatchesView(task, "Overdue", today)).length,
    Upcoming: tasks.filter((task) => taskMatchesView(task, "Upcoming", today)).length,
    Anytime: tasks.filter((task) => taskMatchesView(task, "Anytime", today)).length,
    Someday: tasks.filter((task) => taskMatchesView(task, "Someday", today)).length,
    Completed: tasks.filter((task) => taskMatchesView(task, "Completed", today)).length,
    Projects: projects.length,
    Areas: areas.length,
    Notes: scopedItems.filter((entity) => entity.type === "note").length,
  };
  const calendarTimezone = notificationState?.preferences.timezone || "Europe/Prague";
  const calendarTodayParts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: calendarTimezone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(badgeNow)).map((part) => [part.type, part.value]));
  const calendarToday = `${calendarTodayParts.year}-${calendarTodayParts.month}-${calendarTodayParts.day}`;
  const visibleDayPlan = dayPlan?.workspaceId === (activeWorkspaceId === "all" ? writeWorkspaceId : activeWorkspaceId) && dayPlan.date === calendarToday ? dayPlan : null;
  const calendarTomorrowDate = new Date(`${calendarToday}T12:00:00Z`);
  calendarTomorrowDate.setUTCDate(calendarTomorrowDate.getUTCDate() + 1);
  const calendarTomorrow = calendarTomorrowDate.toISOString().slice(0, 10);
  useEffect(() => {
    if (authState !== "ready") return;
    const workspaceId = activeWorkspaceId === "all" ? writeWorkspaceId : activeWorkspaceId;
    setDayPlan(null);
    setDayPlanStatus("");
    loadDayPlan(workspaceId, calendarToday)
      .catch(() => { if (calendarWorkspaceSelection.current === workspaceId) setDayPlanStatus(language === "cs" ? "Plán dne se nepodařilo načíst." : "The day plan is unavailable."); });
  }, [authState, activeWorkspaceId, writeWorkspaceId, calendarToday, items]);
  const attentionTaskCount = items.filter((task) => {
    if (task.type !== "task" || task.status !== "open") return false;
    return [task.properties.when, task.properties.deadline].some(
      (due) => typeof due === "string" && /^\d{4}-\d{2}-\d{2}$/.test(due) && due <= calendarTomorrow,
    );
  }).length;
  useEffect(() => {
    if (authState !== "ready" || !notificationState) return;
    const nextMidnight = Date.parse(zonedDateTimeToIso(calendarTomorrow, "00:00", calendarTimezone));
    const timer = window.setTimeout(() => setBadgeNow(Date.now()), Math.max(1000, nextMidnight - Date.now() + 1000));
    const refresh = () => {
      if (document.visibilityState === "visible") setBadgeNow(Date.now());
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [authState, notificationState, calendarTomorrow, calendarTimezone]);
  useEffect(() => {
    const badgeNavigator = navigator as Navigator & {
      setAppBadge?: (count?: number) => Promise<void>;
      clearAppBadge?: () => Promise<void>;
    };
    if (typeof badgeNavigator.setAppBadge !== "function") return;
    if (authState === "ready" && !notificationState) return;
    const update = authState === "ready" && attentionTaskCount > 0
      ? badgeNavigator.setAppBadge(attentionTaskCount)
      : typeof badgeNavigator.clearAppBadge === "function"
        ? badgeNavigator.clearAppBadge()
        : badgeNavigator.setAppBadge(0);
    update.catch(() => undefined);
  }, [attentionTaskCount, authState, notificationState]);
  async function testAppBadge() {
    setBadgeStatus(tr("badgeTesting"));
    const badgeNavigator = navigator as Navigator & {
      setAppBadge?: (count?: number) => Promise<void>;
    };
    if (!standalone) {
      setBadgeStatus(tr("badgeInstallRequired"));
      return;
    }
    if (typeof Notification === "undefined" || Notification.permission !== "granted") {
      setBadgeStatus(tr("badgePermissionRequired"));
      return;
    }
    if (typeof badgeNavigator.setAppBadge !== "function") {
      setBadgeStatus(tr("badgeUnavailable"));
      return;
    }
    try {
      await badgeNavigator.setAppBadge(1);
      setBadgeStatus(tr("badgeTestReady"));
    } catch (error) {
      console.warn("App badge test failed", error);
      setBadgeStatus(tr("badgeFailed"));
    }
  }
  async function restoreAppBadge() {
    const badgeNavigator = navigator as Navigator & {
      setAppBadge?: (count?: number) => Promise<void>;
      clearAppBadge?: () => Promise<void>;
    };
    if (typeof badgeNavigator.setAppBadge !== "function") {
      setBadgeStatus(tr("badgeUnavailable"));
      return;
    }
    try {
      if (attentionTaskCount > 0) await badgeNavigator.setAppBadge(attentionTaskCount);
      else if (typeof badgeNavigator.clearAppBadge === "function") await badgeNavigator.clearAppBadge();
      else await badgeNavigator.setAppBadge(0);
      setBadgeStatus(tr("badgeRestored"));
    } catch (error) {
      console.warn("App badge restore failed", error);
      setBadgeStatus(tr("badgeFailed"));
    }
  }
  const dayStart = Date.parse(zonedDateTimeToIso(calendarToday, notificationState?.preferences.workdayStart || "08:00", calendarTimezone));
  const dayEnd = Date.parse(zonedDateTimeToIso(calendarToday, notificationState?.preferences.workdayEnd || "18:00", calendarTimezone));
  const todayCalendarEvents = calendarEvents.filter((event) => Date.parse(event.end) > dayStart && Date.parse(event.start) < dayEnd);
  const calendarFresh = calendarSources.length > 0 && calendarSources.every((source) => source.status === "ready");
  const mergedBusy = todayCalendarEvents.filter((event) => event.busy).map((event) => [
    Math.max(dayStart, Date.parse(event.start)), Math.min(dayEnd, Date.parse(event.end)),
  ] as [number, number]).sort((a, b) => a[0] - b[0]).reduce<Array<[number, number]>>((merged, interval) => {
    const last = merged[merged.length - 1];
    if (!last || interval[0] > last[1]) merged.push(interval);
    else last[1] = Math.max(last[1], interval[1]);
    return merged;
  }, []);
  const freeHours = Math.max(0, (dayEnd - dayStart - mergedBusy.reduce((total, interval) => total + interval[1] - interval[0], 0)) / 3_600_000);
  const freeWindows = (() => {
    const result: Array<[number, number]> = [];
    let cursor = dayStart;
    for (const interval of mergedBusy) {
      if (interval[0] - cursor >= 30 * 60_000) result.push([cursor, interval[0]]);
      cursor = Math.max(cursor, interval[1]);
    }
    if (dayEnd - cursor >= 30 * 60_000) result.push([cursor, dayEnd]);
    return result;
  })();
  const targets = (sourceId: string, type: string) =>
    scopedRelations
      .filter((r) => r.sourceEntityId === sourceId && r.relationType === type)
      .map((r) => r.targetEntityId);
  const sources = (targetId: string, type: string) =>
    scopedRelations
      .filter((r) => r.targetEntityId === targetId && r.relationType === type)
      .map((r) => r.sourceEntityId);
  const homeTodayTasks = tasks
    .filter((task) => task.status === "open" && (
      task.properties.today === true || task.properties.when === today ||
      (typeof task.properties.when === "string" && task.properties.when < today)
    ))
    .sort(byManualOrder("task:Today"))
    .slice(0, 5);
  const homeUpcomingTasks = tasks
    .filter((task) => task.status === "open" && typeof task.properties.when === "string" && task.properties.when > today)
    .sort((a, b) => String(a.properties.when).localeCompare(String(b.properties.when)))
    .slice(0, 4);
  const homeProjects = projects.filter((project) => project.status === "active").sort(byManualOrder("project:all")).slice(0, 4);
  const homeRecent = [...scopedItems]
    .filter((entity) => entity.type !== "task" || entity.status === "open")
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 4);
  const greetingHour = new Date().getHours();
  const homeGreeting = greetingHour < 12 ? tr("goodMorning") : greetingHour < 18 ? tr("goodAfternoon") : tr("goodEvening");
  const visible = useMemo(
    () => {
      const priorityRank: Record<string, number> = { high: 0, medium: 1, low: 2, none: 3 };
      return tasks.filter((t) => {
        if (priorityFilter !== "all" && String(t.properties.priority || "none") !== priorityFilter) return false;
        return taskMatchesView(t, view, today);
      }).sort((a, b) => {
        if (sortBy === "manual") return byManualOrder(`task:${view}`)(a, b);
        if (sortBy === "created") return b.createdAt - a.createdAt;
        if (sortBy === "priority") {
          return (priorityRank[String(a.properties.priority || "none")] ?? 3) -
            (priorityRank[String(b.properties.priority || "none")] ?? 3);
        }
        return String(a.properties.when || "9999-12-31").localeCompare(String(b.properties.when || "9999-12-31"));
      });
    },
    [tasks, view, today, sortBy, priorityFilter],
  );
  function parseCapture(raw: string) {
    let title = raw.trim(),
      when = "",
      priority = "none";
    if (/(^|\s)zítra(?=\s|$)/i.test(title)) {
      when = ymd(addLocalDays(new Date(), 1));
      title = title.replace(/(^|\s)zítra(?=\s|$)/i, " ");
    } else if (/(^|\s)dnes(?=\s|$)/i.test(title)) {
      when = today;
      title = title.replace(/(^|\s)dnes(?=\s|$)/i, " ");
    }
    const m = title.match(/(?:^|\s)(\d{1,2})\.(\d{1,2})(?:\.(\d{4}))?\.?\s*$/);
    if (m) {
      const now = new Date();
      const year = m[3] ? Number(m[3]) : now.getFullYear();
      const d = new Date(year, Number(m[2]) - 1, Number(m[1]));
      if (d.getFullYear() === year && d.getMonth() === Number(m[2]) - 1 && d.getDate() === Number(m[1])) {
        if (!m[3] && d < new Date(now.getFullYear(), now.getMonth(), now.getDate())) d.setFullYear(year + 1);
        when = ymd(d);
        title = title.slice(0, m.index).trim();
      }
    }
    if (/(^|\s)(!|#high)(?=\s|$)/i.test(title)) priority = "high";
    else if (/(^|\s)#medium(?=\s|$)/i.test(title)) priority = "medium";
    else if (/(^|\s)#low(?=\s|$)/i.test(title)) priority = "low";
    title = title.replace(/(^|\s)(!|#high|#medium|#low)(?=\s|$)/gi, " ").replace(/\s+/g, " ").trim();
    return { title, when, priority };
  }
  async function create(
    type: EntityType,
    title: string,
    extra: Record<string, unknown> = {},
  ) {
    if (!title.trim()) return;
    const now = Date.now(),
      id = typeof extra.entityId === "string" ? extra.entityId : crypto.randomUUID(),
      projectId = typeof extra.projectId === "string" ? extra.projectId : "",
      areaId = typeof extra.areaId === "string" ? extra.areaId : "",
      properties = { ...extra },
      parsed =
        type === "task"
          ? parseCapture(title)
          : { title: title.trim(), when: "", priority: "none" };
    const linkedProject = projectId ? await db.entities.get(projectId) : null;
    const linkedArea = areaId ? await db.entities.get(areaId) : null;
    const explicitWorkspaceId =
      typeof extra.workspaceId === "string" ? extra.workspaceId : "";
    const creationWorkspaceId =
      linkedProject?.workspaceId ||
      linkedArea?.workspaceId ||
      explicitWorkspaceId ||
      writeWorkspaceId;
    const workspace = await db.entities.get(
      `workspace:${creationWorkspaceId}`,
    );
    if (!workspace || workspace.type !== "workspace") {
      throw new Error("A valid write workspace is required");
    }
    if (
      (linkedProject && linkedProject.workspaceId !== creationWorkspaceId) ||
      (linkedArea && linkedArea.workspaceId !== creationWorkspaceId)
    ) {
      throw new Error("Cross-workspace relations are not allowed");
    }
    delete properties.projectId;
    delete properties.areaId;
    delete properties.entityId;
    delete properties.workspaceId;
    localDataVersion.current += 1;
    let created = false;
    await db.transaction("rw", db.entities, db.relations, async () => {
      if (await db.entities.get(id)) return;
      await db.entities.add({
        id,
        type,
        title: parsed.title,
        status: type === "task" ? "open" : "active",
        workspaceId: creationWorkspaceId,
        properties:
          type === "task"
            ? {
                ...properties,
                inbox: parsed.when
                  ? false
                  : Boolean(properties.inbox ?? (!projectId && view === "Inbox")),
                today: parsed.when
                  ? parsed.when === today
                  : Boolean(properties.today ?? (view === "Today")),
                ...(parsed.when ? { when: parsed.when } : {}),
                ...(parsed.priority !== "none" ? { priority: parsed.priority } : {}),
                activity: [{ at: now, action: "created" }],
              }
            : properties,
        createdAt: now,
        updatedAt: now,
      });
      created = true;
      if (projectId) {
        await db.relations.add({
          id: crypto.randomUUID(),
          workspaceId: creationWorkspaceId,
          sourceEntityId: id,
          targetEntityId: projectId,
          relationType: "belongs_to_project",
          createdAt: now,
        });
      }
      if (areaId) {
        await db.relations.add({
          id: crypto.randomUUID(),
          workspaceId: creationWorkspaceId,
          sourceEntityId: id,
          targetEntityId: areaId,
          relationType: "belongs_to_area",
          createdAt: now,
        });
      }
    });
    localDataVersion.current += 1;
    if (!created) return id;
    setText("");
    setDraft("");
    await syncToServer();
    await load();
    if (selected) {
      setSelected((await db.entities.get(selected.id)) || null);
      setContext(await buildContext(selected.id, 2));
    }
    return id;
  }

  function openCapture(type: "task" | "note" = "task", projectId = "") {
    captureOpener.current = document.activeElement as HTMLElement | null;
    setCaptureType(type);
    setCaptureProjectId(projectId);
    setDraft("");
    setCaptureSuggestion(null);
    setCaptureSuggestionError("");
    setCaptureSuggestionBusy(false);
    setUseCaptureSuggestion(true);
    setCapture(true);
  }
  async function submitCapture() {
    const title = draft.trim();
    if (!title) return;
    const parsed = parseCapture(title);
    const suggestion = captureType === "task" && useCaptureSuggestion ? captureSuggestion : null;
    const suggestedProjectId = captureProjectId || suggestion?.projectId || "";
    const suggestedAreaId = suggestion?.areaId || "";
    const suggestedDate = parsed.when || suggestion?.scheduledDate || "";
    const globalTask = captureType === "task" && !captureProjectId;
    setCapture(false);
    if (globalTask) {
      closeDetail();
      setMoreOpen(false);
      setView(suggestedDate === today ? "Today" : "Inbox");
    }
    try {
      await create(captureType, title, {
        ...(suggestedProjectId ? { projectId: suggestedProjectId } : {}),
        ...(suggestedAreaId ? { areaId: suggestedAreaId } : {}),
        ...(captureType === "task"
          ? {
              inbox: !suggestedProjectId && !suggestedDate,
              today: suggestedDate === today,
              ...(suggestedDate ? { when: suggestedDate } : {}),
              ...(suggestion && parsed.priority === "none" ? { priority: suggestion.priority } : {}),
              ...(suggestion ? {
                estimatedMinutes: suggestion.estimatedMinutes,
                plannedStart: suggestion.scheduledStart,
                plannedEnd: suggestion.scheduledEnd,
                planningSource: "albert-suggestion",
              } : {}),
            }
          : {}),
      });
    } catch {
      setDraft(title);
      setCapture(true);
      setSyncStatus("offline");
    }
  }
  async function relate(
    sourceId: string,
    targetId: string,
    relationType: string,
  ) {
    const source = await db.entities.get(sourceId);
    const target = targetId ? await db.entities.get(targetId) : null;
    if (!source || source.type === "workspace") return;
    if (target && target.workspaceId !== source.workspaceId) {
      throw new Error("Cross-workspace relations are not allowed");
    }
    const existing = await db.relations
      .where("sourceEntityId")
      .equals(sourceId)
      .filter((r) => r.relationType === relationType)
      .toArray();
    localDataVersion.current += 1;
    const relationTimestamp = Date.now();
    await db.transaction("rw", db.entities, db.relations, async () => {
      await db.relations.bulkDelete(existing.map((r) => r.id));
      if (targetId)
        await db.relations.add({
          id: crypto.randomUUID(),
          workspaceId: source.workspaceId,
          sourceEntityId: sourceId,
          targetEntityId: targetId,
          relationType,
          createdAt: relationTimestamp,
        });
      await db.entities.update(source.id, {
        properties: {
          ...source.properties,
          relationsUpdatedAt: relationTimestamp,
        },
        updatedAt: relationTimestamp,
      });
    });
    localDataVersion.current += 1;
    await syncToServer();
    await load();
    if (selected) {
      setSelected((await db.entities.get(selected.id)) || null);
      setContext(await buildContext(selected.id, 2));
    }
  }
  async function rename(e: Entity, title: string) {
    if (!title.trim()) return;
    const current = (await db.entities.get(e.id)) || e;
    const activity = Array.isArray(current.properties.activity)
      ? current.properties.activity
      : [];
    localDataVersion.current += 1;
    await db.entities.update(e.id, {
      title: title.trim(),
      properties: {
        ...current.properties,
        activity: [...activity, { at: Date.now(), action: "renamed" }].slice(-50),
      },
      updatedAt: Date.now(),
    });
    localDataVersion.current += 1;
    await syncToServer();
    await load();
    setSelected((await db.entities.get(e.id)) || null);
  }
  async function remove(e: Entity) {
    setUndo(e);
    const deletedIds = new Set(pendingDeletedIds());
    deletedIds.add(e.id);
    localStorage.setItem(deletedKey, JSON.stringify([...deletedIds]));
    const linkedRelations = (await db.relations.toArray())
      .filter(
        (relation) =>
          relation.sourceEntityId === e.id || relation.targetEntityId === e.id,
      )
      .map((relation) => relation.id);
    localDataVersion.current += 1;
    await db.transaction("rw", db.entities, db.relations, async () => {
      await db.entities.delete(e.id);
      await db.relations.bulkDelete(linkedRelations);
    });
    localDataVersion.current += 1;
    await syncToServer();
    closeDetail();
    load();
  }
  async function restore() {
    if (!undo) return;
    const deletedIds = pendingDeletedIds().filter((id) => id !== undo.id);
    if (deletedIds.length)
      localStorage.setItem(deletedKey, JSON.stringify(deletedIds));
    else localStorage.removeItem(deletedKey);
    localDataVersion.current += 1;
    await db.entities.put({
      ...undo,
      status: undo.status === "completed" ? "open" : undo.status,
      updatedAt: Date.now(),
    });
    localDataVersion.current += 1;
    const revivedIds = new Set(pendingRevivedIds());
    revivedIds.add(undo.id);
    localStorage.setItem(revivedKey, JSON.stringify([...revivedIds]));
    await syncToServer();
    setUndo(null);
    load();
  }
  async function patch(e: Entity, properties: Record<string, unknown>, action = "updated") {
    const current = (await db.entities.get(e.id)) || e;
    const activity = Array.isArray(current.properties.activity)
      ? current.properties.activity
      : [];
    localDataVersion.current += 1;
    await db.entities.update(e.id, {
      properties: {
        ...current.properties,
        ...properties,
        activity: [...activity, { at: Date.now(), action }].slice(-50),
      },
      updatedAt: Date.now(),
    });
    localDataVersion.current += 1;
    await syncToServer();
    await load();
    setSelected((await db.entities.get(e.id)) || null);
  }
  async function applyDayPlanAction(item: DayPlanItem, decision: "accepted" | "tomorrow" | "dismissed") {
    if (dayPlanBusy || !dayPlan) return;
    if (dayPlan.workspaceId !== calendarWorkspaceSelection.current || dayPlan.date !== calendarToday) return;
    const task = items.find((candidate) => candidate.id === item.taskId && candidate.type === "task" && candidate.status === "open" && candidate.workspaceId === dayPlan.workspaceId);
    if (!task) { setDayPlanStatus(tr("dayPlanChanged")); return; }
    setDayPlanBusy(true);
    setDayPlanStatus("");
    try {
      await syncQueue.current;
      if (localStorage.getItem(pendingKey) === "1") throw new Error(tr("dayPlanSyncFirst"));
      const current = await loadDayPlan(dayPlan.workspaceId, dayPlan.date);
      if (calendarWorkspaceSelection.current !== dayPlan.workspaceId || calendarToday !== dayPlan.date) throw new Error(tr("dayPlanChanged"));
      const stillProposed = current.planBlocks.find((block) => block.taskId === item.taskId && block.start === item.start && block.end === item.end);
      const stillUnscheduled = current.unscheduled.some((candidate) => candidate.taskId === item.taskId);
      if (!stillProposed && !stillUnscheduled) throw new Error(tr("dayPlanChanged"));
      if (decision === "accepted" && (!stillProposed || !item.start || !item.end)) throw new Error(tr("dayPlanChanged"));
      if (decision === "accepted") {
        const proposeResponse = await fetch("/api/day-plan", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceId: current.workspaceId, date: current.date, revision: current.revision, taskId: item.taskId, start: item.start, end: item.end }) });
        const proposed = await proposeResponse.json().catch(() => ({}));
        if (!proposeResponse.ok) throw new Error(proposed.error || tr("dayPlanChanged"));
        const proposal = proposed.proposal as AIProposal;
        if (!window.confirm(`${tr("acceptBlock")} — ${tr("confirmDayPlanAction")} ${task.title.replace(/\s+/g, " ").slice(0, 160)}\n${item.start} – ${item.end}`)) {
          await fetch("/api/ai/actions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "cancel", proposalId: proposal.id }) });
          return;
        }
        if (calendarWorkspaceSelection.current !== dayPlan.workspaceId) throw new Error(tr("dayPlanChanged"));
        const confirmResponse = await fetch("/api/ai/actions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "confirm", proposalId: proposal.id }) });
        const confirmed = await confirmResponse.json().catch(() => ({}));
        if (!confirmResponse.ok) throw new Error(confirmed.error || tr("dayPlanChanged"));
        setDayPlanUndo({ actionId: confirmed.actionId, workspaceId: current.workspaceId, date: current.date });
        await pullFromServer();
        await loadDayPlan(current.workspaceId, current.date);
        return;
      }
      if (!window.confirm(`${tr(decision === "tomorrow" ? "moveTomorrow" : "skipPlanning")} — ${tr("confirmDayPlanAction")} ${task.title.replace(/\s+/g, " ").slice(0, 160)}`)) return;
      const feedback = { date: dayPlan.date, decision, at: Date.now(), proposedStart: item.start || "" };
      const history = Array.isArray(task.properties.planningHistory) ? task.properties.planningHistory : [];
      const changes = decision === "tomorrow"
          ? { when: calendarTomorrow, today: false, plannedStart: "", plannedEnd: "", inbox: false, someday: false, planningFeedback: feedback, planningHistory: [...history, feedback].slice(-50) }
          : { planningFeedback: feedback, planningHistory: [...history, feedback].slice(-50) };
      await patch(task, changes, `day plan ${decision}`);
      await loadDayPlan(dayPlan.workspaceId, dayPlan.date);
    } catch (error) {
      setDayPlanStatus(error instanceof Error ? error.message : tr("dayPlanChanged"));
    } finally {
      setDayPlanBusy(false);
    }
  }
  async function undoDayPlanBlock() {
    if (!dayPlanUndo || dayPlanBusy) return;
    setDayPlanBusy(true);
    try {
      const response = await fetch("/api/ai/actions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "undo", actionId: dayPlanUndo.actionId }) });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || tr("dayPlanChanged"));
      setDayPlanUndo(null);
      await pullFromServer();
      await loadDayPlan(dayPlanUndo.workspaceId, dayPlanUndo.date);
    } catch (error) { setDayPlanStatus(error instanceof Error ? error.message : tr("dayPlanChanged")); }
    finally { setDayPlanBusy(false); }
  }
  async function done(id: string) {
    const t = await db.entities.get(id);
    if (
      t?.type === "task" &&
      (t.properties.recurrence || t.properties.repeat)
    ) {
      const rec = (t.properties.recurrence || {
        frequency: t.properties.repeat,
        interval: 1,
        mode: "scheduled",
      }) as any;
      const base =
        rec.mode === "completion"
          ? new Date()
          : new Date(String(t.properties.when || today));
      const next = new Date(base),
        n = Number(rec.interval || 1);
      if (rec.frequency === "daily") next.setDate(next.getDate() + n);
      if (rec.frequency === "weekly") next.setDate(next.getDate() + 7 * n);
      if (rec.frequency === "monthly") {
        const desiredDay = next.getDate();
        next.setDate(1);
        next.setMonth(next.getMonth() + n);
        const lastDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
        next.setDate(Math.min(desiredDay, lastDay));
      }
      if (rec.frequency === "yearly") {
        const desiredDay = next.getDate();
        const desiredMonth = next.getMonth();
        next.setDate(1);
        next.setFullYear(next.getFullYear() + n);
        next.setMonth(desiredMonth);
        const lastDay = new Date(next.getFullYear(), desiredMonth + 1, 0).getDate();
        next.setDate(Math.min(desiredDay, lastDay));
      }
      const reminderLocal = toLocalDateTime(t.properties.reminderAt);
      const nextReminder = reminderLocal
        ? fromLocalDateTime(`${ymd(next)}T${reminderLocal.slice(11, 16)}`)
        : "";
      await create("task", t.title, {
        ...t.properties,
        workspaceId: t.workspaceId,
        entityId: `${t.id}:occurrence:${ymd(next)}`,
        projectId: targets(t.id, "belongs_to_project")[0],
        areaId: targets(t.id, "belongs_to_area")[0],
        when: ymd(next),
        reminderAt: nextReminder,
        today: false,
        inbox: false,
      });
    }
    if (t) setUndo(t);
    localDataVersion.current += 1;
    await db.entities.update(id, {
      status: "completed",
      properties: {
        ...t?.properties,
        completedAt: Date.now(),
        activity: [
          ...(Array.isArray(t?.properties.activity) ? t.properties.activity : []),
          { at: Date.now(), action: "completed" },
        ].slice(-50),
      },
      updatedAt: Date.now(),
    });
    localDataVersion.current += 1;
    await syncToServer();
    closeDetail();
    load();
  }
  async function reopenTask(task: Entity) {
    const activity = Array.isArray(task.properties.activity) ? task.properties.activity : [];
    localDataVersion.current += 1;
    await db.entities.update(task.id, {
      status: "open",
      properties: {
        ...task.properties,
        completedAt: null,
        activity: [...activity, { at: Date.now(), action: "reopened" }].slice(-50),
      },
      updatedAt: Date.now(),
    });
    localDataVersion.current += 1;
    await syncToServer();
    await load();
    setSelected((await db.entities.get(task.id)) || null);
  }
  const type: EntityType =
    view === "Projects"
      ? "project"
      : view === "Areas"
        ? "area"
        : view === "Notes"
          ? "note"
          : "task";
  const collection = ["Projects", "Areas", "Notes"].includes(view)
    ? scopedItems.filter((x) => x.type === type).sort(byManualOrder(`${type}:all`))
    : visible;
  const draggedEntity = items.find((entity) => entity.id === draggingId);
  const draggableSectionNames = ["Inbox", "Today", "Anytime", "Someday", "Completed"];

  function setActiveDragTarget(target: string) {
    dragTargetRef.current = target;
    setDragTarget(target);
  }

  function targetAtPoint(clientX: number, clientY: number) {
    const element = document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>(
      "[data-drop-entity], [data-drop-section]",
    );
    if (!element) return "";
    return element.dataset.dropEntity
      ? `entity:${element.dataset.dropEntity}`
      : element.dataset.dropSection
        ? `section:${element.dataset.dropSection}`
        : "";
  }

  function beginPointerDrag(event: ReactPointerEvent<HTMLButtonElement>, id: string) {
    if (event.pointerType === "mouse") return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    pointerDragRef.current = {
      id,
      startX: event.clientX,
      startY: event.clientY,
      active: false,
    };
    setActiveDragTarget("");
  }

  function movePointerDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    const pending = pointerDragRef.current;
    if (!pending.id) return;
    event.preventDefault();
    if (!pending.active) {
      const distance = Math.hypot(
        event.clientX - pending.startX,
        event.clientY - pending.startY,
      );
      if (distance < 8) return;
      pending.active = true;
      draggingIdRef.current = pending.id;
      setDraggingId(pending.id);
    }
    setActiveDragTarget(targetAtPoint(event.clientX, event.clientY));
  }

  async function persistManualOrder(ordered: Entity[], movedId: string, scope: string) {
    const timestamp = Date.now();
    const movedIndex = ordered.findIndex((entity) => entity.id === movedId);
    const moved = ordered[movedIndex];
    if (!moved) return;
    const previous = movedIndex > 0 ? manualOrder(ordered[movedIndex - 1], scope) : null;
    const next = movedIndex < ordered.length - 1 ? manualOrder(ordered[movedIndex + 1], scope) : null;
    const rank = previous === null
      ? (next === null ? 1000 : next - 1000)
      : next === null
        ? previous + 1000
        : previous + (next - previous) / 2;
    const storedOrders = moved.properties.manualOrders;
    const manualOrders = storedOrders && typeof storedOrders === "object" && !Array.isArray(storedOrders)
      ? { ...(storedOrders as Record<string, unknown>) }
      : {};
    manualOrders[`${moved.workspaceId}:${scope}`] = rank;
    const activity = Array.isArray(moved.properties.activity)
      ? moved.properties.activity
      : [];
    localDataVersion.current += 1;
    await db.entities.update(moved.id, {
      properties: {
        ...moved.properties,
        manualOrders,
        activity: [...activity, { at: timestamp, action: "reordered" }].slice(-50),
      },
      updatedAt: timestamp,
    });
    localDataVersion.current += 1;
    await syncToServer();
    await load();
  }

  async function moveTaskToSection(task: Entity, section: string) {
    if (task.type !== "task" || !draggableSectionNames.includes(section)) return;
    if (section === "Completed") {
      await done(task.id);
      return;
    }
    const timestamp = Date.now();
    const properties = { ...task.properties };
    delete properties.when;
    properties.inbox = section === "Inbox";
    properties.today = section === "Today";
    properties.someday = section === "Someday";
    if (section === "Today") properties.when = today;
    const peers = tasks.filter((candidate) => {
      if (candidate.id === task.id || candidate.status !== "open" || candidate.workspaceId !== task.workspaceId) return false;
      if (section === "Inbox") return candidate.properties.inbox === true;
      if (section === "Today") return candidate.properties.today === true || candidate.properties.when === today ||
        (typeof candidate.properties.when === "string" && candidate.properties.when < today);
      if (section === "Someday") return candidate.properties.someday === true;
      return !candidate.properties.when && !candidate.properties.someday && candidate.properties.inbox !== true;
    });
    const scope = `task:${section}`;
    const storedOrders = task.properties.manualOrders;
    const manualOrders = storedOrders && typeof storedOrders === "object" && !Array.isArray(storedOrders)
      ? { ...(storedOrders as Record<string, unknown>) }
      : {};
    manualOrders[`${task.workspaceId}:${scope}`] = Math.max(0, ...peers.map((peer) => manualOrder(peer, scope))) + 1000;
    properties.manualOrders = manualOrders;
    const activity = Array.isArray(task.properties.activity) ? task.properties.activity : [];
    properties.activity = [...activity, { at: timestamp, action: `moved to ${section}` }].slice(-50);
    localDataVersion.current += 1;
    await db.entities.update(task.id, { properties, updatedAt: timestamp });
    localDataVersion.current += 1;
    await syncToServer();
    await load();
  }

  async function completeDrop(sourceId: string, target: string) {
    const source = items.find((entity) => entity.id === sourceId);
    if (!source || !target) return;
    if (target.startsWith("section:")) {
      await moveTaskToSection(source, target.slice("section:".length));
      return;
    }
    if (!target.startsWith("entity:")) return;
    const targetEntity = items.find((entity) => entity.id === target.slice("entity:".length));
    if (!targetEntity || targetEntity.id === source.id || targetEntity.workspaceId !== source.workspaceId) return;
    if (source.type === targetEntity.type) {
      const displayedPeers = collection.filter((entity) =>
        entity.type === source.type && entity.workspaceId === source.workspaceId,
      );
      const homePeers = view === "Home" && source.type === "task"
        ? tasks.filter((task) => task.workspaceId === source.workspaceId && task.status === "open" && (
          task.properties.today === true || task.properties.when === today ||
          (typeof task.properties.when === "string" && task.properties.when < today)
        )).sort(byManualOrder("task:Today"))
        : [];
      const selectedProjectPeers = selected?.type === "project" && (source.type === "task" || source.type === "note")
        ? scopedItems.filter((entity) => entity.type === source.type &&
          (entity.type !== "task" || entity.status === "open") &&
          sources(selected.id, "belongs_to_project").includes(entity.id))
          .sort(byManualOrder(`${source.type}:project:${selected.id}`))
        : [];
      const selectedAreaPeers = selected?.type === "area" && (source.type === "task" || source.type === "project")
        ? scopedItems.filter((entity) => entity.type === source.type && sources(selected.id, "belongs_to_area").includes(entity.id))
          .sort(byManualOrder(`${source.type}:area:${selected.id}`))
        : [];
      const contextualPeers = homePeers.some((entity) => entity.id === source.id) && homePeers.some((entity) => entity.id === targetEntity.id)
        ? homePeers
        : selectedProjectPeers.some((entity) => entity.id === source.id) && selectedProjectPeers.some((entity) => entity.id === targetEntity.id)
          ? selectedProjectPeers
          : selectedAreaPeers.some((entity) => entity.id === source.id) && selectedAreaPeers.some((entity) => entity.id === targetEntity.id)
            ? selectedAreaPeers
            : displayedPeers;
      const peers = contextualPeers.some((entity) => entity.id === source.id) && contextualPeers.some((entity) => entity.id === targetEntity.id)
        ? [...contextualPeers]
        : scopedItems.filter((entity) => entity.type === source.type && entity.workspaceId === source.workspaceId)
          .sort(byManualOrder(`${source.type}:all`));
      const sourceIndex = peers.findIndex((entity) => entity.id === source.id);
      const targetIndex = peers.findIndex((entity) => entity.id === targetEntity.id);
      if (sourceIndex < 0 || targetIndex < 0) return;
      const [moved] = peers.splice(sourceIndex, 1);
      peers.splice(targetIndex, 0, moved);
      const inSelectedProject = (source.type === "task" || source.type === "note") && selected?.type === "project" &&
        sources(selected.id, "belongs_to_project").includes(source.id) &&
        sources(selected.id, "belongs_to_project").includes(targetEntity.id);
      const inSelectedArea = selected?.type === "area" &&
        sources(selected.id, "belongs_to_area").includes(source.id) &&
        sources(selected.id, "belongs_to_area").includes(targetEntity.id);
      const scope = inSelectedProject
        ? `${source.type}:project:${selected.id}`
        : inSelectedArea
          ? `${source.type}:area:${selected.id}`
          : source.type === "task"
            ? `task:${view === "Home" ? "Today" : view}`
            : `${source.type}:all`;
      if (source.type === "task") setSortBy("manual");
      await persistManualOrder(peers, source.id, scope);
      return;
    }
    if ((source.type === "task" || source.type === "note") && targetEntity.type === "project") {
      await relate(source.id, targetEntity.id, "belongs_to_project");
    } else if (source.type === "project" && targetEntity.type === "area") {
      await relate(source.id, targetEntity.id, "belongs_to_area");
    } else if (source.type === "task" && targetEntity.type === "area") {
      await relate(source.id, targetEntity.id, "belongs_to_area");
    }
  }

  async function finishPointerDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    const pending = pointerDragRef.current;
    pointerDragRef.current = { id: "", startX: 0, startY: 0, active: false };
    if (!pending.active || !draggingIdRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    const sourceId = draggingIdRef.current;
    const target = dragTargetRef.current || targetAtPoint(event.clientX, event.clientY);
    draggingIdRef.current = "";
    setDraggingId("");
    setActiveDragTarget("");
    await completeDrop(sourceId, target);
  }

  function beginNativeDrag(event: ReactDragEvent<HTMLButtonElement>, id: string) {
    event.stopPropagation();
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", id);
    draggingIdRef.current = id;
    setDraggingId(id);
  }

  async function acceptNativeDrop(event: ReactDragEvent<HTMLElement>, target: string) {
    event.preventDefault();
    event.stopPropagation();
    const sourceId = event.dataTransfer.getData("text/plain") || draggingIdRef.current;
    draggingIdRef.current = "";
    setDraggingId("");
    setActiveDragTarget("");
    await completeDrop(sourceId, target);
  }

  async function moveWithKeyboard(entity: Entity, direction: -1 | 1) {
    const projectPeers = selected?.type === "project" && (entity.type === "task" || entity.type === "note")
      ? scopedItems.filter((candidate) => candidate.type === entity.type &&
        candidate.workspaceId === entity.workspaceId &&
        sources(selected.id, "belongs_to_project").includes(candidate.id))
      : [];
    const areaPeers = selected?.type === "area" && (entity.type === "task" || entity.type === "project")
      ? scopedItems.filter((candidate) => candidate.type === entity.type &&
        candidate.workspaceId === entity.workspaceId &&
        sources(selected.id, "belongs_to_area").includes(candidate.id))
      : [];
    const peers = projectPeers.some((candidate) => candidate.id === entity.id)
      ? projectPeers
      : areaPeers.some((candidate) => candidate.id === entity.id)
        ? areaPeers
        : collection.filter((candidate) =>
          candidate.type === entity.type && candidate.workspaceId === entity.workspaceId,
        );
    const index = peers.findIndex((candidate) => candidate.id === entity.id);
    const target = peers[index + direction];
    if (index < 0 || !target) return;
    await completeDrop(entity.id, `entity:${target.id}`);
  }

  const dragHandle = (entity: Entity) => (
    <button
      className="dragHandle"
      draggable
      aria-label={`${tr("moveItemNamed")} ${entity.title}`}
      title={tr("dragToMove")}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
        event.preventDefault();
        event.stopPropagation();
        void moveWithKeyboard(entity, event.key === "ArrowUp" ? -1 : 1);
      }}
      onDragStart={(event) => beginNativeDrag(event, entity.id)}
      onDragEnd={() => { draggingIdRef.current = ""; setDraggingId(""); setActiveDragTarget(""); }}
      onPointerDown={(event) => beginPointerDrag(event, entity.id)}
      onPointerMove={movePointerDrag}
      onPointerUp={finishPointerDrag}
      onPointerCancel={() => {
        pointerDragRef.current = { id: "", startX: 0, startY: 0, active: false };
        draggingIdRef.current = "";
        setDraggingId("");
        setActiveDragTarget("");
      }}
    >
      <span aria-hidden="true">⠿</span>
    </button>
  );
  if (authState !== "ready") {
    return (
      <main className="authShell">
        <form className="authCard" onSubmit={login}>
          <div className="authMark">◇</div>
          <p className="eyebrow">AI EXECUTIVE</p>
          <h1>
            {authState === "checking"
              ? tr("checkingAccess")
              : authState === "misconfigured"
                ? tr("setupRequired")
                : tr("signIn")}
          </h1>
          {authState === "required" && (
            <>
              <label>
                {tr("password")}
                <input
                  autoFocus
                  type="password"
                  autoComplete="current-password"
                  value={authPassword}
                  onChange={(event) => setAuthPassword(event.target.value)}
                />
              </label>
              <button type="submit" disabled={!authPassword}>{tr("signIn")}</button>
              {passkeySupported && (
                <button
                  className="secondaryAction"
                  type="button"
                  disabled={passkeyBusy}
                  onClick={signInWithPasskey}
                >
                  {passkeyBusy ? tr("checking") : tr("signInPasskey")}
                </button>
              )}
            </>
          )}
          {authError && <p className="authError" role="alert">{authError}</p>}
        </form>
      </main>
    );
  }
  return (
    <main className={`appShell view-${view.toLowerCase()}`}>
      <aside>
        <div className="appIdentity" aria-label="AI Executive">
          <span className="brandMark">◇</span>
          <span><strong>AI Executive</strong><small>Personal OS</small></span>
        </div>
        <div className="workspaceSwitcher">
          <button
            className="workspaceButton"
            onClick={() => setWorkspaceMenuOpen((open) => !open)}
            aria-label="Switch workspace"
            aria-expanded={workspaceMenuOpen}
          >
            <b>{workspaceName}</b>
            <span>⌄</span>
          </button>
          {workspaceMenuOpen && (
            <div className="workspaceMenu">
              {workspaces.map((workspace) => (
                <button
                  key={workspace.id}
                  className={activeWorkspaceId === workspace.workspaceId ? "active" : ""}
                  onClick={() => selectWorkspace(workspace.workspaceId)}
                >
                  <span>{workspace.title}</span>
                  <small>{String(workspace.properties.kind || "shared")}</small>
                </button>
              ))}
              <button
                className={activeWorkspaceId === "all" ? "active" : ""}
                onClick={() => selectWorkspace("all")}
              >
                <span>{tr("allWork")}</span>
                <small>aggregate</small>
              </button>
              <button
                onClick={() => {
                  setView("Settings");
                  setWorkspaceMenuOpen(false);
                  closeDetail();
                }}
              >
                <span>{tr("manageWorkspaces")}</span>
                <small>settings</small>
              </button>
            </div>
          )}
        </div>
        <nav>
          {views.map((x) => (
            <button
              className={`${view === x ? "active" : ""} ${dragTarget === `section:${x}` ? "dropActive" : ""}`.trim()}
              aria-current={view === x ? "page" : undefined}
              data-drop-section={draggableSectionNames.includes(x) ? x : undefined}
              onDragEnter={() => draggableSectionNames.includes(x) && setActiveDragTarget(`section:${x}`)}
              onDragOver={(event) => {
                if (!draggableSectionNames.includes(x)) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
              }}
              onDrop={(event) => acceptNativeDrop(event, `section:${x}`)}
              onClick={() => {
                setView(x);
                closeDetail();
              }}
              key={x}
            >
              <span className="navLabel"><span aria-hidden="true">{viewIcons[x]}</span>{tr(x)}</span>
              {sidebarCounts[x] !== undefined ? (
                <span className="navCount">{sidebarCounts[x]}</span>
              ) : null}
            </button>
          ))}
        </nav>
        <footer className="sidebarActions">
          <button onClick={() => openCapture()} aria-label={tr("addTask")}>
            ＋ {tr("new")}
          </button>
          <button
            className={view === "Settings" ? "active" : ""}
            onClick={() => {
              setView("Settings");
              closeDetail();
            }}
          >
            ⚙ {tr("Settings")}
          </button>
        </footer>
      </aside>
      <section className="appPane">
        <header className="topbar">
          <button
            className="mobileWorkspaceButton"
            onClick={() => setWorkspaceMenuOpen((open) => !open)}
            aria-label="Switch workspace"
          >
            {workspaceName}⌄
          </button>
          {workspaceMenuOpen && (
            <div className="mobileWorkspaceMenu workspaceMenu">
              {workspaces.map((workspace) => (
                <button
                  key={workspace.id}
                  onClick={() => selectWorkspace(workspace.workspaceId)}
                >
                  {workspace.title}
                </button>
              ))}
              <button onClick={() => selectWorkspace("all")}>{tr("allWork")}</button>
            </div>
          )}
          <label className="searchField">
            <span aria-hidden="true">⌕</span>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onFocus={() => setView("Search")}
              placeholder={tr("search")}
              aria-label={tr("search")}
            />
            <kbd>⌘ K</kbd>
          </label>
          <button
            className="themeToggle"
            type="button"
            aria-label={resolvedTheme === "dark" ? tr("switchLight") : tr("switchDark")}
            title={resolvedTheme === "dark" ? tr("switchLight") : tr("switchDark")}
            onClick={() => saveTheme(resolvedTheme === "dark" ? "light" : "dark")}
          >
            <span aria-hidden="true">{resolvedTheme === "dark" ? "☀" : "☾"}</span>
          </button>
          <button
            className="aiButton"
            onClick={() => setAssistantOpen(true)}
            aria-label={tr("askAi")}
          >
            ◇ {tr("askAi")}
          </button>
        </header>
        <div className="content">
          <div className="pageIntro">
            <p className="eyebrow">
              {workspaceName.toUpperCase()} · {activeWorkspaceId === "all" ? "AGGREGATE" : String(activeWorkspace?.properties.kind || "PERSONAL").toUpperCase()}
            </p>
            <div className="pageTitleRow">
              <h1>{view === "Home" ? homeGreeting : tr(view)}</h1>
              {view === "Today" && <time>{new Intl.DateTimeFormat(language === "cs" ? "cs-CZ" : "en-GB", { weekday: "short", day: "numeric", month: "short" }).format(new Date())}</time>}
            </div>
            {view === "Home" && <p className="pageSubtitle">{tr("homeSubtitle")}</p>}
          </div>
          {view === "Home" && (
            <>
            <div className="homeOverview">
              <section className="homeSection homePrimary">
                <div className="homeSectionHead">
                  <span><span className="sectionDot todayDot" />{tr("Today")}</span>
                  <button onClick={() => setView("Today")}>{tr("seeAll")} <span aria-hidden="true">→</span></button>
                </div>
                <div className="homeTaskList">
                  {homeTodayTasks.map((task) => (
                    <article
                      key={task.id}
                      className={`${draggingId === task.id ? "isDragging" : ""} ${dragTarget === `entity:${task.id}` ? "dropActive" : ""} ${taskDueTone(task, today)}`.trim()}
                      data-drop-entity={task.id}
                      onDragOver={(event) => { event.preventDefault(); setActiveDragTarget(`entity:${task.id}`); }}
                      onDrop={(event) => acceptNativeDrop(event, `entity:${task.id}`)}
                      onClick={() => inspect(task)}
                    >
                      {dragHandle(task)}
                      <button className="check" aria-label={`Complete ${task.title}`} onClick={(event) => { event.stopPropagation(); done(task.id); }}>○</button>
                      <div><strong>{task.title}</strong><small>{taskDueSummary(task, today, language) || (task.properties.priority && task.properties.priority !== "none" ? tr(String(task.properties.priority)) : tr("Today"))}</small></div>
                    </article>
                  ))}
                  {homeTodayTasks.length === 0 && <div className="calmEmpty"><span>✓</span><p>{tr("nothingToday")}</p><button onClick={() => openCapture()}>{tr("addTask")}</button></div>}
                </div>
              </section>
              <div className="homeSide">
                <section className="homeSection">
                  <div className="homeSectionHead"><span><span className="sectionDot inboxDot" />{tr("Inbox")}</span><b>{tasks.filter((task) => task.status === "open" && task.properties.inbox === true).length}</b></div>
                  <p>{tr("inboxDescription")}</p>
                  <button className="textAction" onClick={() => setView("Inbox")}>{tr("openInbox")} →</button>
                </section>
                <section className="homeSection">
                  <div className="homeSectionHead"><span><span className="sectionDot projectDot" />{tr("Projects")}</span><button onClick={() => setView("Projects")}>{tr("seeAll")} →</button></div>
                  <div className="homeCompactList">
                    {homeProjects.map((project) => <button
                      key={project.id}
                      className={dragTarget === `entity:${project.id}` ? "dropActive" : ""}
                      data-drop-entity={project.id}
                      onDragOver={(event) => { event.preventDefault(); setActiveDragTarget(`entity:${project.id}`); }}
                      onDrop={(event) => acceptNativeDrop(event, `entity:${project.id}`)}
                      onClick={() => inspect(project)}
                    ><span>{project.title}</span><small>{tasks.filter((task) => task.status === "open" && sources(project.id, "belongs_to_project").includes(task.id)).length} {tr("openCount")}</small></button>)}
                    {homeProjects.length === 0 && <p>{tr("noProjects")}</p>}
                  </div>
                </section>
              </div>
              <section className="homeSection">
                <div className="homeSectionHead"><span><span className="sectionDot upcomingDot" />{tr("Upcoming")}</span><button onClick={() => setView("Upcoming")}>{tr("seeAll")} →</button></div>
                <div className="homeCompactList">
                  {homeUpcomingTasks.map((task) => <button key={task.id} onClick={() => inspect(task)}><span>{task.title}</span><small>{friendlyDate(task.properties.when, language)}</small></button>)}
                  {homeUpcomingTasks.length === 0 && <p>{tr("noUpcoming")}</p>}
                </div>
              </section>
              <section className="homeSection">
                <div className="homeSectionHead"><span><span className="sectionDot recentDot" />{tr("recent")}</span></div>
                <div className="homeCompactList">
                  {homeRecent.map((entity) => <button key={entity.id} onClick={() => inspect(entity)}><span>{entity.title}</span><small>{tr(entity.type)}</small></button>)}
                </div>
              </section>
            </div>
            <div className="homeInsights">
            <section className="briefingCard">
              <div className="sectionHeading">
                <div>
                  <p className="eyebrow">PROACTIVE EXECUTIVE</p>
                  <h2>{briefings[0]?.title || tr("dailyBrief")}</h2>
                </div>
                <div className="notificationActions">
                  <button onClick={() => runBriefing("morning")} disabled={briefingBusy}>{tr("morningBrief")}</button>
                  <button onClick={() => runBriefing("evening")} disabled={briefingBusy}>{tr("eveningReview")}</button>
                </div>
              </div>
              {briefings[0] ? (
                <div>
                  <p>{briefings[0].summary}</p>
                  {briefings[0].overloaded && <p role="status"><strong>{tr("capacityExceeded")}</strong> {tr("capacityEstimate")}</p>}
                  <ol className="briefingTasks">
                    {briefings[0].topTasks.map((task) => (
                      <li key={task.id}>
                        <button onClick={() => {
                          const entity = items.find((item) => item.id === task.id);
                          if (entity) inspect(entity);
                        }}>{task.title}</button>
                        <small>{task.reason}</small>
                      </li>
                    ))}
                  </ol>
                  <ul>{briefings[0].suggestions.map((suggestion) => <li key={suggestion}>{suggestion}</li>)}</ul>
                  <small>{new Date(briefings[0].createdAt).toLocaleString()} · {briefings[0].workspaceName}</small>
                </div>
              ) : <p>{tr("firstBrief")}</p>}
            </section>
            <section className="briefingCard calendarCard">
              <div className="sectionHeading">
                <div>
                  <p className="eyebrow">{tr("calendarReadonly").toUpperCase()} · {activeWorkspaceId === "all" ? writeWorkspace?.title || "PERSONAL" : workspaceName}</p>
                  <h2>{tr("todayCapacity")}</h2>
                </div>
                <strong>{calendarSources.length === 0 ? tr("calendarDisconnected") : calendarFresh ? `${freeHours.toFixed(1)} ${tr("freeHours")}` : tr("capacityUnknown")}</strong>
              </div>
              {calendarSources.some((source) => source.status !== "ready") && (
                <p role="status">{tr("calendarStale")}</p>
              )}
              {calendarFresh && todayCalendarEvents.length === 0 && <p>{tr("noBlockingEvent")}</p>}
              <div className="calendarAgenda">
                {todayCalendarEvents.map((event) => (
                  <div key={event.id} className={event.busy ? "busy" : "free"}>
                    <span>{event.allDay ? tr("allDay") : new Date(event.start).toLocaleTimeString(language === "cs" ? "cs-CZ" : "en-GB", { hour: "2-digit", minute: "2-digit", timeZone: calendarTimezone })}</span>
                    <strong>{event.title}</strong>
                    <small>{event.busy ? tr("busy") : tr("freeTime")}</small>
                  </div>
                ))}
              </div>
              {calendarFresh && freeWindows.length > 0 && (
                <p>
                  <strong>{tr("nearestFree")}</strong>{" "}
                  {freeWindows.slice(0, 3).map((window) => `${new Date(window[0]).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", timeZone: calendarTimezone })}–${new Date(window[1]).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", timeZone: calendarTimezone })}`).join(", ")}
                </p>
              )}
              <small>{tr("readOnlyEvents")}</small>
            </section>
            </div>
            </>
          )}
          {(view === "Home" || view === "Today") && (
            <section className="dayPlanCard" aria-labelledby="day-plan-title">
              <div className="sectionHeading">
                <div><p className="eyebrow">ALBERT</p><h2 id="day-plan-title">{tr("dayPlanTitle")}</h2></div>
                {visibleDayPlan?.calendar === "ready" && <strong>{Math.floor((visibleDayPlan.freeMinutes || 0) / 60)} h {(visibleDayPlan.freeMinutes || 0) % 60} min</strong>}
              </div>
              {dayPlanStatus && <p role="status">{dayPlanStatus}</p>}
              {visibleDayPlan ? <>
                <p>{tr(visibleDayPlan.calendar === "ready" ? "dayPlanReady" : visibleDayPlan.calendar === "missing" ? "dayPlanMissing" : visibleDayPlan.calendar === "stale" ? "dayPlanStale" : "dayPlanNonWorkday")}</p>
                {visibleDayPlan.overloaded && <p role="status" className="dayPlanWarning">{tr("dayPlanOverloaded")} ({visibleDayPlan.requiredMinutes} min)</p>}
                {dayPlanUndo?.workspaceId === visibleDayPlan.workspaceId && dayPlanUndo.date === visibleDayPlan.date && <button disabled={dayPlanBusy} onClick={undoDayPlanBlock}>{tr("dayPlanUndo")}</button>}
                {visibleDayPlan.existingBlocks.length + visibleDayPlan.planBlocks.length + visibleDayPlan.unscheduled.length === 0 && <p>{tr("dayPlanEmpty")}</p>}
                <div className="dayPlanTimeline">
                  {[...visibleDayPlan.existingBlocks.map((item) => ({ ...item, existing: true })), ...visibleDayPlan.planBlocks.map((item) => ({ ...item, existing: false }))]
                    .sort((a, b) => String(a.start).localeCompare(String(b.start))).map((item) => (
                    <article className={`dayPlanBlock ${item.existing ? "existing" : "proposed"}`} key={`${item.taskId}:${item.start}`}>
                      <time>{new Intl.DateTimeFormat(language === "cs" ? "cs-CZ" : "en-GB", { timeZone: visibleDayPlan.timezone, hour: "2-digit", minute: "2-digit" }).format(new Date(item.start!))}–{new Intl.DateTimeFormat(language === "cs" ? "cs-CZ" : "en-GB", { timeZone: visibleDayPlan.timezone, hour: "2-digit", minute: "2-digit" }).format(new Date(item.end!))}</time>
                      <div><strong>{item.title}</strong><small>{tr(item.existing ? "dayPlanExisting" : "dayPlanSuggested")} · {tr(`dayPlanReason${item.reason[0].toUpperCase()}${item.reason.slice(1)}`)} · {item.estimatedMinutes} min</small>
                        {!item.existing && <div className="dayPlanActions">
                          <button disabled={dayPlanBusy} onClick={() => applyDayPlanAction(item, "accepted")}>{tr("acceptBlock")}</button>
                          <button disabled={dayPlanBusy} onClick={() => { const task = items.find((candidate) => candidate.id === item.taskId); if (task) inspect(task); }}>{tr("anotherTime")}</button>
                          <button disabled={dayPlanBusy} onClick={() => applyDayPlanAction(item, "tomorrow")}>{tr("moveTomorrow")}</button>
                          <button disabled={dayPlanBusy} onClick={() => applyDayPlanAction(item, "dismissed")}>{tr("skipPlanning")}</button>
                        </div>}
                      </div>
                    </article>
                  ))}
                  {visibleDayPlan.unscheduled.map((item) => (
                    <article className="dayPlanBlock unscheduled" key={item.taskId}>
                      <span>{tr("dayPlanUnscheduled")}</span>
                      <div><strong>{item.title}</strong><small>{tr(`dayPlanReason${item.reason[0].toUpperCase()}${item.reason.slice(1)}`)} · {item.estimatedMinutes} min</small>
                        <div className="dayPlanActions">
                          <button disabled={dayPlanBusy} onClick={() => { const task = items.find((candidate) => candidate.id === item.taskId); if (task) inspect(task); }}>{tr("anotherTime")}</button>
                          <button disabled={dayPlanBusy} onClick={() => applyDayPlanAction(item, "tomorrow")}>{tr("moveTomorrow")}</button>
                          <button disabled={dayPlanBusy} onClick={() => applyDayPlanAction(item, "dismissed")}>{tr("skipPlanning")}</button>
                        </div>
                      </div>
                    </article>
                  ))}
                </div>
              </> : !dayPlanStatus && <p>{tr("checking")}</p>}
            </section>
          )}
          {view === "Search" && query && (
            <div className="searchResults">
              {scopedItems
                .filter((x) => {
                  const q = query.toLowerCase(),
                    linked = scopedRelations
                      .filter(
                        (r) =>
                          r.sourceEntityId === x.id ||
                          r.targetEntityId === x.id,
                      )
                      .flatMap((r) => [
                        scopedItems.find((i) => i.id === r.sourceEntityId)?.title ||
                          "",
                        scopedItems.find((i) => i.id === r.targetEntityId)?.title ||
                          "",
                      ])
                      .join(" ");
                  return (x.title + " " + (x.content || "") + " " + linked)
                    .toLowerCase()
                    .includes(q);
                })
                .map((x) => (
                  <article key={x.id} onClick={() => inspect(x)}>
                    <div>
                      <strong>{x.title}</strong>
                      <small>{tr(x.type)}</small>
                    </div>
                  </article>
                ))}
            </div>
          )}
          {view === "Agents" && (
            <div className="agentsPanel">
              <p className="agentsIntro">{tr("agentsIntro")}</p>
              <div className="agentGrid">
                {pactAgents.map((agent) => {
                  const latest = agentRuns.find((run) => run.agentId === agent.id);
                  const description = agent.id === "morning-planner"
                    ? (language === "cs" ? "Sestaví priority dne, rizika a kapacitní doporučení." : "Builds daily priorities, risks and capacity guidance.")
                    : agent.id === "evening-reviewer"
                      ? (language === "cs" ? "Zhodnotí dokončenou práci a neuzavřené závazky." : "Reviews completed work and unfinished commitments.")
                      : agent.id === "project-manager"
                        ? (language === "cs" ? "Najde rizikové projekty a projekty bez dalšího kroku." : "Finds at-risk projects and projects without a next action.")
                        : (language === "cs" ? "Připraví podklady k nejbližší události z kalendáře." : "Prepares guidance for the next calendar event.");
                  const displayName = agent.id === "morning-planner"
                    ? tr("morningBrief")
                    : agent.id === "evening-reviewer"
                      ? tr("eveningReview")
                      : agent.id === "project-manager"
                        ? (language === "cs" ? "Projektový manažer" : "Project Manager")
                        : (language === "cs" ? "Příprava na schůzku" : "Meeting Prep");
                  return (
                    <article className="agentCard" key={agent.id}>
                      <header>
                        <span className="agentGlyph" aria-hidden="true">◇</span>
                        <div><h2>{displayName}</h2><small>v{agent.version} · {agent.triggerModes.join(" / ")}</small></div>
                      </header>
                      <p>{description}</p>
                      <div className="agentMeta">
                        <span>{agent.tools.filter((tool) => tool.endsWith(".read") || tool.includes("calendar")).length} READ</span>
                        {agent.tools.some((tool) => tool.endsWith(".propose")) && <span>PROPOSE</span>}
                        <span>0 WRITE</span>
                      </div>
                      {latest && <small>{tr("latestResult")}: {latest.status === "completed" ? tr("completedRun") : latest.status === "failed" ? tr("failedRun") : tr("runningRun")} · {new Date(latest.createdAt).toLocaleString(language === "cs" ? "cs-CZ" : "en-GB")}</small>}
                      <button className="primaryAction" disabled={Boolean(agentBusyId) || !agent.triggerModes.includes("manual")} onClick={() => runPACTAgent(agent.id)}>
                        {agentBusyId === agent.id ? tr("working") : tr("runAgent")}
                      </button>
                    </article>
                  );
                })}
              </div>
              {agentResult && (
                <section className="agentResult" aria-live="polite">
                  <div className="sectionHeading"><div><p className="eyebrow">{tr("latestResult")}</p><h2>{agentResult.title}</h2></div><small>{new Date(agentResult.createdAt).toLocaleString(language === "cs" ? "cs-CZ" : "en-GB")}</small></div>
                  <p>{agentResult.summary}</p>
                  <h3>{tr("recommendations")}</h3>
                  <ol>{agentResult.recommendations.map((recommendation) => <li key={recommendation}>{recommendation}</li>)}</ol>
                  <p className="agentSafetyNote">{language === "cs" ? "Agent nic nezměnil. Případné změny se nejprve zobrazí jako návrh k potvrzení." : "The agent changed nothing. Any mutation is shown as a proposal for confirmation first."}</p>
                </section>
              )}
              {agentStatus && <p className="saveConfirmation" role="status">{agentStatus}</p>}
              <section className="agentHistory">
                <div className="sectionHeading"><div><h2>{tr("runHistory")}</h2><p>{language === "cs" ? "Sanitizovaný provozní záznam bez názvů úkolů a obsahu kontextu." : "Sanitized operational history without task titles or context contents."}</p></div></div>
                <div className="agentRunList">
                  {agentRuns.map((run) => {
                    const agent = pactAgents.find((candidate) => candidate.id === run.agentId);
                    return <article key={run.id}><span className={`runStatus ${run.status}`}>{run.status === "completed" ? "✓" : run.status === "failed" ? "!" : "…"}</span><div><strong>{agent?.name || run.agentId}</strong><small>{run.triggerMode} · {new Date(run.createdAt).toLocaleString(language === "cs" ? "cs-CZ" : "en-GB")}</small><p>{run.status === "completed" ? tr("completedRun") : run.status === "failed" ? tr("failedRun") : tr("runningRun")}</p>{run.outputSummary && <small className="runSummary">{run.outputSummary.split(";").join(" · ")}</small>}</div></article>;
                  })}
                  {!agentRuns.length && <p>{tr("noAgentRuns")}</p>}
                </div>
              </section>
            </div>
          )}
          {view === "Settings" && (
            <div className="settingsPanel">
              <section className="durableContextSection">
                <div className="sectionHeading"><div><h2>{language === "cs" ? "Kontext AIfréda" : "AIfréd context"}</h2><p>{language === "cs" ? "Trvalé informace a pravidla, která má AIfréd používat. Citlivý kontext se neposílá externím AI službám." : "Durable facts and rules for AIfréd. Sensitive context is not sent to external AI services."}</p></div></div>
                <div className="contextForm">
                  <div className="preferenceGrid">
                    <label>{language === "cs" ? "Rozsah" : "Scope"}<select value={contextScope} onChange={(e) => setContextScope(e.target.value as DurableContextItem["scope"])}><option value="me">Me</option><option value="work">Work</option><option value="family">Family</option><option value="rules">Rules</option><option value="workspace">Workspace</option><option value="project">Project</option></select></label>
                    <label>{language === "cs" ? "Citlivost" : "Sensitivity"}<select value={contextSensitivity} onChange={(e) => setContextSensitivity(e.target.value as DurableContextItem["sensitivity"])}><option value="normal">{language === "cs" ? "Běžný" : "Normal"}</option><option value="sensitive">{language === "cs" ? "Citlivý" : "Sensitive"}</option></select></label>
                  </div>
                  {contextScope === "project" && <label>{tr("project")}<select value={contextProjectId} onChange={(e) => setContextProjectId(e.target.value)}><option value="">—</option>{items.filter((item) => item.type === "project" && item.workspaceId === (activeWorkspaceId === "all" ? writeWorkspaceId : activeWorkspaceId)).map((project) => <option key={project.id} value={project.id}>{project.title}</option>)}</select></label>}
                  <label>{language === "cs" ? "Název" : "Title"}<input maxLength={200} value={contextTitle} onChange={(e) => setContextTitle(e.target.value)} placeholder={language === "cs" ? "Např. Jak plánuji pracovní den" : "e.g. How I plan my workday"} /></label>
                  <label>{language === "cs" ? "Obsah" : "Content"}<textarea maxLength={10000} value={contextContent} onChange={(e) => setContextContent(e.target.value)} placeholder={language === "cs" ? "Informace, preference nebo pravidlo…" : "Fact, preference or rule…"} /></label>
                  <div className="notificationActions"><button onClick={() => contextAction("create")} disabled={contextBusy || !contextTitle.trim() || !contextContent.trim() || (contextScope === "project" && !contextProjectId)}>{contextBusy ? tr("working") : tr("save")}</button></div>
                  {contextStatus && <p className="saveConfirmation" role="status">{contextStatus}</p>}
                </div>
                <div className="contextItems">
                  {durableContext.map((item) => <article key={item.id}><div><strong>{item.title}</strong><small>{item.scope} · {item.sensitivity === "sensitive" ? (language === "cs" ? "citlivý" : "sensitive") : (language === "cs" ? "běžný" : "normal")}</small><p>{item.content}</p></div><button className="textAction danger" onClick={() => contextAction("archive", item.id)} disabled={contextBusy}>{language === "cs" ? "Archivovat" : "Archive"}</button></article>)}
                  {!durableContext.length && <p>{language === "cs" ? "Zatím není uložen žádný trvalý kontext." : "No durable context saved yet."}</p>}
                </div>
              </section>
              <section>
                <h2>{tr("workspace")}</h2>
                <label>
                  {tr("language")}
                  <select
                    value={language}
                    onChange={(event) => saveLanguage(event.target.value as Language)}
                  >
                    <option value="cs">{tr("czech")}</option>
                    <option value="en">{tr("english")}</option>
                  </select>
                </label>
                <label>
                  {tr("appearance")}
                  <select
                    value={themeMode}
                    onChange={(event) => saveTheme(event.target.value as ThemeMode)}
                  >
                    <option value="system">{tr("systemTheme")}</option>
                    <option value="light">{tr("lightTheme")}</option>
                    <option value="dark">{tr("darkTheme")}</option>
                  </select>
                </label>
                <label>
                  {tr("currentView")}
                  <select
                    value={activeWorkspaceId}
                    onChange={(event) => selectWorkspace(event.target.value)}
                  >
                    {workspaces.map((workspace) => (
                      <option key={workspace.id} value={workspace.workspaceId}>
                        {workspace.title}
                      </option>
                    ))}
                    <option value="all">{tr("allWork")}</option>
                  </select>
                </label>
                {activeWorkspaceId === "all" && (
                  <label>
                    {tr("createIn")}
                    <select
                      value={writeWorkspaceId}
                      onChange={(event) => selectWriteWorkspace(event.target.value)}
                    >
                      {workspaces.map((workspace) => (
                        <option key={workspace.id} value={workspace.workspaceId}>
                          {workspace.title}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <label>
                  {tr("workspaceName")}
                  <div className="workspaceNameEditor">
                    <input
                      value={workspaceDraft}
                      maxLength={120}
                      onChange={(e) => {
                        setWorkspaceDraft(e.target.value);
                        setSettingsSaved(false);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") saveWorkspaceName();
                      }}
                      aria-label="Workspace name"
                    />
                    <button
                      onClick={saveWorkspaceName}
                      disabled={!workspaceDraft.trim()}
                    >
                      {tr("save")}
                    </button>
                  </div>
                </label>
                {settingsSaved && (
                  <p className="saveConfirmation" role="status">
                    {tr("workspaceSaved")}
                  </p>
                )}
                <div className="workspaceSummary">
                  <span>
                    {String(writeWorkspace?.properties.kind || "personal")} workspace
                  </span>
                  <span>
                    {tr("role")}: {String(writeWorkspace?.properties.role || "owner")}
                  </span>
                </div>
                <label>
                  {tr("newWorkspace")}
                  <div className="workspaceNameEditor">
                    <input
                      value={newWorkspaceDraft}
                      maxLength={120}
                      onChange={(event) => setNewWorkspaceDraft(event.target.value)}
                      placeholder="Family or Work"
                      aria-label="New workspace name"
                    />
                    <button
                      onClick={createWorkspace}
                      disabled={!newWorkspaceDraft.trim()}
                    >
                      {tr("create")}
                    </button>
                  </div>
                </label>
                <p>
                  Shared workspaces are ready for separate data and roles. Inviting
                  another account will be enabled after multi-user identity is added.
                </p>
                <label>
                  {tr("openStartup")}
                  <select
                    value={startupView}
                    onChange={(e) => {
                      setStartupView(e.target.value);
                      localStorage.setItem(
                        "ai-executive-startup-view",
                        e.target.value,
                      );
                    }}
                  >
                    {views
                      .filter((item) => item !== "Home")
                      .map((item) => (
                        <option key={item} value={item}>{tr(item)}</option>
                      ))}
                  </select>
                </label>
              </section>
              <section>
                <h2>{tr("dataAi")}</h2>
                <p>
                  {tr("workspaceDataInfo")}
                </p>
                <dl>
                  <div>
                    <dt>{tr("storedItems")}</dt>
                    <dd>{scopedItems.length}</dd>
                  </div>
                  <div>
                    <dt>{tr("relations")}</dt>
                    <dd>{scopedRelations.length}</dd>
                  </div>
                  <div>
                    <dt>{tr("serverSync")}</dt>
                    <dd className={`syncStatus ${syncStatus}`}>
                      {syncStatus === "synced"
                        ? tr("synced")
                        : syncStatus === "syncing"
                          ? tr("syncing")
                          : syncStatus === "offline"
                            ? tr("offline")
                            : tr("connecting")}
                    </dd>
                  </div>
                </dl>
              </section>
              <section>
                <h2>{tr("installApp")}</h2>
                <p>
                  {standalone
                    ? tr("installedApp")
                    : tr("installHelp")}
                </p>
                <span className={`installStatus ${standalone ? "installed" : ""}`}>
                  {standalone ? tr("installed") : tr("browserMode")}
                </span>
                <div className="badgeDiagnostics">
                  <h3>{tr("appBadge")}</h3>
                  <dl>
                    <div>
                      <dt>{tr("installApp")}</dt>
                      <dd>{standalone ? tr("installed") : tr("browserMode")}</dd>
                    </div>
                    <div>
                      <dt>{tr("notificationPermission")}</dt>
                      <dd>{typeof Notification !== "undefined" && Notification.permission === "granted" ? tr("allowed") : tr("notAllowed")}</dd>
                    </div>
                    <div>
                      <dt>{tr("badgeApi")}</dt>
                      <dd>{typeof navigator !== "undefined" && typeof (navigator as Navigator & { setAppBadge?: unknown }).setAppBadge === "function" ? tr("supported") : tr("unsupported")}</dd>
                    </div>
                    <div>
                      <dt>{tr("currentBadgeCount")}</dt>
                      <dd>{attentionTaskCount}</dd>
                    </div>
                  </dl>
                  <div className="notificationActions">
                    <button className="primaryAction" onClick={testAppBadge}>{tr("testBadge")}</button>
                    <button onClick={restoreAppBadge}>{tr("restoreBadge")}</button>
                  </div>
                  {badgeStatus && <p role="status">{badgeStatus}</p>}
                  <p className="settingsHint">{tr("badgeSystemHint")}</p>
                </div>
              </section>
              {authEnabled && (
                <section>
                  <h2>{tr("access")}</h2>
                  <p>{tr("ownerSession")}</p>
                  {passkeySupported && (
                    <>
                      <label>
                        {tr("passkeyName")}
                        <input
                          value={passkeyLabel}
                          maxLength={80}
                          onChange={(event) => setPasskeyLabel(event.target.value)}
                          placeholder="Kryštof’s iPhone"
                        />
                      </label>
                      <label>
                        {tr("confirmPassword")}
                        <input
                          type="password"
                          autoComplete="current-password"
                          value={passkeyPassword}
                          maxLength={1024}
                          onChange={(event) => setPasskeyPassword(event.target.value)}
                        />
                      </label>
                      <button
                        className="primaryAction"
                        onClick={registerPasskey}
                        disabled={passkeyBusy || !passkeyLabel.trim() || !passkeyPassword}
                      >
                        {passkeyBusy ? tr("waitingDevice") : tr("addPasskey")}
                      </button>
                      <div className="passkeyList">
                        {passkeys.map((passkey) => (
                          <div key={passkey.id} className="passkeyRow">
                            <span>
                              <strong>{passkey.label}</strong>
                              <small>
                                {passkey.rpId} · added {new Date(passkey.createdAt).toLocaleDateString()}
                                {passkey.backedUp ? " · synced" : ""}
                              </small>
                            </span>
                            <button onClick={() => removePasskey(passkey.id)}>{tr("remove")}</button>
                          </div>
                        ))}
                      </div>
                      {passkeyStatus && <p role="status">{passkeyStatus}</p>}
                      <p>
                        Passkeys are tied to this address. Use the same HTTPS address on
                        iPhone and Mac for an iCloud-synced passkey.
                      </p>
                    </>
                  )}
                  <button className="secondaryAction" onClick={logout}>{tr("signOut")}</button>
                </section>
              )}
              <section>
                <div className="sectionHeading">
                  <div>
                    <h2>{tr("reminders")}</h2>
                    <p>{tr("reminderInfo")}</p>
                  </div>
                  <span className={`installStatus ${notificationState?.subscriptionCount ? "installed" : ""}`}>
                    {notificationState?.subscriptionCount
                      ? `${notificationState.subscriptionCount} ${tr("devices")}`
                      : tr("noDevice")}
                  </span>
                </div>
                <div className="notificationActions">
                  <button className="primaryAction" onClick={enableNotifications}>{tr("enableDevice")}</button>
                  <button onClick={testNotification}>{tr("sendTest")}</button>
                  <button onClick={disableNotifications}>{tr("disableDevice")}</button>
                </div>
                {notificationState && (
                  <div className="preferenceGrid">
                    <label className="preferenceToggle">
                      <input
                        type="checkbox"
                        checked={notificationState.preferences.enabled}
                        onChange={(event) => saveNotificationSettings({
                          ...notificationState.preferences,
                          enabled: event.target.checked,
                        })}
                      />
                      {tr("scheduledReminders")}
                    </label>
                    <label>
                      {tr("timezone")}
                      <input
                        value={notificationState.preferences.timezone}
                        onChange={(event) => setNotificationState({
                          ...notificationState,
                          preferences: { ...notificationState.preferences, timezone: event.target.value },
                        })}
                        onBlur={() => saveNotificationSettings(notificationState.preferences)}
                      />
                    </label>
                    <label>
                      {tr("workdayStarts")}
                      <input
                        type="time"
                        value={notificationState.preferences.workdayStart}
                        onChange={(event) => saveNotificationSettings({
                          ...notificationState.preferences,
                          workdayStart: event.target.value,
                        })}
                      />
                    </label>
                    <label>
                      {tr("workdayEnds")}
                      <input
                        type="time"
                        value={notificationState.preferences.workdayEnd}
                        onChange={(event) => saveNotificationSettings({
                          ...notificationState.preferences,
                          workdayEnd: event.target.value,
                        })}
                      />
                    </label>
                    <fieldset>
                      <legend>{tr("workingDays")}</legend>
                      {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((label, day) => (
                        <label key={label}>
                          <input
                            type="checkbox"
                            checked={notificationState.preferences.workdays.includes(day)}
                            onChange={() => {
                              const workdays = notificationState.preferences.workdays.includes(day)
                                ? notificationState.preferences.workdays.filter((value) => value !== day)
                                : [...notificationState.preferences.workdays, day].sort();
                              saveNotificationSettings({ ...notificationState.preferences, workdays });
                            }}
                          />
                          {label}
                        </label>
                      ))}
                    </fieldset>
                  </div>
                )}
                {notificationStatus && <p role="status">{notificationStatus}</p>}
              </section>
              <section>
                <div className="sectionHeading">
                  <div>
                    <h2>{tr("calendarReadonly")}</h2>
                    <p>{tr("calendarInfo")}</p>
                  </div>
                  <span className={`installStatus ${calendarSources.some((source) => source.status === "ready") ? "installed" : ""}`}>
                    {calendarSources.some((source) => source.status === "ready") ? tr("readOnly") : tr("notConnected")}
                  </span>
                </div>
                <div className="calendarConnect">
                  <label>
                    {tr("sourceName")}
                    <input value={calendarLabel} maxLength={120} onChange={(event) => setCalendarLabel(event.target.value)} />
                  </label>
                  <label>
                    {tr("privateIcs")}
                    <input type="password" autoComplete="off" value={calendarUrl} maxLength={8192}
                      placeholder="https://…/calendar.ics"
                      onChange={(event) => setCalendarUrl(event.target.value)} />
                  </label>
                  <button className="primaryAction" disabled={calendarBusy || !calendarLabel.trim() || !calendarUrl.trim()}
                    onClick={() => calendarAction("connect")}>{tr("connectLoad")}</button>
                </div>
                <div className="calendarSources">
                  {calendarSources.map((source) => (
                    <div key={source.id}>
                      <span>
                        <strong>{source.label}</strong>
                        <small>
                          {source.status === "ready" ? `${source.eventCount} ${tr("events")}` : tr("syncFailed")}
                          {source.lastSuccessAt ? ` · ${tr("lastSync")} ${new Date(source.lastSuccessAt).toLocaleString(language === "cs" ? "cs-CZ" : "en-GB")}` : ""}
                        </small>
                        {source.lastError && <small role="status">{source.lastError}</small>}
                      </span>
                      <div className="notificationActions">
                        <button disabled={calendarBusy} onClick={() => calendarAction("refresh", source.id)}>{tr("refresh")}</button>
                        <button disabled={calendarBusy} onClick={() => {
                          if (window.confirm(`Odpojit kalendář „${source.label}“ a odstranit jeho lokální události?`)) calendarAction("disconnect", source.id);
                        }}>{tr("disconnect")}</button>
                      </div>
                    </div>
                  ))}
                </div>
                {calendarStatus && <p role="status">{calendarStatus}</p>}
              </section>
              <section>
                <div className="sectionHeading">
                  <div>
                    <h2>Proactive executive</h2>
                    <p>{tr("proactiveInfo")}</p>
                  </div>
                  <button onClick={() => runBriefing("morning")} disabled={briefingBusy}>
                    {tr("createNow")}
                  </button>
                </div>
                {notificationState && (
                  <div className="preferenceGrid">
                    <label className="preferenceToggle">
                      <input type="checkbox" checked={notificationState.preferences.briefingEnabled}
                        onChange={(event) => saveNotificationSettings({ ...notificationState.preferences, briefingEnabled: event.target.checked })} />
                      {tr("automaticBriefs")}
                    </label>
                    <label>
                      {tr("workspace")}
                      <select value={notificationState.preferences.briefingWorkspaceId}
                        onChange={(event) => saveNotificationSettings({ ...notificationState.preferences, briefingWorkspaceId: event.target.value })}>
                        {workspaces.map((workspace) => <option key={workspace.id} value={workspace.workspaceId}>{workspace.title}</option>)}
                      </select>
                    </label>
                    <label className="preferenceToggle">
                      <input type="checkbox" checked={notificationState.preferences.morningBriefEnabled}
                        onChange={(event) => saveNotificationSettings({ ...notificationState.preferences, morningBriefEnabled: event.target.checked })} />
                      {tr("morningBrief")}
                    </label>
                    <label>
                      {tr("morningTime")}
                      <input type="time" value={notificationState.preferences.morningBriefTime}
                        onChange={(event) => saveNotificationSettings({ ...notificationState.preferences, morningBriefTime: event.target.value })} />
                    </label>
                    <label className="preferenceToggle">
                      <input type="checkbox" checked={notificationState.preferences.eveningReviewEnabled}
                        onChange={(event) => saveNotificationSettings({ ...notificationState.preferences, eveningReviewEnabled: event.target.checked })} />
                      {tr("eveningReview")}
                    </label>
                    <label>
                      {tr("eveningTime")}
                      <input type="time" value={notificationState.preferences.eveningReviewTime}
                        onChange={(event) => saveNotificationSettings({ ...notificationState.preferences, eveningReviewTime: event.target.value })} />
                    </label>
                    <label>
                      {tr("dailyCapacity")}
                      <input type="number" min="1" max="50" value={notificationState.preferences.dailyTaskCapacity}
                        onChange={(event) => saveNotificationSettings({ ...notificationState.preferences, dailyTaskCapacity: Number(event.target.value) })} />
                    </label>
                    <label className="preferenceToggle">
                      <input type="checkbox" checked={notificationState.preferences.briefingPush}
                        onChange={(event) => saveNotificationSettings({ ...notificationState.preferences, briefingPush: event.target.checked })} />
                      {tr("briefPush")}
                    </label>
                    <label className="preferenceToggle">
                      <input type="checkbox" checked={notificationState.preferences.briefingTelegram}
                        onChange={(event) => saveNotificationSettings({ ...notificationState.preferences, briefingTelegram: event.target.checked })} />
                      {tr("briefTelegram")}
                    </label>
                  </div>
                )}
              </section>
              <section>
                <div className="sectionHeading">
                  <div>
                    <h2>{tr("backups")}</h2>
                    <p>{tr("backupInfo")}</p>
                  </div>
                  <button className="primaryAction" onClick={createServerBackup}>
                    {tr("createBackup")}
                  </button>
                </div>
                {backupStatus && <p role="status">{backupStatus}</p>}
                <div className="backupList">
                  {backups.length === 0 && <p>{tr("noBackups")}</p>}
                  {backups.slice(0, 8).map((backup) => (
                    <div key={backup.name}>
                      <span>
                        <strong>{new Date(backup.createdAt).toLocaleString()}</strong>
                        <small>
                          {backup.error
                            ? `Invalid backup · ${backup.error}`
                            : `${backup.entityCount} ${tr("items")} · ${backup.relationCount} ${tr("relations").toLowerCase()}`}
                        </small>
                      </span>
                      <button
                        disabled={Boolean(backup.error)}
                        onClick={() => restoreServerBackup(backup)}
                      >
                        {tr("restore")}
                      </button>
                    </div>
                  ))}
                </div>
              </section>
            </div>
          )}
          {view !== "Settings" && view !== "Agents" && (
            <>
              {!["Home", "Search", "Projects", "Areas", "Notes"].includes(view) && (
                <div className="listControls">
                  <label>
                    {tr("priority")}
                    <select value={priorityFilter} onChange={(event) => setPriorityFilter(event.target.value)}>
                      <option value="all">{tr("all")}</option>
                      <option value="high">{tr("high")}</option>
                      <option value="medium">{tr("medium")}</option>
                      <option value="low">{tr("low")}</option>
                      <option value="none">{tr("none")}</option>
                    </select>
                  </label>
                  <label>
                    {tr("sort")}
                    <select value={sortBy} onChange={(event) => setSortBy(event.target.value as typeof sortBy)}>
                      <option value="manual">{tr("manual")}</option>
                      <option value="date">{tr("date")}</option>
                      <option value="priority">{tr("priority")}</option>
                      <option value="created">{tr("newest")}</option>
                    </select>
                  </label>
                </div>
              )}
              {draggedEntity && (
                <div className="sectionDropZones" aria-label={tr("moveToSection")}>
                  {draggedEntity.type === "task" && draggableSectionNames.map((section) => (
                    <button
                      key={section}
                      className={dragTarget === `section:${section}` ? "dropActive" : ""}
                      data-drop-section={section}
                      onDragEnter={() => setActiveDragTarget(`section:${section}`)}
                      onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; }}
                      onDrop={(event) => acceptNativeDrop(event, `section:${section}`)}
                    >
                      {viewIcons[section]} {tr(section)}
                    </button>
                  ))}
                  {(draggedEntity.type === "task" || draggedEntity.type === "note") && projects
                    .filter((project) => project.workspaceId === draggedEntity.workspaceId && project.status === "active")
                    .sort(byManualOrder("project:all"))
                    .map((project) => (
                      <button
                        key={project.id}
                        className={dragTarget === `entity:${project.id}` ? "dropActive" : ""}
                        data-drop-entity={project.id}
                        onDragEnter={() => setActiveDragTarget(`entity:${project.id}`)}
                        onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; }}
                        onDrop={(event) => acceptNativeDrop(event, `entity:${project.id}`)}
                      >
                        ◇ {project.title}
                      </button>
                    ))}
                  {draggedEntity.type === "project" && areas
                    .filter((area) => area.workspaceId === draggedEntity.workspaceId && area.status === "active")
                    .sort(byManualOrder("area:all"))
                    .map((area) => (
                      <button
                        key={area.id}
                        className={dragTarget === `entity:${area.id}` ? "dropActive" : ""}
                        data-drop-entity={area.id}
                        onDragEnter={() => setActiveDragTarget(`entity:${area.id}`)}
                        onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; }}
                        onDrop={(event) => acceptNativeDrop(event, `entity:${area.id}`)}
                      >
                        ◎ {area.title}
                      </button>
                    ))}
                </div>
              )}
              <div
                className={
                  "list " +
                  (view === "Home" || view === "Search" ? "secondary" : "")
                }
              >
                {collection.map((x) => (
              <article
                key={x.id}
                className={`${draggingId === x.id ? "isDragging" : ""} ${dragTarget === `entity:${x.id}` ? "dropActive" : ""} ${taskDueTone(x, today)}`.trim()}
                data-drop-entity={x.id}
                onDragEnter={() => setActiveDragTarget(`entity:${x.id}`)}
                onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; }}
                onDrop={(event) => acceptNativeDrop(event, `entity:${x.id}`)}
                onClick={() => inspect(x)}
              >
                {x.type === "task" && priorityFilter !== "all" ? null : dragHandle(x)}
                {x.type === "task" ? (
                  <button
                    className="check"
                    onClick={(e) => {
                      e.stopPropagation();
                      done(x.id);
                    }}
                  >
                    ○
                  </button>
                ) : (
                  <div className={`entityIcon ${x.type}Icon`}>
                    {x.type === "project" ? "◆" : x.type === "area" ? "●" : "▤"}
                  </div>
                )}
                <div>
                  <strong>{x.title}</strong>
                  <small>
                    {x.type === "task"
                      ? [
                          x.properties.priority &&
                          x.properties.priority !== "none"
                            ? "● " + tr(String(x.properties.priority))
                            : null,
                          taskDueTone(x, today) === "dueOverdue"
                            ? tr("Overdue")
                            : null,
                          taskDueTone(x, today) === "dueSoon"
                            ? tr("dueSoon")
                            : null,
                          typeof x.properties.when === "string"
                            ? friendlyDate(x.properties.when, language)
                            : null,
                          x.properties.deadline &&
                            tr("deadline") + " " + friendlyDate(x.properties.deadline, language),
                        ]
                          .filter(Boolean)
                          .join(" · ") ||
                        (x.properties.today === true
                          ? tr("Today")
                          : x.properties.someday === true
                            ? tr("Someday")
                            : x.properties.inbox === true
                              ? tr("Inbox")
                              : tr("Anytime"))
                      : tr(x.type === "project" ? "Projects" : x.type === "area" ? "Areas" : "Notes")}
                  </small>
                  {activeWorkspaceId === "all" && (
                    <span className="workspaceBadge">
                      {workspaces.find(
                        (workspace) => workspace.workspaceId === x.workspaceId,
                      )?.title || "Workspace"}
                    </span>
                  )}
                </div>
                  </article>
                ))}
                {collection.length === 0 && view !== "Home" && view !== "Search" && (
                  <div className="empty">{tr("nothingHere")}</div>
                )}
              </div>
              {!['Home', 'Search'].includes(view) && (
                <div className="capture">
                  <input
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && create(type, text)}
                    placeholder={`+ ${tr("add")} ${tr(type === "project" ? "Projects" : type === "area" ? "Areas" : type === "note" ? "Notes" : "Today").toLowerCase()}`}
                  />
                  <button onClick={() => create(type, text)}>{tr("add")}</button>
                </div>
              )}
            </>
          )}
        </div>
      </section>
      <nav className="mobileNav">
        {mobileViews.map((x) => (
          <button
            key={x}
            className={
              (view === x || (x === "More" && moreOpen)) && x !== "+"
                ? "active"
                : ""
            }
            aria-label={x === "+" ? tr("quickCapture") : tr(x)}
            aria-current={view === x ? "page" : undefined}
            onClick={() => {
              if (x === "+") return openCapture();
              if (x === "More") return setMoreOpen((open) => !open);
              setMoreOpen(false);
              closeDetail();
              setView(x);
            }}
          >
            {x === "+" ? <span className="mobileAddIcon">＋</span> : <><span className="mobileNavIcon" aria-hidden="true">{viewIcons[x]}</span><span>{tr(x)}</span></>}
          </button>
        ))}
      </nav>
      {moreOpen && (
        <div className="mobileMoreBackdrop" onClick={() => setMoreOpen(false)}>
          <div className="mobileMore" onClick={(e) => e.stopPropagation()}>
            {moreViews.map((item) => (
              <button
                key={item}
                className={view === item ? "active" : ""}
                onClick={() => {
                  setView(item);
                  closeDetail();
                  setMoreOpen(false);
                }}
              >
                {tr(item)}
              </button>
            ))}
          </div>
        </div>
      )}
      {capture && (
        <div className="captureOverlay" onClick={() => setCapture(false)}>
          <form
            ref={captureModalRef}
            className="captureModal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="capture-title"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === "Escape") setCapture(false);
              if (e.key === "Tab") {
                const focusable = [...(captureModalRef.current?.querySelectorAll<HTMLElement>(
                  'input, button:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])',
                ) || [])];
                if (!focusable.length) return;
                const first = focusable[0];
                const last = focusable[focusable.length - 1];
                if (e.shiftKey && document.activeElement === first) {
                  e.preventDefault();
                  last.focus();
                } else if (!e.shiftKey && document.activeElement === last) {
                  e.preventDefault();
                  first.focus();
                }
              }
            }}
            onSubmit={(e) => {
              e.preventDefault();
              submitCapture();
            }}
          >
            <h2 id="capture-title">{captureType === "note" ? tr("addNote") : tr("quickCapture")}</h2>
            {activeWorkspaceId === "all" && !captureProjectId && (
              <label className="captureWorkspace">
                {tr("workspace")}
                <select
                  value={writeWorkspaceId}
                  onChange={(event) => selectWriteWorkspace(event.target.value)}
                >
                  {workspaces.map((workspace) => (
                    <option key={workspace.id} value={workspace.workspaceId}>
                      {workspace.title}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <input
              autoFocus
              aria-label={captureType === "note" ? tr("noteTitle") : tr("taskTitle")}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={
                captureType === "note" ? tr("noteTitle") : tr("taskPrompt")
              }
            />
            {captureType === "task" && (
              <>
                <p>{tr("captureExample")}</p>
                {draft.trim() && (
                  <div className="capturePreview">
                    <strong>{parseCapture(draft).title || tr("untitledTask")}</strong>
                    <span>
                      {parseCapture(draft).when || tr("Inbox")}
                      {parseCapture(draft).priority !== "none" ? ` · ${tr(parseCapture(draft).priority)}` : ""}
                    </span>
                  </div>
                )}
                {captureSuggestionBusy && <div className="captureSuggestionState">◇ {tr("suggesting")}</div>}
                {captureSuggestionError && !captureSuggestionBusy && (
                  <div className="captureSuggestionState error">{captureSuggestionError}</div>
                )}
                {captureSuggestion && !captureSuggestionBusy && (
                  <div className="captureSuggestion">
                    <div className="captureSuggestionHead">
                      <strong>◇ {tr("albertSuggestion")}</strong>
                      <span>{tr("confidence")}: {tr(captureSuggestion.confidence)}</span>
                    </div>
                    <label className="captureSuggestionToggle">
                      <input
                        type="checkbox"
                        checked={useCaptureSuggestion}
                        onChange={(event) => setUseCaptureSuggestion(event.target.checked)}
                      />
                      {tr("useSuggestion")}
                    </label>
                    <div className="captureSuggestionGrid" aria-disabled={!useCaptureSuggestion}>
                      <label>
                        {tr("project")}
                        <select
                          value={captureSuggestion.projectId}
                          disabled={!useCaptureSuggestion || Boolean(captureProjectId)}
                          onChange={(event) => {
                            const entity = items.find((item) => item.id === event.target.value);
                            setCaptureSuggestion({ ...captureSuggestion, projectId: event.target.value, projectTitle: entity?.title || "" });
                          }}
                        >
                          <option value="">—</option>
                          {items.filter((item) => item.type === "project" && item.status === "active" && item.workspaceId === (activeWorkspaceId === "all" ? writeWorkspaceId : activeWorkspaceId)).sort((a, b) => a.title.localeCompare(b.title)).map((item) => (
                            <option key={item.id} value={item.id}>{item.title}</option>
                          ))}
                        </select>
                      </label>
                      <label>
                        {tr("area")}
                        <select
                          value={captureSuggestion.areaId}
                          disabled={!useCaptureSuggestion}
                          onChange={(event) => {
                            const entity = items.find((item) => item.id === event.target.value);
                            setCaptureSuggestion({ ...captureSuggestion, areaId: event.target.value, areaTitle: entity?.title || "" });
                          }}
                        >
                          <option value="">—</option>
                          {items.filter((item) => item.type === "area" && item.status === "active" && item.workspaceId === (activeWorkspaceId === "all" ? writeWorkspaceId : activeWorkspaceId)).sort((a, b) => a.title.localeCompare(b.title)).map((item) => (
                            <option key={item.id} value={item.id}>{item.title}</option>
                          ))}
                        </select>
                      </label>
                      <label>
                        {tr("priority")}
                        <select
                          value={captureSuggestion.priority}
                          disabled={!useCaptureSuggestion || parseCapture(draft).priority !== "none"}
                          onChange={(event) => setCaptureSuggestion({ ...captureSuggestion, priority: event.target.value as CaptureSuggestion["priority"] })}
                        >
                          {(["none", "low", "medium", "high"] as const).map((priority) => (
                            <option key={priority} value={priority}>{tr(priority)}</option>
                          ))}
                        </select>
                      </label>
                      <label>
                        {tr("duration")}
                        <span className="captureDurationInput">
                          <input
                            type="number"
                            min="10"
                            max="480"
                            step="5"
                            value={captureSuggestion.estimatedMinutes}
                            disabled={!useCaptureSuggestion}
                            onChange={(event) => setCaptureSuggestion({
                              ...captureSuggestion,
                              estimatedMinutes: Math.max(10, Math.min(480, Number(event.target.value) || 10)),
                              scheduledStart: "",
                              scheduledEnd: "",
                              scheduledDate: parseCapture(draft).when,
                              scheduledOptions: [],
                            })}
                          />
                          {tr("minutes")}
                        </span>
                      </label>
                    </div>
                    <div className="capturePlannedTime">
                      <b>{tr("plannedTime")}</b>
                      {captureSuggestion.scheduledOptions.length ? (
                        <select
                          value={captureSuggestion.scheduledStart}
                          disabled={!useCaptureSuggestion}
                          onChange={(event) => {
                            const option = captureSuggestion.scheduledOptions.find((candidate) => candidate.start === event.target.value);
                            setCaptureSuggestion({
                              ...captureSuggestion,
                              scheduledStart: option?.start || "",
                              scheduledEnd: option?.end || "",
                              scheduledDate: option?.date || parseCapture(draft).when,
                            });
                          }}
                        >
                          <option value="">{tr("noPlannedTime")}</option>
                          {captureSuggestion.scheduledOptions.map((option) => (
                            <option key={option.start} value={option.start}>
                              {new Date(option.start).toLocaleString(language === "cs" ? "cs-CZ" : "en-US", { weekday: "short", day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" })}
                            </option>
                          ))}
                        </select>
                      ) : <span>{tr("noFreeSlot")}</span>}
                    </div>
                    <details>
                      <summary>{tr("whySuggested")}</summary>
                      <ul>{captureSuggestion.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
                      <b>{tr("constraintsUsed")}</b>
                      <ul>{captureSuggestion.constraints.map((constraint) => <li key={constraint}>{constraint}</li>)}</ul>
                    </details>
                  </div>
                )}
              </>
            )}
            <div>
              <button type="button" onClick={() => setCapture(false)}>
                {tr("cancel")}
              </button>
              <button
                type="submit"
                className="ai"
                disabled={!draft.trim() || (captureType === "task" && captureSuggestionBusy)}
              >
                {captureType === "note" ? tr("addNote") : tr("addTask")}
              </button>
            </div>
          </form>
        </div>
      )}
      {selected && (
        <div className="backdrop" onClick={closeDetail}>
          <aside className="detail" onClick={(e) => e.stopPropagation()}>
            <button
              className="close"
              onClick={closeDetail}
            >
              ×
            </button>
            <p className="eyebrow">{tr(selected.type)}</p>
            <input
              className="titleEdit"
              value={selected.title}
              onChange={(e) =>
                setSelected({ ...selected, title: e.target.value })
              }
              onBlur={(e) => rename(selected, e.target.value)}
            />
            {context && (
              <div className="contextStrip">
                <b>{tr("context")}</b>
                <span>
                  {context.summary.tasks} tasks · {context.summary.notes} notes
                  · {context.summary.projects} projects ·{" "}
                  {context.summary.areas} areas
                </span>
                <small>
                  {context.related
                    .slice(0, 6)
                    .map((x) => x.title)
                    .join(" · ") || "No related entities"}
                </small>
              </div>
            )}
            {selected.type === "area" && (
              <div className="projectDetail">
                <h3>{tr("Projects").toUpperCase()}</h3>
                {projects
                  .filter((p) =>
                    sources(selected.id, "belongs_to_area").includes(p.id),
                  )
                  .sort(byManualOrder(`project:area:${selected.id}`))
                  .map((p) => (
                    <article
                      key={p.id}
                      className={`${draggingId === p.id ? "isDragging" : ""} ${dragTarget === `entity:${p.id}` ? "dropActive" : ""}`.trim()}
                      data-drop-entity={p.id}
                      onDragOver={(event) => { event.preventDefault(); setActiveDragTarget(`entity:${p.id}`); }}
                      onDrop={(event) => acceptNativeDrop(event, `entity:${p.id}`)}
                      onClick={() => inspect(p)}
                    >
                      {dragHandle(p)}
                      <div className="entityIcon projectIcon">◆</div>
                      <div>
                        <strong>{p.title}</strong>
                        <small>{tr("project")}</small>
                      </div>
                    </article>
                  ))}
                <h3>{tr("task").toUpperCase()}</h3>
                {tasks
                  .filter(
                    (t) =>
                      t.status === "open" &&
                      sources(selected.id, "belongs_to_area").includes(t.id),
                  )
                  .sort(byManualOrder(`task:area:${selected.id}`))
                  .map((t) => (
                    <article
                      key={t.id}
                      className={`${draggingId === t.id ? "isDragging" : ""} ${dragTarget === `entity:${t.id}` ? "dropActive" : ""} ${taskDueTone(t, today)}`.trim()}
                      data-drop-entity={t.id}
                      onDragOver={(event) => { event.preventDefault(); setActiveDragTarget(`entity:${t.id}`); }}
                      onDrop={(event) => acceptNativeDrop(event, `entity:${t.id}`)}
                      onClick={() => inspect(t)}
                    >
                      {dragHandle(t)}
                      <button
                        className="check"
                        onClick={(e) => {
                          e.stopPropagation();
                          done(t.id);
                        }}
                      >
                        ○
                      </button>
                      <strong>{t.title}</strong>
                    </article>
                  ))}
              </div>
            )}
            {selected.type === "project" && (
              <div className="projectDetail">
                <label>
                  {tr("area")}
                  <select
                    value={String(
                      targets(selected.id, "belongs_to_area")[0] || "",
                    )}
                    onChange={async (e) => {
                      await relate(
                        selected.id,
                        e.target.value,
                        "belongs_to_area",
                      );
                    }}
                  >
                    <option value="">{tr("none")}</option>
                    {areas.filter((area) => area.workspaceId === selected.workspaceId).map((a) => (
                      <option value={a.id} key={a.id}>
                        {a.title}
                      </option>
                    ))}
                  </select>
                </label>
                <h3>{tr("openTasks").toUpperCase()}</h3>
                {tasks
                  .filter(
                    (t) =>
                      t.status === "open" &&
                      sources(selected.id, "belongs_to_project").includes(t.id),
                  )
                  .sort(byManualOrder(`task:project:${selected.id}`))
                  .map((t) => (
                    <article
                      key={t.id}
                      className={`${draggingId === t.id ? "isDragging" : ""} ${dragTarget === `entity:${t.id}` ? "dropActive" : ""} ${taskDueTone(t, today)}`.trim()}
                      data-drop-entity={t.id}
                      onDragOver={(event) => { event.preventDefault(); setActiveDragTarget(`entity:${t.id}`); }}
                      onDrop={(event) => acceptNativeDrop(event, `entity:${t.id}`)}
                      onClick={() => inspect(t)}
                    >
                      {dragHandle(t)}
                      <button className="check" onClick={(event) => { event.stopPropagation(); done(t.id); }}>
                        ○
                      </button>
                      <strong>{t.title}</strong>
                    </article>
                  ))}
                <button
                  onClick={() => {
                    openCapture("task", selected.id);
                  }}
                >
                  ＋ {tr("addTask")}
                </button>
                <h3>{tr("Notes").toUpperCase()}</h3>
                {scopedItems
                  .filter(
                    (n) =>
                      n.type === "note" &&
                      sources(selected.id, "belongs_to_project").includes(n.id),
                  )
                  .sort(byManualOrder(`note:project:${selected.id}`))
                  .map((n) => (
                    <article
                      key={n.id}
                      className={`${draggingId === n.id ? "isDragging" : ""} ${dragTarget === `entity:${n.id}` ? "dropActive" : ""}`.trim()}
                      data-drop-entity={n.id}
                      onDragOver={(event) => { event.preventDefault(); setActiveDragTarget(`entity:${n.id}`); }}
                      onDrop={(event) => acceptNativeDrop(event, `entity:${n.id}`)}
                      onClick={() => inspect(n)}
                    >
                      {dragHandle(n)}
                      <div>
                        <strong>{n.title}</strong>
                        <p>{n.content}</p>
                      </div>
                    </article>
                  ))}
                <button
                  onClick={() => {
                    openCapture("note", selected.id);
                  }}
                >
                  ＋ {tr("addNote")}
                </button>
              </div>
            )}
            {selected.type === "note" && (
              <div className="fields">
                <label>
                  {tr("project")}
                  <select
                    value={String(
                      targets(selected.id, "belongs_to_project")[0] || "",
                    )}
                    onChange={async (e) => {
                      await relate(
                        selected.id,
                        e.target.value,
                        "belongs_to_project",
                      );
                    }}
                  >
                    <option value="">{tr("none")}</option>
                    {projects.filter((project) => project.workspaceId === selected.workspaceId).map((p) => (
                      <option value={p.id} key={p.id}>
                        {p.title}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            )}
            {selected.type === "task" && (
              <div className="fields">
                <label>
                  {tr("list")}
                  <select
                    value={
                      selected.properties.inbox === true
                        ? "Inbox"
                        : selected.properties.someday === true
                          ? "Someday"
                        : selected.properties.today === true ||
                            (typeof selected.properties.when === "string" && selected.properties.when <= today)
                            ? "Today"
                            : "Anytime"
                    }
                    onChange={(event) => {
                      const destination = event.target.value;
                      patch(selected, {
                        inbox: destination === "Inbox",
                        someday: destination === "Someday",
                        today: destination === "Today",
                        when: destination === "Today" ? today : "",
                      }, `moved to ${destination}`);
                    }}
                  >
                    <option value="Inbox">{tr("Inbox")}</option>
                    <option value="Today">{tr("Today")}</option>
                    <option value="Anytime">{tr("Anytime")}</option>
                    <option value="Someday">{tr("Someday")}</option>
                  </select>
                </label>
                <label>
                  {tr("when")}
                  <input
                    type="date"
                    value={String(selected.properties.when || "")}
                    onChange={(e) =>
                      patch(selected, {
                        when: e.target.value,
                        today: e.target.value === today,
                        inbox: false,
                        someday: false,
                      })
                    }
                  />
                </label>
                <label>
                  {tr("deadline")}
                  <input
                    type="date"
                    value={String(selected.properties.deadline || "")}
                    onChange={(e) =>
                      patch(selected, { deadline: e.target.value })
                    }
                  />
                </label>
                <label>
                  {tr("project")}
                  <select
                    value={String(
                      targets(selected.id, "belongs_to_project")[0] || "",
                    )}
                    onChange={async (e) => {
                      await patch(selected, { inbox: false });
                      await relate(
                        selected.id,
                        e.target.value,
                        "belongs_to_project",
                      );
                    }}
                  >
                    <option value="">{tr("none")}</option>
                    {projects.filter((project) => project.workspaceId === selected.workspaceId).map((p) => (
                      <option value={p.id} key={p.id}>
                        {p.title}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  {tr("area")}
                  <select
                    value={String(
                      targets(selected.id, "belongs_to_area")[0] || "",
                    )}
                    onChange={async (e) => {
                      await relate(
                        selected.id,
                        e.target.value,
                        "belongs_to_area",
                      );
                    }}
                  >
                    <option value="">{tr("none")}</option>
                    {areas.filter((area) => area.workspaceId === selected.workspaceId).map((a) => (
                      <option value={a.id} key={a.id}>
                        {a.title}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  {tr("priority")}
                  <select
                    value={String(selected.properties.priority || "none")}
                    onChange={(e) =>
                      patch(selected, { priority: e.target.value })
                    }
                  >
                    <option value="none">{tr("none")}</option>
                    <option value="low">{tr("low")}</option>
                    <option value="medium">{tr("medium")}</option>
                    <option value="high">{tr("high")}</option>
                  </select>
                </label>
                <label>
                  {tr("duration")}
                  <input
                    type="number"
                    min="10"
                    max="480"
                    step="5"
                    value={String(selected.properties.estimatedMinutes || "")}
                    onChange={(event) => {
                      const estimatedMinutes = Math.max(10, Math.min(480, Number(event.target.value) || 10));
                      const plannedStart = String(selected.properties.plannedStart || "");
                      patch(selected, {
                        estimatedMinutes,
                        ...(plannedStart ? { plannedEnd: new Date(Date.parse(plannedStart) + estimatedMinutes * 60_000).toISOString() } : {}),
                      }, "duration changed");
                    }}
                  />
                </label>
                <label>
                  {tr("plannedTime")}
                  <input
                    type="datetime-local"
                    value={toLocalDateTime(selected.properties.plannedStart)}
                    onChange={(event) => {
                      const plannedStart = fromLocalDateTime(event.target.value);
                      const estimatedMinutes = Number(selected.properties.estimatedMinutes || 30);
                      const feedback = { date: calendarToday, decision: "adjusted", at: Date.now(), chosenStart: plannedStart };
                      const history = Array.isArray(selected.properties.planningHistory) ? selected.properties.planningHistory : [];
                      patch(selected, {
                        plannedStart,
                        plannedEnd: plannedStart ? new Date(Date.parse(plannedStart) + estimatedMinutes * 60_000).toISOString() : "",
                        planningSource: plannedStart ? "manual" : "",
                        planningFeedback: feedback,
                        planningHistory: [...history, feedback].slice(-50),
                        ...(event.target.value ? { when: event.target.value.slice(0, 10), inbox: false, someday: false } : {}),
                      }, "planned time changed");
                    }}
                  />
                </label>
                <label>
                  {tr("reminder")}
                  <input
                    type="datetime-local"
                    value={toLocalDateTime(selected.properties.reminderAt)}
                    onChange={(e) =>
                      patch(selected, { reminderAt: fromLocalDateTime(e.target.value) }, "reminder changed")
                    }
                  />
                </label>
                {selected.properties.when && notificationState && (
                  <button
                    type="button"
                    onClick={() => {
                      const planned = new Date(`${String(selected.properties.when)}T12:00:00Z`);
                      const workdays = notificationState.preferences.workdays;
                      while (workdays.length && !workdays.includes(planned.getUTCDay())) {
                        planned.setUTCDate(planned.getUTCDate() + 1);
                      }
                      const date = planned.toISOString().slice(0, 10);
                      patch(selected, {
                        reminderAt: zonedDateTimeToIso(
                          date,
                          notificationState.preferences.workdayStart,
                          notificationState.preferences.timezone,
                        ),
                      }, "workday reminder set");
                    }}
                  >
                    {tr("nextWorkday")}
                  </button>
                )}
                <label>
                  {tr("taskNotes")}
                  <textarea
                    value={String(selected.properties.notes || "")}
                    onChange={(e) => patch(selected, { notes: e.target.value })}
                    placeholder={tr("notesPlaceholder")}
                  />
                </label>
                <div className="checklistField">
                  <span>{tr("checklist")}</span>
                  {(Array.isArray(selected.properties.checklist)
                    ? selected.properties.checklist
                    : []
                  ).map((raw, index, all) => {
                    const item = typeof raw === "string"
                      ? { id: `${index}`, title: raw, done: false }
                      : raw as { id?: string; title?: string; done?: boolean };
                    return (
                      <label className="checklistItem" key={item.id || index}>
                        <input
                          type="checkbox"
                          checked={Boolean(item.done)}
                          onChange={() => patch(selected, {
                            checklist: all.map((entry, entryIndex) => {
                              const normalized = typeof entry === "string"
                                ? { id: `${entryIndex}`, title: entry, done: false }
                                : entry as { id?: string; title?: string; done?: boolean };
                              return entryIndex === index
                                ? { ...normalized, done: !normalized.done }
                                : normalized;
                            }),
                          }, "checklist updated")}
                        />
                        <span className={item.done ? "checked" : ""}>{item.title}</span>
                      </label>
                    );
                  })}
                  <div className="checklistAdd">
                    <input
                      value={checklistDraft}
                      onChange={(event) => setChecklistDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key !== "Enter" || !checklistDraft.trim()) return;
                        event.preventDefault();
                        const existing = Array.isArray(selected.properties.checklist)
                          ? selected.properties.checklist
                          : [];
                        patch(selected, {
                          checklist: [...existing, { id: crypto.randomUUID(), title: checklistDraft.trim(), done: false }],
                        }, "checklist item added");
                        setChecklistDraft("");
                      }}
                      placeholder={tr("addChecklistItem")}
                    />
                    <button
                      type="button"
                      disabled={!checklistDraft.trim()}
                      onClick={() => {
                        const existing = Array.isArray(selected.properties.checklist)
                          ? selected.properties.checklist
                          : [];
                        patch(selected, {
                          checklist: [...existing, { id: crypto.randomUUID(), title: checklistDraft.trim(), done: false }],
                        }, "checklist item added");
                        setChecklistDraft("");
                      }}
                    >{tr("add")}</button>
                  </div>
                </div>
                <label>
                  {tr("repeat")}
                  <select
                    value={String(
                      (selected.properties.recurrence as any)?.frequency ||
                        selected.properties.repeat ||
                        "",
                    )}
                    onChange={(e) =>
                      patch(selected, {
                        recurrence: e.target.value
                          ? {
                              frequency: e.target.value,
                              interval: 1,
                              mode: "scheduled",
                            }
                          : null,
                        repeat: null,
                      })
                    }
                  >
                    <option value="">{tr("never")}</option>
                    <option value="daily">{tr("daily")}</option>
                    <option value="weekly">{tr("weekly")}</option>
                    <option value="monthly">{tr("monthly")}</option>
                    <option value="yearly">{tr("yearly")}</option>
                  </select>
                </label>
                {(selected.properties.recurrence as any)?.frequency && (
                  <>
                    <label>
                      {tr("every")}
                      <input
                        type="number"
                        min="1"
                        value={String(
                          (selected.properties.recurrence as any)?.interval ||
                            1,
                        )}
                        onChange={(e) =>
                          patch(selected, {
                            recurrence: {
                              ...(selected.properties.recurrence as any),
                              interval: Number(e.target.value),
                            },
                          })
                        }
                      />
                    </label>
                    <label>
                      {tr("repeatFrom")}
                      <select
                        value={String(
                          (selected.properties.recurrence as any)?.mode ||
                            "scheduled",
                        )}
                        onChange={(e) =>
                          patch(selected, {
                            recurrence: {
                              ...(selected.properties.recurrence as any),
                              mode: e.target.value,
                            },
                          })
                        }
                      >
                        <option value="scheduled">{tr("scheduledDate")}</option>
                        <option value="completion">{tr("completionDate")}</option>
                      </select>
                    </label>
                  </>
                )}
                {Array.isArray(selected.properties.activity) && selected.properties.activity.length > 0 && (
                  <div className="activityLog">
                    <h3>{tr("history").toUpperCase()}</h3>
                    {[...selected.properties.activity]
                      .reverse()
                      .slice(0, 12)
                      .map((entry: any, index) => (
                        <div key={`${entry.at}-${index}`}>
                          <span>{String(entry.action || "updated")}</span>
                          <time>{new Date(Number(entry.at)).toLocaleString()}</time>
                        </div>
                      ))}
                  </div>
                )}
                <button
                  onClick={() =>
                    patch(selected, {
                      someday: true,
                      today: false,
                      when: "",
                      inbox: false,
                    })
                  }
                >
                  {tr("moveSomeday")}
                </button>
                {selected.status === "completed" ? (
                  <button onClick={() => reopenTask(selected)}>{tr("reopen")}</button>
                ) : (
                  <button onClick={() => done(selected.id)}>{tr("complete")}</button>
                )}
                <button className="danger" onClick={() => remove(selected)}>
                  {tr("delete")}
                </button>
              </div>
            )}
          </aside>
        </div>
      )}
      {assistantOpen && (
        <div className="assistantPanel">
          <div className="assistantHead">
            <b>{tr("assistant")}</b>
            <button onClick={() => setAssistantOpen(false)}>×</button>
          </div>
          <div className="assistantContext">
            {context
              ? `${workspaceName} · Context: ${context.focus.title}`
              : `${workspaceName} · server-verified workspace context`}
          </div>
          <div className="assistantMessages">
            {messages.length === 0 && (
              <div className="assistantWelcome">
                <p>Ask about your tasks or safely propose a change.</p>
                <button onClick={() => askAI("Co dnes hoří?")} disabled={aiBusy}>
                  {tr("todayBrief")}
                </button>
                <small>Writes always require confirmation.</small>
              </div>
            )}
            {messages.map((m, i) => (
              <div key={i} className={"assistantTurn " + m.role}>
                <div className={"msg " + m.role}>{m.content}</div>
                {m.proposal && (
                  <div className={`aiProposal ${m.resolved ? "resolved" : ""}`}>
                    <strong>{m.proposal.summary}</strong>
                    <dl>
                      {m.proposal.changes.map((change) => (
                        <div key={`${change.label}:${change.value}`}>
                          <dt>{change.label}</dt>
                          <dd>{change.value}</dd>
                        </div>
                      ))}
                    </dl>
                    {!m.resolved && (
                      <div className="aiProposalActions">
                        <button
                          className="primaryAction"
                          disabled={aiBusy}
                          onClick={() => resolveAIProposal(m.proposal!.id, "confirm")}
                        >
                          {tr("confirm")}
                        </button>
                        <button
                          disabled={aiBusy}
                          onClick={() => resolveAIProposal(m.proposal!.id, "cancel")}
                        >
                          {tr("cancel")}
                        </button>
                      </div>
                    )}
                  </div>
                )}
                {m.actionId && !m.resolved && (
                  <button className="aiUndo" disabled={aiBusy} onClick={() => undoAIAction(m.actionId!)}>
                    {tr("undoAi")}
                  </button>
                )}
              </div>
            ))}
            {aiBusy && <p className="assistantThinking">{tr("working")}</p>}
          </div>
          <div className="assistantComposer">
            <input
              value={aiText}
              onChange={(e) => setAiText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") askAI();
              }}
              placeholder={`${tr("askAi")}…`}
              disabled={aiBusy}
            />
            <button onClick={() => askAI()} disabled={aiBusy || !aiText.trim()}>{tr("send")}</button>
          </div>
        </div>
      )}
      {undo && (
        <div className="undo">
          {tr("itemChanged")} <button onClick={restore}>{tr("undo")}</button>
        </div>
      )}
    </main>
  );
}
