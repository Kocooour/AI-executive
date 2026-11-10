/** R3-FE-3: typed cs/en copy for the global reading-scope switcher and the
 * server-backed Projects / Notes lists. Both tables must keep identical key
 * sets (tested). Calm wording: no counts, no technical ids or status codes,
 * and "All" is never described as "My plan". */
export type ScopesLanguage="cs"|"en";
type FailureReasons=Record<
  "signed-out"|"stale"|"unavailable"|"invalid-response"|"invalid-request"|"offline"|"aborted",string>;

export type ScopesCopy={
  locale:string;
  groupLabel:string;
  all:string;
  personal:string;
  shared:string;
  /** Screen-reader hints per screen: lists describe what you may read, the plan only YOUR work. */
  listHints:Record<"all"|"personal"|"shared",string>;
  planHints:Record<"all"|"personal"|"shared",string>;
  projectsRegion:string;
  notesRegion:string;
  projectsEmpty:string;
  notesEmpty:string;
  groupPersonal:string;
  groupShared:string;
  loading:string;
  loaded:string;
  hidden:string;
  reload:string;
  loadMore:string;
  loadingMore:string;
  readOnlyNote:string;
  openDetailNote:string;
  notesTitleOnlyNote:string;
  gateChecking:string;
  gateFeatureOff:string;
  gateRefused:string;
  reasons:FailureReasons;
};

export const scopesCopy:Record<ScopesLanguage,ScopesCopy>={
  cs:{
    locale:"cs-CZ",
    groupLabel:"Rozsah zobrazení",
    all:"Vše",
    personal:"Osobní",
    shared:"Sdílené",
    listHints:{
      all:"Vše, co smíte číst, z osobních i sdílených Oblastí",
      personal:"Jen vaše osobní Oblasti",
      shared:"Jen sdílené Oblasti, do kterých máte přístup",
    },
    planHints:{
      all:"Veškerá vaše práce: vaše soukromé úkoly a sdílené úkoly přiřazené vám",
      personal:"Jen vaše práce v osobních Oblastech",
      shared:"Jen sdílené úkoly přiřazené vám",
    },
    projectsRegion:"Projekty",
    notesRegion:"Poznámky",
    projectsEmpty:"V tomto rozsahu nejsou žádné projekty.",
    notesEmpty:"V tomto rozsahu nejsou žádné poznámky.",
    groupPersonal:"Osobní Oblast",
    groupShared:"Sdílená Oblast",
    loading:"Načítám ze serveru…",
    loaded:"Seznam je načtený.",
    hidden:"Dřívější výsledky byly skryty. Načtěte je znovu.",
    reload:"Znovu ověřit a načíst",
    loadMore:"Načíst další",
    loadingMore:"Načítám další…",
    openDetailNote:"Výběrem položky otevřete detail.",
    readOnlyNote:"Seznam je zatím jen ke čtení. Otevření detailu projektu a úpravy přijdou v další verzi.",
    notesTitleOnlyNote:"Poznámky zobrazují jen názvy. Seznam je zatím jen ke čtení; otevření poznámky přijde v další verzi.",
    gateChecking:"Ověřuji přihlášení k serveru…",
    gateFeatureOff:"Serverový přehled teď není zapnutý. Dosavadní údaje se zde nezobrazují.",
    gateRefused:"Server opakovaně odmítl zobrazit přehled. Údaje byly skryty; ověřte přihlášení.",
    reasons:{
      "signed-out":"Přihlášení nebo přístup zanikl. Dřívější údaje byly skryty.",
      "stale":"Obsah nebo oprávnění se změnily. Načtěte přehled znovu.",
      "unavailable":"Služba teď není dostupná. Zkuste to za chvíli.",
      "invalid-response":"Odpověď serveru nebylo možné bezpečně zobrazit.",
      "invalid-request":"Požadavek nebylo možné odeslat. Zkuste to znovu.",
      "offline":"Připojení selhalo. Dřívější údaje nejsou zobrazeny.",
      "aborted":"Načítání bylo přerušeno. Načtěte přehled znovu.",
    },
  },
  en:{
    locale:"en-GB",
    groupLabel:"Reading scope",
    all:"All",
    personal:"Personal",
    shared:"Shared",
    listHints:{
      all:"Everything you may read, from personal and shared Areas",
      personal:"Only your personal Areas",
      shared:"Only the shared Areas you can access",
    },
    planHints:{
      all:"All of your work: your private tasks and the shared tasks assigned to you",
      personal:"Only your work in personal Areas",
      shared:"Only the shared tasks assigned to you",
    },
    projectsRegion:"Projects",
    notesRegion:"Notes",
    projectsEmpty:"There are no projects in this scope.",
    notesEmpty:"There are no notes in this scope.",
    groupPersonal:"Personal Area",
    groupShared:"Shared Area",
    loading:"Loading from the server…",
    loaded:"The list is loaded.",
    hidden:"Earlier results were hidden. Load them again.",
    reload:"Verify and load again",
    loadMore:"Load more",
    loadingMore:"Loading more…",
    openDetailNote:"Select an item to open its details.",
    readOnlyNote:"This list is read-only for now. Opening a project and editing will arrive in a later version.",
    notesTitleOnlyNote:"Notes show titles only. This list is read-only for now; opening a note will arrive in a later version.",
    gateChecking:"Checking your sign-in with the server…",
    gateFeatureOff:"The server overview is not turned on right now. Earlier data is not shown here.",
    gateRefused:"The server repeatedly refused to show the overview. Data was hidden; please verify your sign-in.",
    reasons:{
      "signed-out":"Your sign-in or access ended. Earlier data was hidden.",
      "stale":"Content or permissions changed. Load the overview again.",
      "unavailable":"The service is not available right now. Please try again shortly.",
      "invalid-response":"The server response could not be shown safely.",
      "invalid-request":"The request could not be sent. Please try again.",
      "offline":"The connection failed. Earlier data is not shown.",
      "aborted":"Loading was interrupted. Load the overview again.",
    },
  },
};
