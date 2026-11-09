/** R3-FE-4a: typed cs/en copy for authorized details opened inside the main app
 * and for the compact target project list in the sidebar. Both tables keep
 * identical key sets (tested). Calm wording: a missing, foreign or revoked
 * item is one neutral sentence; no ids, counts or status codes appear. */
export type DetailLanguage="cs"|"en";
type Failures=Record<
  "not-available"|"signed-out"|"stale"|"rate-limited"|"unavailable"|"offline"|"invalid-response",string>;

export type DetailCopy={
  locale:string;
  close:string;
  back:string;
  kindTask:string;
  kindProject:string;
  kindNote:string;
  /** Accessible name of the whole panel, given the kind label and title. */
  panelLabel:(kind:string,title:string)=>string;
  panelLabelLoading:(kind:string)=>string;
  areaPrivate:string;
  areaShared:string;
  loading:string;
  loaded:string;
  hidden:string;
  retry:string;
  failures:Failures;
  statusOpen:string;
  statusCompleted:string;
  dueOn:(date:string)=>string;
  assignedToMe:string;
  parentProject:string;
  openParentProject:(title:string)=>string;
  tasksHeading:string;
  tasksEmpty:string;
  taskOpen:(title:string)=>string;
  loadMore:string;
  loadingMore:string;
  noteBodyEmpty:string;
  readOnlyNote:string;
  sidebarProjects:string;
  sidebarProjectOpen:(title:string)=>string;
  sidebarAll:string;
  sidebarEmpty:string;
  sidebarHidden:string;
  sidebarUnavailable:string;
  rowOpenProject:(title:string)=>string;
  rowOpenNote:(title:string)=>string;
  planOpenTask:(title:string)=>string;
  /** Unified target mode: views that still show legacy data cannot be edited. */
  legacyReadOnlyNotice:string;
  /** Announced when a user action on legacy data was blocked (nothing was changed). */
  legacyWriteBlocked:string;
  dismiss:string;
};

export const detailCopy:Record<DetailLanguage,DetailCopy>={
  cs:{
    locale:"cs-CZ",
    close:"Zavřít",
    back:"← Zpět",
    kindTask:"Úkol",
    kindProject:"Projekt",
    kindNote:"Poznámka",
    panelLabel:(kind,title)=>`${kind}: ${title}`,
    panelLabelLoading:kind=>`${kind}: načítání`,
    areaPrivate:"Osobní Oblast",
    areaShared:"Sdílená Oblast",
    loading:"Ověřuji přístup a načítám obsah…",
    loaded:"Autorizovaný obsah je zobrazen.",
    hidden:"Obsah je skrytý. Po návratu se znovu ověří přístup.",
    retry:"Zkusit znovu",
    failures:{
      "not-available":"Tato položka není dostupná.",
      "signed-out":"Přístup zanikl. Obsah byl odstraněn.",
      "stale":"Oprávnění nebo položka se změnily. Obsah byl odstraněn.",
      "rate-limited":"Příliš mnoho požadavků. Zkuste to za chvíli.",
      "unavailable":"Položku se teď nepodařilo bezpečně načíst.",
      "offline":"Není dostupné připojení. Obsah byl odstraněn.",
      "invalid-response":"Odpověď neprošla kontrolou. Obsah není zobrazen.",
    },
    statusOpen:"Otevřeno",
    statusCompleted:"Dokončeno",
    dueOn:date=>`Termín: ${date}`,
    assignedToMe:"Přiřazeno mně",
    parentProject:"Projekt",
    openParentProject:title=>`Otevřít projekt ${title}`,
    tasksHeading:"Úkoly",
    tasksEmpty:"Projekt zatím nemá žádné úkoly.",
    taskOpen:title=>`Otevřít úkol ${title}`,
    loadMore:"Načíst další",
    loadingMore:"Načítám další…",
    noteBodyEmpty:"Poznámka nemá žádný text.",
    readOnlyNote:"Zobrazení je zatím jen pro čtení. Úpravy přibudou v dalším kroku.",
    sidebarProjects:"Projekty",
    sidebarProjectOpen:title=>`Otevřít projekt ${title}`,
    sidebarAll:"Všechny projekty",
    sidebarEmpty:"V tomto rozsahu nejsou žádné projekty.",
    sidebarHidden:"Projekty jsou skryté.",
    sidebarUnavailable:"Projekty se nepodařilo načíst.",
    rowOpenProject:title=>`Otevřít projekt ${title}`,
    rowOpenNote:title=>`Otevřít poznámku ${title}`,
    planOpenTask:title=>`Otevřít detail úkolu ${title}`,
    legacyWriteBlocked:"Změna nebyla provedena: dosavadní data jsou v režimu serverových dat jen pro čtení.",
    dismiss:"Skrýt",
    legacyReadOnlyNotice:"Tento pohled zatím ukazuje dosavadní data; úpravy jsou v režimu serverových dat vypnuté.",
  },
  en:{
    locale:"en-GB",
    close:"Close",
    back:"← Back",
    kindTask:"Task",
    kindProject:"Project",
    kindNote:"Note",
    panelLabel:(kind,title)=>`${kind}: ${title}`,
    panelLabelLoading:kind=>`${kind}: loading`,
    areaPrivate:"Personal Area",
    areaShared:"Shared Area",
    loading:"Checking access and loading the content…",
    loaded:"Authorized content is shown.",
    hidden:"The content is hidden. Access is checked again when you return.",
    retry:"Try again",
    failures:{
      "not-available":"This item is not available.",
      "signed-out":"Access ended. The content was removed.",
      "stale":"Permissions or the item changed. The content was removed.",
      "rate-limited":"Too many requests. Try again in a moment.",
      "unavailable":"The item could not be loaded safely right now.",
      "offline":"No connection. The content was removed.",
      "invalid-response":"The response failed validation. Nothing is shown.",
    },
    statusOpen:"Open",
    statusCompleted:"Completed",
    dueOn:date=>`Due: ${date}`,
    assignedToMe:"Assigned to me",
    parentProject:"Project",
    openParentProject:title=>`Open project ${title}`,
    tasksHeading:"Tasks",
    tasksEmpty:"This project has no tasks yet.",
    taskOpen:title=>`Open task ${title}`,
    loadMore:"Load more",
    loadingMore:"Loading more…",
    noteBodyEmpty:"This note has no text.",
    readOnlyNote:"This view is read-only for now. Editing arrives in the next step.",
    sidebarProjects:"Projects",
    sidebarProjectOpen:title=>`Open project ${title}`,
    sidebarAll:"All projects",
    sidebarEmpty:"There are no projects in this scope.",
    sidebarHidden:"Projects are hidden.",
    sidebarUnavailable:"Projects could not be loaded.",
    rowOpenProject:title=>`Open project ${title}`,
    rowOpenNote:title=>`Open note ${title}`,
    planOpenTask:title=>`Open task details for ${title}`,
    legacyWriteBlocked:"Nothing was changed: the existing data is read-only in server-data mode.",
    dismiss:"Dismiss",
    legacyReadOnlyNotice:"This view still shows the existing data; editing is switched off in server-data mode.",
  },
};
