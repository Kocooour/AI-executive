/** R3-FE-2b: typed cs/en copy for the server My Plan (owner decision
 * 2026-11-09: English version). The Czech values are the original R3-FE-2
 * strings, moved verbatim. Both tables must keep identical key sets (tested).
 * English is calm and short, with no technical ids or status codes, and an
 * uncertain outcome never claims success or failure. */
export type MyPlanLanguage="cs"|"en";

type Reasons=Record<
  "signed-out"|"stale"|"unavailable"|"invalid-response"|"invalid-request"|"offline"|"aborted",string>;
type WhenReasons=Reasons&Record<"unchanged",string>;

export type MyPlanCopy={
  locale:string;
  statusReasons:Reasons;
  whenReasons:WhenReasons;
  readReasons:Reasons;
  dayEmpty:string;
  dayUndated:string;
  areaPrivate:string;
  areaShared:string;
  attentionSince:(date:string)=>string;
  dueOn:(date:string)=>string;
  plannedOn:(date:string)=>string;
  completeTask:(title:string)=>string;
  whenGroup:(title:string)=>string;
  whenTodayAria:(title:string)=>string;
  whenTomorrowAria:(title:string)=>string;
  whenToday:string;
  whenTomorrow:string;
  regionLabel:string;
  eyebrow:string;
  heading:string;
  headerWhen:string;
  headerStatus:string;
  headerReadOnly:string;
  toolbarDay:string;
  toolbarWork:string;
  filterAll:string;
  filterPersonal:string;
  filterShared:string;
  currentDay:string;
  refresh:string;
  loading:string;
  whenPending:string;
  whenChecking:string;
  statusPending:string;
  statusChecking:string;
  completedReadFailed:string;
  completedReloadButton:string;
  whenReadFailed:string;
  whenReloadButton:string;
  whenUncertainRead:string;
  whenUncertainReadButton:string;
  statusUncertainRead:string;
  statusUncertainReadButton:string;
  whenUncertain:string;
  whenUncertainButton:string;
  whenConfirmed:(date:string|null)=>string;
  newChangeNotMade:string;
  whenKept:string;
  whenUndo:string;
  statusUncertain:string;
  statusUncertainButton:string;
  completedConfirmed:string;
  restoredConfirmed:string;
  statusKept:string;
  statusUndo:string;
  dayTodayAndEarlier:string;
  dayUpToSelected:string;
  dayTomorrowPrefix:string;
  dayNextPrefix:string;
  moreBusy:string;
  more:string;
  scopeWhen:string;
  scopeStatus:string;
  scopeReadOnly:string;
  scopeServer:string;
  gateChecking:string;
  gateFeatureOff:string;
  gateRefused:string;
};

const cs:MyPlanCopy={
  locale:"cs-CZ",
  statusReasons:{
    "signed-out":"Přístup k zápisu zanikl. Znovu se přihlaste.",
    "stale":"Úkol byl změněn jiným zápisem. Načetl se aktuální přehled.",
    "unavailable":"Ukládání změn nyní není dostupné nebo je vypnuté.",
    "invalid-response":"Odpověď serveru při ukládání se nepodařilo bezpečně ověřit.",
    "invalid-request":"Neplatné parametry zápisu; úkol nebyl potvrzen.",
    "offline":"Připojení selhalo. Neproběhl žádný automatický opakovaný zápis.",
    "aborted":"Operace byla přerušena. Aktuální stav je třeba znovu ověřit.",
  },
  whenReasons:{
    "signed-out":"Přístup k osobnímu plánu zanikl. Přihlaste se znovu.",
    "stale":"Osobní plán nebo úkol se mezitím změnil. Načetl se aktuální přehled.",
    "unavailable":"Osobní plánování nyní není dostupné nebo je vypnuté.",
    "invalid-response":"Odpověď serveru se nepodařilo bezpečně ověřit.",
    "invalid-request":"Požadavek na plánování není platný.",
    "offline":"Spojení selhalo; žádný automatický zápis se neopakuje.",
    "aborted":"Požadavek byl přerušen; stav je nutné znovu ověřit.",
    "unchanged":"Zvolený osobní den už je nastavený.",
  },
  readReasons:{
    "signed-out":"Přihlášení není platné. Přehled byl skryt; přihlaste se znovu.",
    "stale":"Data nebo oprávnění se změnily. Přehled byl skryt; obnovte jej.",
    "unavailable":"Můj plán nyní není dostupný nebo je vypnutý.",
    "offline":"Připojení se nezdařilo. Žádné úkoly nebyly změněny.",
    "invalid-response":"Odpověď serveru se nepodařilo bezpečně ověřit; údaje nejsou zobrazeny.",
    "invalid-request":"Neplatné datum nebo parametry požadavku.",
    "aborted":"Načítání bylo přerušeno.",
  },
  dayEmpty:"Žádné úkoly v tomto dni.",
  dayUndated:"Bez data",
  areaPrivate:"Soukromá oblast",
  areaShared:"Sdílená oblast",
  attentionSince:date=>"Vyžaduje pozornost od "+date,
  dueOn:date=>"Termín: "+date,
  plannedOn:date=>"Naplánováno: "+date,
  completeTask:title=>"Dokončit úkol: "+title,
  whenGroup:title=>"Osobní plán pro úkol: "+title,
  whenTodayAria:title=>"Naplánovat osobně na dnešek: "+title,
  whenTomorrowAria:title=>"Naplánovat osobně na zítřek: "+title,
  whenToday:"Kdy: Dnes",
  whenTomorrow:"Kdy: Zítra",
  regionLabel:"Serverový Můj plán",
  eyebrow:"Lumi · osobní plán",
  heading:"Můj plán",
  headerWhen:"Změny osobního plánu se vždy bezpečně ověřují. Bez automatického ukládání při výpadku připojení a beze změn společných termínů.",
  headerStatus:"Dokončení a vrácení změny se ověřují na serveru. Kalendářové události ani ukládání bez připojení zde nejsou dostupné.",
  headerReadOnly:"Tento přehled slouží jen ke čtení. Bez úprav úkolů, kalendářových událostí a ukládání bez připojení.",
  toolbarDay:"Den",
  toolbarWork:"Moje práce",
  filterAll:"Osobní i přiřazené sdílené",
  filterPersonal:"Osobní",
  filterShared:"Přiřazené sdílené",
  currentDay:"Aktuální den",
  refresh:"Obnovit",
  loading:"Načítám aktuální přehled…",
  whenPending:"Ověřuji osobní plán a ukládám změnu…",
  whenChecking:"Kontroluji původní potvrzení plánování…",
  statusPending:"Ověřuji oprávnění a ukládám změnu…",
  statusChecking:"Ověřuji potvrzení předchozí operace…",
  completedReadFailed:"Dokončení je potvrzené. Načtení přehledu selhalo; po novém ověření oprávnění bude možné Undo.",
  completedReloadButton:"Znovu načíst přehled (Undo zůstane)",
  whenReadFailed:"Osobní plán je potvrzený, ale načtení přehledu selhalo. Undo bude dostupné po novém ověření oprávnění.",
  whenReloadButton:"Znovu načíst osobní plán (Undo zůstane)",
  whenUncertainRead:"Výsledek osobního plánování je nejistý. Znovu se načte pouze autorizovaný přehled, nikoli zápis.",
  whenUncertainReadButton:"Znovu ověřit osobní přehled (bez zápisu)",
  statusUncertainRead:"Výsledek předchozího zápisu není potvrzen. Obnovení přehledu provede pouze nové autorizované čtení, nikdy další zápis.",
  statusUncertainReadButton:"Znovu ověřit přehled (bez zápisu)",
  whenUncertain:"Předchozí změna osobního plánu nebyla potvrzena. Další změny jsou zablokované a původní požadavek se znovu neodešle.",
  whenUncertainButton:"Ověřit původní osobní potvrzení",
  whenConfirmed:date=>"Osobní plán potvrzen: "+(date??"bez plánovaného dne")+".",
  newChangeNotMade:"Nová změna nebyla provedena:",
  whenKept:"Předchozí plán zůstává potvrzený.",
  whenUndo:"Vrátit osobní plán (Undo)",
  statusUncertain:"Výsledek zápisu není potvrzen. Žádná další změna se neodešle automaticky.",
  statusUncertainButton:"Ověřit původní potvrzení",
  completedConfirmed:"Dokončení potvrzeno.",
  restoredConfirmed:"Obnovení potvrzeno.",
  statusKept:"Předchozí dokončení zůstává potvrzené; Undo je stále dostupné.",
  statusUndo:"Vrátit dokončení (Undo)",
  dayTodayAndEarlier:"Dnes a dřívější",
  dayUpToSelected:"Do vybraného dne včetně",
  dayTomorrowPrefix:"Zítra · ",
  dayNextPrefix:"Následující den · ",
  moreBusy:"Načítám…",
  more:"Načíst další úkoly",
  scopeWhen:"Nastavení Kdy mění pouze váš osobní plán, nikoli společný termín. Každá změna se ověří vůči aktuální uložené verzi; bez automatického ukládání při výpadku připojení.",
  scopeStatus:"Dokončení a vrácení změny se ověřují proti aktuální uložené verzi. Změny se při výpadku připojení samy neodešlou. Přesun dne není dostupný.",
  scopeReadOnly:"Tento přehled slouží jen ke čtení: dokončení, přesun ani vrácení změny nejsou dostupné.",
  scopeServer:"Oprávnění se ověřují na serveru při každém načtení.",
  gateChecking:"Ověřuji přihlášení k serverovému plánu…",
  gateFeatureOff:"Serverový plán teď není zapnutý. Dosavadní údaje se zde nezobrazují.",
  gateRefused:"Server opakovaně odmítl zobrazit plán. Údaje byly skryty; ověřte přihlášení.",
};

const en:MyPlanCopy={
  locale:"en-GB",
  statusReasons:{
    "signed-out":"Your access to saving changes has ended. Please sign in again.",
    "stale":"The task was changed elsewhere. The latest plan has been loaded.",
    "unavailable":"Saving changes is not available right now or has been turned off.",
    "invalid-response":"The server's reply could not be safely verified.",
    "invalid-request":"The change was not valid, so the task was not confirmed.",
    "offline":"The connection failed. Nothing was retried automatically.",
    "aborted":"The action was interrupted. The current state needs to be checked again.",
  },
  whenReasons:{
    "signed-out":"Your access to your personal plan has ended. Please sign in again.",
    "stale":"Your personal plan or the task changed in the meantime. The latest plan has been loaded.",
    "unavailable":"Personal planning is not available right now or has been turned off.",
    "invalid-response":"The server's reply could not be safely verified.",
    "invalid-request":"The planning request was not valid.",
    "offline":"The connection failed; nothing is retried automatically.",
    "aborted":"The request was interrupted; the state needs to be checked again.",
    "unchanged":"That day is already set in your personal plan.",
  },
  readReasons:{
    "signed-out":"You are no longer signed in. The plan was hidden; please sign in again.",
    "stale":"Data or permissions changed. The plan was hidden; please refresh it.",
    "unavailable":"The plan is not available right now.",
    "offline":"The connection failed. No tasks were changed.",
    "invalid-response":"The reply could not be safely verified, so nothing is shown.",
    "invalid-request":"The date or request was not valid.",
    "aborted":"Loading was interrupted.",
  },
  dayEmpty:"No tasks on this day.",
  dayUndated:"Undated",
  areaPrivate:"Private area",
  areaShared:"Shared area",
  attentionSince:date=>"Needs attention since "+date,
  dueOn:date=>"Due: "+date,
  plannedOn:date=>"Planned: "+date,
  completeTask:title=>"Complete task: "+title,
  whenGroup:title=>"Personal plan for task: "+title,
  whenTodayAria:title=>"Plan for me today: "+title,
  whenTomorrowAria:title=>"Plan for me tomorrow: "+title,
  whenToday:"When: Today",
  whenTomorrow:"When: Tomorrow",
  regionLabel:"My Plan from the server",
  eyebrow:"Lumi · personal plan",
  heading:"My Plan",
  headerWhen:"Changes to your personal plan are verified against the latest saved version. Nothing is sent automatically while offline, and shared due dates stay unchanged.",
  headerStatus:"Completion and Undo are verified on the server. Calendar events, moving days and offline saving are not available.",
  headerReadOnly:"Read-only preview. Tasks only; no editing, calendar events or offline storage.",
  toolbarDay:"Day",
  toolbarWork:"My work",
  filterAll:"Personal and assigned shared",
  filterPersonal:"Personal",
  filterShared:"Assigned shared",
  currentDay:"Current day",
  refresh:"Refresh",
  loading:"Loading the latest plan…",
  whenPending:"Checking your personal plan and saving the change…",
  whenChecking:"Checking the earlier planning confirmation…",
  statusPending:"Checking permissions and saving the change…",
  statusChecking:"Checking the confirmation of the earlier action…",
  completedReadFailed:"The completion is confirmed. Loading the plan failed; Undo will be available once your access is checked again.",
  completedReloadButton:"Reload plan (Undo stays)",
  whenReadFailed:"Your personal plan is confirmed, but loading the plan failed. Undo will be available once your access is checked again.",
  whenReloadButton:"Reload personal plan (Undo stays)",
  whenUncertainRead:"The result of the personal planning is not certain yet. Only the authorized plan will be reloaded, not the change.",
  whenUncertainReadButton:"Check personal plan again (no change)",
  statusUncertainRead:"The result of the earlier change is not confirmed. Refreshing only reads the plan again and never repeats the change.",
  statusUncertainReadButton:"Check plan again (no change)",
  whenUncertain:"The earlier personal change is not confirmed. Further changes are blocked, and nothing is sent again.",
  whenUncertainButton:"Check the original personal confirmation",
  whenConfirmed:date=>"Personal plan confirmed: "+(date??"no planned day")+".",
  newChangeNotMade:"The new change was not made:",
  whenKept:"The previous plan stays confirmed.",
  whenUndo:"Undo personal plan",
  statusUncertain:"The result of the change is not confirmed. No further change will be sent automatically.",
  statusUncertainButton:"Check the original confirmation",
  completedConfirmed:"Completion confirmed.",
  restoredConfirmed:"Reopening confirmed.",
  statusKept:"The earlier completion stays confirmed; Undo is still available.",
  statusUndo:"Undo completion",
  dayTodayAndEarlier:"Today and earlier",
  dayUpToSelected:"Up to the selected day",
  dayTomorrowPrefix:"Tomorrow · ",
  dayNextPrefix:"Next day · ",
  moreBusy:"Loading…",
  more:"Load more tasks",
  scopeWhen:"Changing When only affects your own plan, never the shared due date. Every change is checked against the latest saved version; there is no offline queue.",
  scopeStatus:"Completing and Undo are checked against the latest saved version rather than synced offline. Moving a day stays off.",
  scopeReadOnly:"This preview is read-only: completing, moving and Undo are not turned on.",
  scopeServer:"Permissions are checked on the server every time the plan loads.",
  gateChecking:"Checking your sign-in for the server plan…",
  gateFeatureOff:"The plan from the server is not turned on right now. Earlier data is not shown here.",
  gateRefused:"The server repeatedly refused to show the plan. Data was hidden; please verify your sign-in.",
};

export const myPlanCopy:Record<MyPlanLanguage,MyPlanCopy>={cs,en};
