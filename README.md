# Lumi

**Lumi** is a proactive personal AI Executive / chief of staff. AI Executive remains the technical repository and service name.

This README is the single source of truth for Lumi's product direction, target requirements, implementation status, architecture and operations. A target requirement is not a claim that a feature has shipped. Technical routes, environment variables and identifiers such as `aifred` intentionally remain stable where changing them would risk compatibility.

Local-first Personal AI OS prototype built with Next.js, Dexie and SQLite.

## Product contract

Lumi helps one person remember commitments, see the few things needing attention, make a credible plan and act safely. It is a personal chief of staff, not an enterprise BI product, surveillance tool or generic task list. The product promise is **Remember → Attention → Plan → Act**:

| Layer | User outcome | Lumi responsibility |
|---|---|---|
| Remember | Important things are captured and findable. | Quick Capture, Inbox, tasks, projects, areas, notes, relations, reviewed context and durable history. |
| Attention | The user sees what matters now and why. | Detect deadlines, conflicts, waiting, missing next actions and idle projects; show evidence and uncertainty. |
| Plan | The next sequence is realistic. | Brief, ranked actions, capacity and calendar-aware proposals with stated data limits. |
| Act | Approved work moves forward safely. | Reviewable proposal, scoped approval, controlled execution, audit and guarded Undo. |

The canonical model remains **Tasks / Projects / Areas / Notes / Relations**. A task is the canonical execution record; a claim, note or chat message cannot silently become a task or mark it complete. People, organizations, meetings, decisions, topics and tools can be Context subjects with reviewed claims linked to canonical entities. Stable IDs, recurrence, history, deletion tombstones and sync behavior remain intact. Personal and Shared are distinct workspaces; All my work is a read-only aggregate and never a write target. Every mutation selects one explicit workspace.

Lumi's principles are calm attention over volume, one coherent assistant across chat and UI, useful initiative with controlled execution, local-first operation, and evidence before confidence. Recommendations must never imply that Lumi knows, changed, sent or scheduled something it cannot substantiate. Agents are internal reusable capabilities, not the primary user mental model.

### Experience targets

- **Home and daily brief:** Answer “What needs my attention now?” with today's commitments, calendar capacity/conflicts, overdue or at-risk work, waiting follow-ups, projects missing a next action or gone quiet, and up to five recommended actions. Show fewer or zero when no eligible actionable candidates exist; never pad the brief or invent urgency. Each item has a concrete reason, source and freshness, plus inspect, snooze or dismiss actions. Lists and counts remain available as working views rather than replacing this brief.
- **Quick Capture and Inbox:** Accept short natural-language input with Czech dates and priority tokens. Show editable suggestions for project, area, priority, effort and a calendar window before saving. Inbox triage offers clarify, schedule, delegate/wait, attach to project/area, someday, complete or discard. Context Inbox previews pasted meeting/email summaries, matches existing entities and keeps ambiguous lines literal until reviewed. Raw pasted text is not silently persisted; extracted action items remain drafts.
- **Working views:** Inbox, Today, Overdue, Upcoming, Anytime, Someday and Completed retain dates, deadline, priority, checklist, recurrence, notes, history and filters. Projects and Areas show outcome, status, next action, related notes/context and risk. A project without a next action is an attention candidate, not automatically a failed project.
- **Notes, relations and retrieval:** Markdown-oriented knowledge, typed relations, backlinks/mentions, search and claim-level review. Global search labels type, workspace and source. The target covers permitted tasks, projects, areas, notes, people/organizations, relations and, when explicitly connected and indexed, files and e-mails. Current sources remain narrower; unavailable or unindexed connectors must be disclosed. Restricted content must not appear in snippets. A wiki mention is navigation, not a confirmed semantic relation.
- **Calendar-aware planning:** Rank work using deadlines, priority, confirmed current non-sensitive importance/waiting claims, availability and measured duration. Exact free blocks require a fresh connected calendar and must avoid existing planned work. A missing or stale calendar permits task ordering but no claimed free time. Accepting a block is a revision- and overlap-checked proposal, does not rewrite the due date, and records planning feedback.
- **Universal chat:** Chat answers questions, captures input and prepares the same operations as the UI: ask what matters, plan today, move a task, create a project, or explain a blocker. It uses the minimum authorized Context Resolver bundle, one explicit workspace, the Tool Registry and the same proposal/approval boundary. Chat is neither a second data store nor an authorization bypass. Conversation history alone is not evidence of a commitment.
- **Mobile/PWA/offline:** Desktop and mobile support the same essential capture, triage and brief paths with keyboard and touch access, visible focus, semantic labels, adequate contrast and reduced motion. The installed PWA shows a truthful offline state. Capture and allowed edits may queue locally with visible pending/sync/conflict states; agents cannot consume them as confirmed context before canonical acceptance. Offline availability never implies a live calendar, push delivery or server proactivity.

### UX/UI cílového produktu — target requirement

Tato kapitola popisuje cílovou zkušenost a její ověřitelná kritéria, nikoli stav již dodaných obrazovek. P0 je nezbytný základ každodenní práce, P1 rozšiřuje plánování a kontext, P2 přidává pokročilé vstupy a proaktivitu. Priority označují pořadí dodání obrazovky; každá obrazovka musí současně dodržet pravidla přístupu, čerstvosti, schvalování a dostupnosti uvedená v této specifikaci. Produktové texty používají **Lumi**; stabilní technické názvy a integrační cesty se kvůli kompatibilitě nepřejmenovávají.

**Informační architektura a navigace.** Desktop má trvalý levý sidebar v pořadí **Home, Inbox, Today, Upcoming, Projects, Areas, Notes, Calendar, Search**. Přepínač workspace je viditelný nad navigací; „All my work“ je pouze čtecí pohled. Lumi Chat je dostupný globálním ovládacím prvkem a klávesovou zkratkou bez ztráty rozepsané práce. Méně používané filtry (Overdue, Anytime, Someday, Completed), nastavení, historie, Context review a technické Agents jsou v kontextových filtrech, sekundární navigaci nebo nastavení, ne v primárním sidebaru. Search je zároveň rychle vyvolatelný odkudkoli. Na desktopu používají Inbox, Today, Projects, Notes a Search podle potřeby **3-pane pattern**: vlevo navigace, uprostřed seznam či výsledky, vpravo detail/inspektor s původem dat, vztahy a bezpečnými akcemi. Home a Calendar mohou pro přehled použít širší hlavní plochu a kontextový pravý panel. Šířka panelů se přizpůsobí oknu; při zúžení se detail otevře jako samostatný pohled.

Na iPhonu je základní **bottom nav Home, Inbox, Today, Calendar**, s přístupem k Projects, Areas, Notes a Search přes přehled „Více“ nebo globální hledání. Quick Capture je trvale dosažitelné jedním klepnutím. Detail, filtr, návrh změny a chat používají celoplošné nebo spodní sheets s jasným zavřením a zachováním rozepsaného obsahu. Gesta nejsou jedinou cestou k akci; schválení vyžaduje zřetelné tlačítko. Mobilní návrh zachovává význam, zdroj, stav a kontrolu nad akcemi i při menším prostoru.

**Hlavní tok:** Remember zachytí úkol, poznámku, schůzku či podklad do Inboxu a propojí jej s kanonickým modelem; Attention jej vyhodnotí a stručně vysvětlí na Home; Plan nabídne pořadí práce a případný časový blok v kontextu kalendáře; Act zobrazí přesný návrh změny, vyžádá schválení a po provedení zpřístupní výsledek, audit a bezpečné Undo. Chat, hlas a notifikace jsou vstupy do téhož toku, nikoli samostatné zdroje pravdy či cesty kolem schválení. Z Home lze otevřít důkaz, upravit plán, přejít na související projekt a vrátit se bez ztráty kontextu.

| Obrazovka / role | Priorita | Acceptance criteria |
|---|---|---|
| **Home / Denní brief** — hlavní attention surface a návrh dne (Attention → Plan) | P0 | Ukáže dnešní závazky, dostupnou kapacitu jen z čerstvého kalendáře, nejvýše pět zdůvodněných doporučených akcí a další kandidáty na vyžádání. Každá karta má důvod, zdroj, čas vyhodnocení, otevření detailu a vhodné snooze/dismiss; prázdný stav nevyrábí naléhavost. Návrh dne rozlišuje potvrzené bloky od návrhů. |
| **Lumi Chat** — univerzální konverzační ovládací vrstva (Remember → Act) | P1 | Umí vyhledat a vysvětlit relevantní práci, zachytit vstup a připravit stejný návrh jako UI v explicitním workspace. Odpověď odkazuje na oprávněné zdroje a přizná nejistotu; změna se provede až po shodném schválení, chat nikdy neoznačí návrh za hotovou akci. |
| **Proposal → Approval → Action** — kontrola dopadu (Act) | P0 | Před schválením ukáže cíl, workspace, hodnoty před/po, související položky, dopad na kalendář či jiné systémy, nevratné vedlejší účinky a případné konflikty. Schválení je konkrétní; úspěch zobrazí výsledek, audit a Undo jen tam, kde je bezpečné. Expirovaný či zastaralý návrh se neprovede a nabídne nové posouzení. |
| **Calendar planning in context** — kapacita vedle práce (Plan) | P1 | Zobrazuje události, potvrzené pracovní bloky a návrhy odděleně; návrh bloku uvádí úkol, trvání, důvod, zdroj dostupnosti a konflikt. Přijetí znovu ověří revizi i překryv a nemění deadline úkolu. Při odpojeném či zastaralém kalendáři nenabízí přesný volný čas. |
| **Project detail** — strukturovaná pracovní paměť (Remember → Attention) | P0 | Ukáže výsledek/cíl, stav, další akci, úkoly, související poznámky, osoby a potvrzené vztahy, čas poslední relevantní aktivity a vysvětlená rizika. Editace má viditelné ukládání a historii; chybějící další akce je vysvětlený attention kandidát, ne automatické selhání projektu. |
| **Inbox** — rychlé zachycení a triage více typů vstupů (Remember) | P0 | Přijme krátký úkol, myšlenku, odkaz a vložený text schůzky či e-mailu jako rozlišitelné vstupy. Ukáže originál a editovatelné návrhy; uživatel může vyjasnit, naplánovat, přiřadit, označit čekání, odložit či zahodit. Extrakce sama nepotvrdí tvrzení, osobu ani úkol; čekající synchronizace je viditelná. |
| **Notes / meeting context** — souvislosti a akční body (Remember → Act) | P1 | Poznámka ke schůzce ukáže původ, datum, účastníky jen při potvrzené identitě, vztahy na projekty/úkoly a editovatelné akční body. Akční bod se stane úkolem až po vědomém převzetí; sporné či neověřené vztahy zůstávají označené a kontrolovatelné. |
| **Global search** — nalezení práce a zdrojů (Remember) | P1 | Hledá v oprávněných úkolech, projektech, poznámkách a lidech; po připojení a indexaci také v souborech a e-mailech. Výsledek uvádí typ, workspace, zdroj a datum/čerstvost; filtry umožní zúžení a otevření kontextu. Nedostupný zdroj je přiznaný a neoprávněný obsah se neobjeví ani v náhledu či počtu. |
| **iPhone Home** — kapesní brief (Attention) | P0 | První obrazovka ukáže hlavní doporučení, dnešní plán a stav dat v čitelných kartách; z každé karty vede přímá cesta na detail nebo bezpečnou akci. Bez scrollování přes rozsáhlé seznamy je dostupné Quick Capture a dnešní práce. |
| **Mobile quick capture včetně hlasu** — zachycení v pohybu (Remember) | P0 pro text, P2 pro hlas | Text je dosažitelný jedním klepnutím a zachová rozepsaný vstup. Hlasový záznam vyžaduje svolení, nabídne přepis k opravě před uložením a jasně ukáže neúspěch přepisu; bez připojení nebo oprávnění zůstává textová cesta. Ani přepis sám nevytvoří potvrzený závazek. |
| **Mobile approval** — rozhodnutí v kontextu (Act) | P0 | Sheet ukáže stejné před/po, workspace, souvislosti a vedlejší účinky jako desktop; delší dopad lze rozbalit bez ztráty kritických údajů. Schválit a odmítnout mají samostatné dostupné ovladače; konfliktní či expirovaný návrh se nedá schválit. |
| **Mobile Today** — proveditelný dnešek (Plan → Act) | P0 | Oddělí pevné závazky, přijaté bloky a navržené úkoly; ukáže odhad a důvod pořadí, pokud jsou známy. Dokončení úkolu aktualizuje kanonický stav; offline změna má viditelný stav čekání/synchronizace/konfliktu. |
| **Mobile Calendar** — plán v čase (Plan) | P1 | Denní a blízký přehled dovolí otevřít událost, úkol i návrh bloku a vrátit se do Today. Konflikty a zastaralý/odpojený zdroj jsou viditelné; přijetí bloku jde přes revizně kontrolované schválení. |
| **Proactive notifications** — návrat k podstatnému (Attention) | P2 | Oznámení sděluje stručný důvod a vede na konkrétní Home položku či návrh bez automatické akce. Respektuje oprávnění, quiet hours, limity, snooze, deduplikaci a workspace; při nedoručení Lumi netvrdí opak. Obsah na zamčené obrazovce neprozrazuje chráněný kontext; název úkolu a důvod se podle rozhodnutí vlastníka (2026-10-07) zobrazují. |
| **Voice interaction** — konverzační vstup a odpověď (Remember → Act) | P2 | Uživatel vědomě spustí poslech, vidí stav nahrávání a může jej zastavit. Přepis a rozpoznaný záměr lze před odesláním opravit; odpověď uvádí zdroje/nejistotu a návrh změny přechází na běžnou approval obrazovku. Chyba oprávnění, sítě nebo rozpoznání nabízí textovou alternativu. |

**Společné UX principy a stavy.** Attention-first řazení ukazuje důvod a doporučený další krok před úplným seznamem, ale ponechává přístup ke všem kanonickým záznamům. Explainability zahrnuje zdroj, pravidlo či důvod, nejistotu a rozdíl mezi návrhem a potvrzeným stavem. U každé upravitelné plochy jsou viditelné stavy ukládání, uloženo, čeká na synchronizaci, konflikt a chyba; u odvozených doporučení také čerstvost dat a čas vyhodnocení. Loading stav zachovává kontext a nevypadá jako potvrzený prázdný výsledek. Offline PWA umožňuje dostupné čtení a zachycení s jasným omezením živého kalendáře, agentů a doručení. Mac podporuje klávesnici, viditelný focus a předvídatelné zkratky; iPhone má dostatečně velké dotykové cíle, bezpečné oblasti a ovládání bez povinných gest. Sémantické popisky, kontrast, dynamická velikost textu, čtečka obrazovky a omezený pohyb jsou součástí acceptance kritérií všech priorit. Přepnutí workspace či odhlášení nesmí odhalit dříve zobrazená soukromá data v cache, výsledcích ani návrzích.

### Attention contract — target requirement

The attention engine produces a bounded list of explainable **attention items** from a consistent snapshot of canonical data. It is a planned product layer, not an assertion that the current Home implements these rules. Its logical record includes stable `attentionKey`, workspace, subject type/ID, rule ID/version, detection time, source IDs and source revisions, evaluated data revision, severity, reason code and human explanation, relevant date/timezone, confidence or unknown marker, current lifecycle state, snooze-until, notification state and last-evaluated time. Source details must be filtered by the viewer's authorization. An item is a derived signal, never a second task or mutable source of truth.

Detection is deterministic at a declared evaluation time and IANA timezone. The same authorized data snapshot, rule version and settings yield the same candidate set, order and reason codes. The target default rules below are configurable per owner/workspace; each change is versioned and causes reevaluation. A disabled rule produces no new candidate. Dates are compared in the owner's configured timezone, with all-day due dates ending at local day end; instants use their exact UTC value.

| Rule | Target default threshold | Reason / suppression |
|---|---|---|
| Deadline overdue | For a timed deadline, deadline instant is strictly before evaluation instant (`delta < 0`); an all-day deadline becomes overdue after the end of its local due day. | `deadline_overdue`; exclude completed/archived tasks. |
| Deadline soon | Open task with `0 <= deadline instant − evaluation instant <= 48 hours`; for all-day deadlines use the end of the local due day as the instant. | `deadline_soon`; overdue wins for the same task/deadline. |
| Project without next action | Active project has no open, actionable task for elapsed time `>= 24 hours` since entering that state. | `project_no_next_action`; omit paused/archived projects and projects with an explicit waiting state. |
| Idle project | Active project has no accepted task, project or reviewed-context activity for elapsed time `>= 14 × 24 hours`. | `project_idle`; omit paused/archived projects. A background sync or mere view does not count as activity. |
| Waiting follow-up | A confirmed waiting-on relationship or explicit waiting task has a follow-up date on or before the local evaluation date; without a date, elapsed time since confirmation is `>= 7 × 24 hours`. | `waiting_follow_up`; show who/what only if authorized, and do not infer a commitment from unreviewed text. |
| Planned day passed | Open task whose planned day (`when`) ended before the evaluation instant in the owner's timezone (owner decision 2026-10-09). | `planned_date_passed`, ranked after project hygiene so that many old planned days cannot push out other items; omit tasks that already have a deadline item, wait for someone, are blocked or are set aside for someday. A new planned day is a new occurrence. |
| Calendar conflict/capacity | Two accepted planned blocks overlap, or accepted work with known estimates exceeds fresh available time in the owner/workspace configured working interval for the local day. Target freshness is a successful refresh within 30 minutes and an active connection. Merge overlapping busy events once before subtracting from available time; unknown estimates stay unknown and cannot alone trigger `capacity_risk`. | `calendar_conflict` / `capacity_risk`; evaluate in the configured IANA timezone and suppress exact-time conclusions when calendar is stale or disconnected. |

Rank candidates by severity (overdue/conflict, due soon, waiting, project hygiene, planned day passed), then nearest relevant time, then explicit task priority, then stable `attentionKey`; ties cannot depend on database iteration order or model output. A rule may raise severity for an explicit, confirmed importance claim but cannot use rejected, stale or sensitive-ineligible claims. The brief shows at most five primary items by default and provides a way to inspect remaining candidates. Reasons include the triggering threshold and dates, not merely an opaque score. A model may summarize candidates but cannot invent, reorder invisibly or elevate an ineligible item.

Deduplication uses `(workspace, rule ID, canonical subject ID, relevant occurrence or deadline)` as the logical identity; source revision and wording changes update the same item rather than create another. Distinct recurring occurrences have distinct keys. A changed deadline supersedes the old occurrence item and may create one new item. Repeated evaluation and retries are idempotent. The lifecycle is `active`, `snoozed`, `dismissed`, `resolved` or `superseded`, with an audit trail of who/what caused transitions. Snooze hides the item until its chosen instant, then reevaluates it; it must not blindly reactivate if the condition ended. Dismissal suppresses the same condition/occurrence until its subject changes materially or a new occurrence begins. Resolution follows the underlying condition ending, including task completion or project next action; supersession follows replacement by a changed deadline, merge or rule version. A manual dismiss does not complete a task.

Every source mutation, workspace setting change, calendar refresh/disconnect or relevant context review increments or records a data revision that invalidates affected items. Recalculate incrementally or on the next bounded scheduler pass; until then show `updating`/last-evaluated information and do not present stale conclusions as current. Failed recalculation retains the prior item with an explicit stale state and never emits a fresh notification from it. Late or out-of-order evaluation results cannot overwrite a newer source revision. Deleted or inaccessible sources resolve or hide their derived item without leaking titles. Paused workspaces and globally paused proactivity stop new surfacing/notifications while preserving audit history.

### Proactivity and notification contract — target requirement

Accepted task/project/context changes, due-time crossings, calendar refresh/conflict, completed snooze and Inbox arrivals may trigger read-only reevaluation. Trigger handling is idempotent and coalesced by workspace, source revision and time window; it never bypasses approval to write or send. The owner configures timezone, enabled rules/channels and quiet hours. Target defaults are quiet hours 22:00–08:00 and three routine interruptive notifications per rolling 24 hours per owner. Lumi sends no scheduled morning or evening digest: Home always shows the current state (owner decision 2026-10-07). Proactive messages are tied to one attention item each. Candidate identity plus notification channel/window prevents duplicate sends across scheduler retries, restart and reconnect. A changed reason may update Home without sending again.

Quiet hours defer routine sends to the next allowed window. A controlled urgent exception is limited by default to a newly detected deadline overdue within 24 hours or a fresh same-day calendar conflict affecting an accepted block, at most one urgent send per incident and one per quiet period; it is independently disableable. “Urgent” is not inferred by a model. Explicit user-set reminders retain their separate configured behavior. When notification permission, push subscription, server, calendar or another source is missing, Lumi records delivery state and shows an in-app explanation when available; it does not claim a notification was delivered or an unavailable calendar checked. Disconnect invalidates affected calendar conclusions and prevents new exact-time alerts. Pausing proactivity suppresses automated sends and scheduled analysis until resumed, while manual Home refresh and manual capture remain available. Reconnect reevaluates once and respects existing dedup and snooze decisions.

### Trust and action contract

Every material recommendation and context claim exposes provenance (owner statement, source extraction, inference or legacy import), review state, freshness, sensitivity and workspace/scope. Unknown source, date or confidence stays unknown. Metadata-only coverage cannot substantiate unseen content; conflicting evidence becomes a reviewable proposal. A private source remains private even when a visible subject points to it. The detailed Context Graph v2 contract below governs claims, evidence, migration and export.

Reads run automatically only inside explicit permitted scopes. The server validates all structured proposals and tool permissions. The required path is **intent/trigger → minimum context → allowed tool → proposal → owner approval → execution → audit → guarded Undo**. The owner sees exact target, workspace, proposed before/after values and side effects. Proposals bind to the creating owner session, workspace, expected object/data revision and expiry; a stale, expired, already-used or different-session approval is rejected, with no partial mutation. Concurrent approvals of the same revision allow at most one successful write. Retries use idempotency keys. External sends and calendar writes require explicit approval by default and dedicated policy; a read-only scheduled agent can prepare, but not approve, its own proposal. Audit records actor, operation, target, before/after revisions, approval and outcome without copying protected content into operational logs. Undo is a new guarded compensating action, available only where side effects can be safely reversed; it refuses to overwrite a later edit, explains non-reversible sends, and never erases history.

### Shipped foundation and phased delivery

The **current MVP** below and PACT implementation status describe implemented foundations: task/workspace views, Quick Capture suggestions, Context Inbox and partial Graph v2 claims, deterministic planning, read-only ICS, approval-bound task actions, basic audit/Undo, PWA shell and reminders. They do not establish an attention-item engine, attention-led Home, universal in-app chat, full offline context editing, complete Graph v2, new account adapters or the notification controls above as shipped. The external integration API provides planning and allowlisted reads; it is not yet universal chat in the app.

1. **Foundation:** product naming, deterministic attention candidates, ranking, reasons and lifecycle as prerequisites for the attention-oriented Home/brief; Quick Capture and Inbox triage improvements; make source/freshness/pending states legible while preserving current task, workspace and sync behavior.
2. **Planning and control:** connect calendar-aware planning, global search and universal chat to the existing Context Resolver, Tool Registry and proposal boundary; validate mobile, offline, accessibility, audit and Undo.
3. **Reliable Context Graph:** complete versioned claims/evidence, review queue, conflict handling, durable history, guarded multi-step Undo/Redo, full backup/restore and portable export/import. Preserve legacy context and fail closed on unknown sensitivity mappings.
4. **Measured proactivity and adapters:** expand the foundation attention engine with scheduled/event triggers, deduplication, quiet hours, notification controls and delivery recovery; then add a selected personal calendar and approved M365/selective email sources only after authorization, privacy, backup and recovery gates. Tune usefulness rather than interruption volume.

Product non-goals: enterprise KPI/BI dashboards, employee monitoring, a second canonical store, unrestricted autonomous agents, model-controlled permissions, automatic fact confirmation, fabricated evidence, mandatory cloud/model provider, mandatory Obsidian or native wrapper, and universal account access before connector gates pass.

Privacy-preserving product metrics are activation (first captured and organized item), capture-to-triage time, brief views and acted-on/dismissed recommendations, plan acceptance and estimate feedback, proposal approval/correction/Undo, offline sync recovery and notification usefulness. Measure aggregate events without exporting content or restricted context; obtain opt-in where required. A growing notification count is not itself success.

### Testable product acceptance scenarios — target requirements

1. **Capture and recall:** On mobile while online, an owner captures an ambiguous sentence. Lumi saves an editable Inbox item in the selected workspace, labels suggestions, leaves unreviewed claims unconfirmed, and later finds the item through authorized search and its project/area relation.
2. **Attention ranking and lifecycle:** At a fixed Prague time, an overdue task, soon-due task, waiting follow-up and 14-day-idle project yield the documented reason codes and stable order. Running evaluation twice yields the same keys and no duplicate notification. Snoozing the waiting item hides it until the chosen instant; completing its task before then resolves it. Dismissing the idle project suppresses that unchanged condition; new accepted activity resolves it.
3. **Revision and concurrency:** While Home displays a deadline item, another client changes the deadline and a delayed earlier evaluation returns. The old item becomes superseded, the newer revision wins and no stale alert is sent. Two approvals of the same task revision produce one write and one explicit conflict; retrying the successful command is idempotent.
4. **Approval safety:** A proposal approved after expiry, from another session or workspace, or after its target changes is rejected without a task/calendar mutation. Its audit shows the rejected attempt. Undo of a reversible accepted change restores it only if the current revision permits it; an irreversible external send is identified before approval and never falsely offered as reversible.
5. **Workspace and evidence privacy:** A Shared viewer cannot retrieve Personal task titles, private note snippets, sensitive evidence or owner history through Home, chat, search, an attention reason, a relation or a provider bundle. Signing out or switching workspace cannot expose cached Personal content in the Shared view, including while offline. Confirming one claim does not confirm another claim or mark a task complete. A metadata-only source cannot support a body-derived fact.
6. **Offline and missing calendar:** An offline mobile capture stays visibly pending, survives app restart, and becomes canonical once with a successful sync or shows a resolvable conflict. It is not used by agents before acceptance. A disconnected/stale calendar removes exact free-block and conflict claims; the day plan still orders tasks and explains the limitation.
7. **Proactivity controls:** Routine events inside quiet hours defer, the bounded urgent exception sends at most once when enabled, pause sends nothing, and reconnect/restart does not duplicate an already delivered incident. Missing push permission is reported as undelivered.

A release meets the full Lumi target only when the user can capture, triage and find work; understand a reasoned Home brief; receive an honest plan; ask chat to prepare a change; approve it in scope; and inspect audit/Undo, including mobile/offline and restricted-workspace cases. Each roadmap phase can ship independently if its partial status is stated accurately.

## Run

```bash
npm install
npm run dev
```

For production, run one always-on Node.js process (the current deployment uses systemd):

```bash
npm run build
npm run start -- --hostname 127.0.0.1
```

## Current MVP

- Responsive desktop and mobile task workspace
- Inbox, Today, Overdue, Upcoming, Anytime, Someday and Completed views
- Projects, areas, notes, relations and relation-aware search/context
- Persistent Personal and Shared workspaces, scoped views, and an All my work aggregate
- Task dates, deadlines, priority, notes, checklist, recurrence and history
- Quick Capture with Czech today/tomorrow/date parsing, priority tokens and a reviewable Lumi suggestion for project, area, priority, effort and the first suitable free calendar block
- Manual Context Inbox for pasted meeting, email or Copilot summaries. It creates an in-memory preview, matches existing workspace entities, and may suggest a person waiting for a result. The owner selects an existing person or explicitly creates one, then separately saves the relationship as a protected reviewable claim. Ambiguous lines remain literal proposals. Action items remain editable drafts until reviewed in Quick Capture.
- First-class people and organizations in the Context workspace, with workspace-scoped names, duplicate warnings, revision-safe rename/archive, change history and searchable relationships to tasks and projects. Each relationship remains an independently reviewed claim; archiving a person or organization removes its claims from AI eligibility without deleting history.
- SQLite server source of truth with local IndexedDB cache and conflict-aware sync
- When the session ends on the server (it lasts seven days) the app returns to the sign-in screen and says so, instead of looking offline. The local copy and unsent changes are kept and sent after signing in again; only an explicit sign-out clears them.
- Signing out clears the browser's local copy (IndexedDB data, unsent-change markers, remembered workspace) and reloads; other open tabs follow. Unsent changes are synchronized first; if that fails the user chooses whether to discard them. Without a reachable server sign-out is refused and nothing is removed, because the session cookie cannot be cleared offline. A wipe that cannot finish is completed on the next start. The local placeholder for the Personal workspace carries timestamp 0 so it never wins a merge against the server copy. Push subscriptions and device preferences (theme, language, start view) are kept.
- Daily/manual/safety backups and tombstones for deletion sync
- Installable PWA with an offline shell. Started without a connection, a browser that has synchronized before and was not signed out shows the data it holds, marked as offline, instead of only the access screen (owner decision 2026-10-09); changes made meanwhile wait on the device. Access is checked again in the background (on connection, focus and every 15 seconds); if the server then says the session has ended, the sign-in screen replaces the app and the waiting changes are sent after signing in. A browser without such data stays on the access screen.
- The address carries the open view (`/?view=Today`; the start view has the plain address), so Back, Forward and reload keep the place. It never carries a workspace, a search text or a record id; the `?task=` id from a notification link is removed from the address once the task is open, or once a completed synchronization shows the task does not exist.
- Web Push reminders delivered by a server scheduler while the PWA is closed
- Attention notifications: one Web Push when a task deadline comes within 48 hours and one when it passes, evaluated by the server every five minutes with the same rules as Home. Tasks only, never projects. Each item is announced once; snoozed and dismissed items stay silent; nothing is sent between 22:00 and 08:00 local time (held until morning) and at most three are sent per rolling 24 hours. The first pass after enabling records what is already on Home as known instead of announcing a backlog. The message shows a short task title and the reason, including on the lock screen (owner decision 2026-10-07), and opens the task. It needs the reminders switch on and a subscribed device; the message text is Czech. Delivery is at most once per item: with no subscribed device the item is recorded as not delivered and is not sent later; delivery is tracked per subscribed device, so a device whose send failed is retried on later passes (three attempts, never at night) without notifying the devices that already received the message, and a device whose subscription has expired is dropped; a pass interrupted by a restart is not resent. An item that was snoozed is announced when the snooze ends if it had not been announced before. Items held by the daily limit are sent later while their condition lasts. Quiet hours and the daily limit are fixed values for now; the urgent exception, per-rule settings, pause, in-app delivery state and push for waiting follow-ups (shown on Home only) and calendar rules from the target contract are not implemented.
- OS-level urgent-task badges for installed iOS/iPadOS Home Screen and macOS Dock web apps
- Server-verified on-demand priorities in chat and an approval-based task action loop with audit and Undo
- Home now uses a server-evaluated Attention foundation for overdue and soon deadlines, waiting follow-ups, tasks whose planned day has passed, projects without a next action, and idle projects. The last evaluation of each workspace is kept in the browser (owner decision 2026-10-09): until the server has evaluated again, Home shows it marked as a saved copy (or as out of date when the server cannot evaluate), at most 50 items per workspace, with snooze and dismiss disabled; it is also shown, marked as offline, when the app starts without a connection; signing out removes it with the rest of the local copy. A waiting follow-up comes from an explicit waiting task (marked in the task detail with who or what it waits for and an optional follow-up date): it leaves the Inbox (owner decision 2026-10-09), is left out of the day plan, does not carry over to the next occurrence of a repeating task, and returns at the start of the follow-up date in the user's time zone, or 7 days after it was marked when there is no date; waiting-on relationships from reviewed claims are not used yet. Candidates have stable identities, deterministic ordering, explicit reasons, source revisions and evaluation freshness. The five highest-ranked items are shown first; snooze and dismiss are stored in SQLite with content-free lifecycle history, expire or resurface when the underlying condition changes, and are shared across devices. Calendar conflicts and capacity risk remain planned rules and are disclosed as unavailable rather than inferred.
- Lumi's day plan previews ranked tasks in a mobile-friendly timeline and explains why each item matters now. Ranking can use confirmed, current, non-sensitive task/project importance and waiting-party claims in addition to deadlines, priority, calendar availability and measured duration. Exact blocks require a fresh connected calendar and avoid existing planned tasks. Accepting a block uses a server-side, single-task proposal with a current-revision and overlap check, audit history and Undo; it does not change the task's due date. When the calendar is missing or stale, the plan lists tasks without claiming exact free times. Decisions and manual time changes are recorded as task planning feedback.
- Read-only private ICS calendars with normalized recurring events, busy-time merging and free-window planning
- Deterministic threat detection with Web Push fallback and a least-privilege Hermes Telegram outbox

## PACT architecture

AI Executive uses PACT (Projects, Agents, Context, Tools) as the target operating model for the Personal AI OS. PACT is an architectural layer over the existing local-first task model, not a replacement for it.

### P — Projects

Existing Areas, Projects, Tasks, Notes and Relations form the P layer and retain their IDs, workspace boundaries, recurrence, history and offline/sync behavior. Projects can reference project-scoped context, preferred agents and allowed tools. All my work remains an aggregate read view, never a write target.

### A — Agents

Agents are reusable, versioned definitions of repeatable AI work, not unrestricted chatbots. Each agent declares its purpose/instructions, permitted context scopes, tool capabilities, workspace/project scope, trigger mode, output contract and mutation/approval policy.

Initial built-ins: Executive Assistant, Inbox Processor, Project Manager, Researcher and Meeting Prep. Deterministic ranking remains a safe fallback and validation layer.

Agents never receive provider credentials or bypass authorization. Model-proposed actions always pass through the Tool Registry and policy layer.

### C — Context

Context is a first-class structured layer over the existing canonical entities, tasks and notes. The next specification is [Personal Context Graph v2](#personal-context-graph-v2--target-specification): evidence-backed claims and typed relations, claim-level review, durable revision history and an Obsidian-inspired owner workspace.

Supported PACT scopes remain me, work, family, rules, project and workspace. Scope is not a substitute for workspace authorization or sensitivity. Owner statements, imported evidence and AI inferences remain distinguishable; confirmation applies to an individual claim and never implicitly completes a task or verifies every fact about a person.

The Context Resolver builds the minimum permitted bundle for each agent run from the canonical SQLite state. It enforces workspace/project, agent/tool, sensitivity, review status and freshness before returning data. Sensitive context cannot silently cross workspace boundaries or reach external providers. Graph v2 is a planned extension of this resolver and the existing proposal -> approval -> audit -> Undo boundary, not a second assistant or an independent source of truth.

### T — Tools

Agent capabilities are exposed through a typed Tool Registry rather than direct database/provider access. Initial tools include task read/propose-create/propose-update/propose-complete, project read/search, note read/search, calendar read/find-free-time and context read.

Future adapters can add email search/draft, calendar writes, Microsoft Graph, files, web research and other services without changing agent definitions. Every tool declares input/output schemas, read/write classification, scope, audit behavior and approval policy.

### Executive Orchestrator

For each run the orchestrator resolves workspace/project, loads the agent, resolves minimum context, exposes only allowlisted tools, runs deterministic and/or model reasoning, validates structured output, executes permitted reads and converts mutations into proposals. Confirmation, audit and guarded Undo remain server-controlled.

The model is never the authority for access control or writes.

### Permission model

- READ: automatic only inside explicitly allowed scopes.
- PROPOSE: AI may prepare a mutation but cannot apply it.
- WRITE: a validated proposal is applied only after required approval.
- SEND / EXTERNAL SIDE EFFECT: explicit approval by default plus a dedicated tool policy.

Scheduled/proactive agents may perform read-only analysis automatically and create proposals. Autonomous external side effects require a separately configured policy.

### Target execution flow

    Inputs / events / schedules
              |
              v
     Executive Orchestrator
              |
       +------+------+ 
       |      |      |
     Agents Context Tools
       |      |      |
       +------+------+ 
              |
              v
     Projects / Tasks / Notes
              |
              v
     Proposal -> Approval -> Execute -> Audit -> Undo

A run can combine an Executive Assistant with active projects/tasks, relevant personal/work/project context and read-only calendar tools. It identifies risks, capacity and next actions, then proposes changes instead of silently mutating the plan.

### PACT implementation status

The server-side PACT foundation is now in place: SQLite persistence for agents, durable context, tool permissions and agent runs; a default Lumi agent (with the stable internal ID `aifred`); a workspace-scoped Context Resolver; and a typed read-only Tool Registry. Provider-assisted reasoning now receives canonical entities and non-sensitive durable context through the resolver. Mutations continue to use the existing proposal -> confirmation -> audit -> Undo boundary.

The owner UI now exposes a dedicated Agents view with Project Manager and Meeting Prep. Each manual run requires one explicit workspace, uses only the agent's declared tools and context scopes, and records a sanitized operational run without task titles or context contents. Project Manager and Meeting Prep currently return deterministic recommendations and never write data. The former Morning Planner and Evening Reviewer agents and their scheduled briefings were removed on 2026-10-07; their past runs remain in the sanitized history. Rich results are returned only to the authenticated owner session, while persisted history contains status and bounded operational metadata.

The authenticated Lumi integration API is implemented for external conversational clients. It uses a dedicated bearer token and requires one explicit workspace. The planning endpoint can return read-only answers or create approval-bound proposals. A separate read-only tools endpoint exposes only task.read, project.read, note.read, calendar.read, calendar.free_time and context.read; task.propose cannot be invoked through that endpoint. Proposal confirmation is intentionally not exposed to the external integration. Its versioned OpenAPI 3.1 schema remains at the compatibility path `docs/aifred-openapi.json`, and the running app serves it at `/api/integrations/aifred/openapi`. This is the contract for a future ChatGPT/Voice connector; it advertises only planning and allowlisted read operations. Owner-only durable context management is available through `/api/context` and the Settings UI. The owner can list, create and archive context, choose scope and sensitivity, and bind project context only to a project in the same workspace. Sensitive items remain visible to the owner UI/API but are excluded from the external `context.read` tool and provider reasoning by default. Run history records only sanitized operational summaries (kind, trigger and status), not task titles or durable context, and is visible in the owner Agents view. Next: verify the PACT integration in build/CI and complete the Context Graph v2 reliability, provenance, review and export gates below before adding new account adapters. Existing read-only ICS planning remains supported.

The first Context Graph v2 foundation is additive to `pact_context`: owner-authored, workspace-bound claims have stable revisions, independent review/freshness/sensitivity state, optional non-fabricated source/evidence metadata, idempotent transaction commands and content-bearing owner history. The Context view supports create, edit, claim-level review and archive. The resolver adds only confirmed, current, normal and non-archived claims while retaining eligible legacy PACT context. This slice does not migrate legacy context, expose context mutations to external Lumi tools, implement graph/import/export/Undo, or satisfy the full Graph v2 acceptance gates. Existing logical JSON backups still cover canonical entities and relations only; they do not yet cover PACT or Graph v2 context tables.

### Implementation roadmap

1. Verify and preserve the current PACT foundation: agents, durable context, Context Resolver, Tool Registry, tracked runs and owner-confirmed task actions.
2. Extend the existing SQLite and mutation service with claim/source schemas, revision checks, idempotent commands and transactional context history; prepare a non-destructive migration.
3. Add claim-level review, explicit evidence, conflict handling and guarded multi-step Undo/Redo. Keep task execution state separate from claim review.
4. Add the Context workspace: Markdown editing, search, dynamic graph, relation details, review queue and history in the current PWA.
5. Complete portable export/import, encrypted backup/restore and server-enforced data-boundary checks before connecting new real accounts.
6. Introduce normalized external adapters incrementally: one selected personal calendar first, then approved M365 and selective email. Preserve current ICS planning throughout.
7. Extend the Context Resolver and typed tools for evidence-backed recommendations and proposals; then expand controlled proactivity under existing approval policies.

The original PACT milestone remains the integration baseline: an Executive Assistant can read one workspace, receive a minimal resolved context bundle, inspect tasks/projects/calendar through registered tools, produce a structured recommendation and propose changes without direct database access or provider credentials. Context Graph v2 adds the acceptance gates below; they must not be described as already implemented.

### ChatGPT / Voice integration contract

External conversational clients authenticate with `Authorization: Bearer <AI_EXECUTIVE_INTEGRATION_TOKEN>`. Use a dedicated random token of at least 32 characters and never reuse the browser password, session secret, Hermes token or calendar secret. The connector must select one explicit workspace for every call; `all` is rejected.

The OpenAPI contract exposes two operations: `planWithAifred` for reasoning and approval-bound proposals, and `readAifredTool` for the allowlisted read-only Tool Registry. A proposal returned to ChatGPT is only a pending proposal; the owner must confirm it through Lumi. The integration has no confirmation, Undo, arbitrary database or provider-credential endpoint.

Before connecting an external client in production, deploy the new code, set `AI_EXECUTIVE_INTEGRATION_TOKEN` in the root-managed service environment, restart AI Executive, and verify that the OpenAPI endpoint is reachable only over the intended HTTPS/Tailscale path. Do not expose the local Node listener directly to the public Internet.

## Personal Context Graph v2 — target specification

Specification revision: 2026-10-02. This section is a product and implementation contract, not a declaration of shipped functionality. It incorporates the reviewed Lumi context prototype into the AI Executive technical foundation while preserving the application's existing architecture.

### Product and deployment boundaries

- Provide an owner-controlled knowledge workspace with an Obsidian-inspired layout, Markdown notes, backlinks, evidence, a relationship map and a review queue. No Obsidian installation, account, subscription or plugin is required.
- Reuse the existing Next.js application, server-side SQLite, authenticated APIs, Dexie cache and PACT services. Do not add a competing Python server, a second task store or an independent approval mechanism.
- Preserve the installable desktop/mobile PWA and the existing always-on self-hosted Node deployment. A Mac-local installation is an optional deployment profile; a native desktop wrapper is not required to deliver the feature.
- The owner chooses the canonical host. In self-hosted mode, data resides on that host and in explicitly permitted device caches; it is not represented as existing only on the Mac. In a Mac-local profile, remote delivery/scheduled work cannot be promised while the host is off.
- Keep the data contract and core portable across operating systems. There is no mandatory third-party synchronization service, model provider or separate graph database.
- Existing task/project/area/note IDs, workspaces, recurrence, calendar scheduling, notification behavior, tombstones and task-action approval policies remain intact.

### Current foundation versus planned work

| Area | Existing application foundation | Graph v2 requirement |
|---|---|---|
| Canonical storage | server SQLite and local Dexie entity/relation cache | versioned claims, sources, evidence and transactional context history |
| Durable context | PACT context items, scopes, provenance and normal/sensitive classification | independently reviewed claims, validity and source-level evidence |
| Owner context UI | list, create and archive in Settings | edit claims, inspect evidence, review conflicts and navigate a graph |
| Mutations | task proposals, owner confirmation, audit and guarded Undo | reusable revision-safe context commands and durable multi-step Undo/Redo |
| External API | planning and allowlisted read tools | versioned evidence-aware reads/proposals, with no external confirmation or Undo |
| Backups | logical JSON and safety backups | complete context coverage, encrypted backup option and tested round-trip restore |
| Calendar | normalized read-only ICS planning | additional adapters only after the context acceptance gates pass |

The separate Markdown Atlas pilot is migration input, not production infrastructure. Its fixed graph coordinates, entity-wide confirmation, single last-change snapshot, plain ZIP backup and uncalibrated confidence values must not be carried forward as guarantees.

### Entity, claim and evidence model

Reuse canonical task, project, area and note entities by stable ID. Add person, organization, topic, tool, meeting and decision subjects through an explicitly versioned schema or typed subject reference. Do not duplicate a task as a new independently editable commitment: a commitment refers to its canonical task, or remains a proposal until the owner creates one.

A claim records a subject, a typed predicate and exactly one target entity/reference or literal value. A relationship is a claim whose value is another subject. Entity existence, a Markdown mention and claim confirmation are distinct operations.

Required logical records:

| Record | Required information |
|---|---|
| Subject reference | stable ID, subject type, canonical entity ID when applicable, workspace, display title and revision |
| Claim | ID, revision, subject, predicate, typed value or target, review status, freshness, provenance, evidence references, validity interval and recording time |
| Review event | claim/revision, authenticated actor, decision, timestamp and any correction/reason |
| Source | workspace/account, provider, external ID, accessible URL/locator, author/role, source timestamp, ingestion timestamp, content coverage and sensitivity |
| Evidence | source ID, exact message/section locator or bounded excerpt, supported claim and whether it supports or contradicts it |
| Change event | command ID, workspace, actor, object ID, before/after revisions, operation, time and Undo/Redo linkage |

Source IDs, authors, dates and quotes are never fabricated. A missing source remains explicitly missing. A source with metadata-only coverage cannot support claims requiring its unavailable body.

Conversation titles and cached summaries are discovery signals, not biographies. A conversation about a car does not establish ownership; an assistant suggestion does not establish a user commitment. Preserve the distinction between owner statement, source extraction, inference and legacy import. Owner-authored information may be recorded as such without requiring an external citation.

Do not display invented truth probabilities or auto-merge people using an arbitrary confidence threshold. Ambiguous identity matches require review. Conflicting evidence creates a reviewable proposal rather than silently replacing an accepted claim.

### Independent state dimensions

| Dimension | Target semantics |
|---|---|
| Claim review | proposed / confirmed / rejected; confirmation means accepted by the owner |
| Freshness | current / needs_review / stale |
| Canonical task execution | existing task statuses and scheduling semantics; never overwritten by claim review |
| Decision lifecycle | pending / decided / superseded, including the selected outcome |
| PACT scope | existing me / work / family / rules / project / workspace |
| Authorization boundary | one explicit workspace; All my work is read-only aggregation |
| Sensitivity | normal / confidential / restricted in the versioned target schema |

Maintain compatibility with the current normal/sensitive API until a schema migration is deployed. Map normal to normal and sensitive to protected confidential; both confidential and restricted remain excluded from external tools/provider reasoning by default. Preserve stricter imported labels. Unknown mappings fail closed and require review. Changes to public schemas, validators and clients must ship together; documentation alone does not enable new enum values.

Reviewing a claim that a hosting decision is needed must not mark the task done or choose a hosting option. Archived context must not become active during migration. A new claim about a confirmed person still needs its own review.

Track both when a claim was valid and when the system learned it. Unknown dates remain unknown. A time view must distinguish these two meanings.

### Relations and graph semantics

Retain existing canonical relations such as belongs_to_project and belongs_to_area. Add a typed semantic predicate registry with Czech labels, permitted endpoint types, direction and inverse display where useful:

- uses — používá;
- responsible_for — odpovídá za;
- works_for — pracuje pro;
- participates_in — účastní se;
- assigned_to — přiřazeno;
- blocked_by — blokováno;
- arose_from — vzniklo z;
- related_to — souvisí s (symmetric);
- supersedes — nahrazuje.

Disambiguate legacy owns during review instead of equating ownership with responsibility. A suggested next step is not evidence for blocked_by. Keep documentary provenance in evidence records. A wiki link only creates a navigational mention; it must not silently create a confirmed semantic claim.

Every semantic relation has its own evidence, review state, freshness and temporal validity. Confirming a subject must not confirm its incident edges. Preserve the current prohibition on cross-workspace relations; multi-workspace display does not authorize cross-workspace writes or hidden-node disclosure.

### Persistence, automatic saving and history

SQLite on the selected canonical host is the source of truth. Store Markdown note content with revisions there; Markdown exports are portable editing artifacts, not a concurrent second database. Reuse or extend existing persistence and mutation services instead of duplicating them.

Each command includes an idempotency key, object ID, explicit workspace and expected revision. Validate authorization and schema, commit state plus change history in one transaction, and return the authoritative saved object/revision. A failed transaction must leave neither a partial object change nor an orphaned history entry.

- UI saves owner edits automatically after field completion, with visible saving/saved/error state. A redundant Save button is not required.
- AI edits remain proposals requiring the existing owner confirmation. Owner autosave must not bypass that boundary for AI-generated changes.
- Bind each response to the requested object, not the current selection. Handle fast switching, repeated clicks, stale responses and overlapping edits.
- No-op commands do not consume an Undo step. Retry of one command does not duplicate it.
- Extend the existing guarded Undo model with durable, workspace-scoped multi-step Undo/Redo. A reversal is a new compensating transaction; it does not erase history.
- Show what will be undone and its target. Revision conflicts must never overwrite later edits.
- Preserve task proposal expiry and session binding. Context history must not make expired task proposals executable.
- Keep content-bearing owner history protected and separate from sanitized agent-run/security logs.
- Offline edits, where allowed by sensitivity, remain explicitly pending until the canonical server accepts them. They cannot be consumed as confirmed context by agents. Scope or session changes must not leak cached data.
- Update backup, restore, tombstone, schema-version and sync handling alongside the context tables; an old client must not erase unknown new data.

### Owner workspace and interaction design

Use the current app shell. Left: areas, projects, search and navigation. Center: Markdown note, graph or review list. Right: properties, claims, evidence and history. Keep Czech labels, keyboard access and mobile layout.

Review operates on a specific claim or relationship and shows its source and proposed difference. Actions are confirm, correct, reject and defer. Bulk confirmation, if added, shows the exact set being approved.

The active review action has a filled background after successful save. Do not add checkmarks, crosses or question marks to graph bubbles. Confirmation does not change task completion.

Graph requirements:

- automatic layout for arbitrary subjects; zoom, pan, pinning and persistent layout preferences;
- views around a person/project, open commitments, and changes awaiting review;
- filters for workspace, relation type, review/freshness and time, consistent with list/search;
- directed edges with Czech labels and selectable evidence/history;
- orange for proposed, green for confirmed, red for rejected, gray for stale/archived, with explicit text state in the detail;
- an entity with several claims shows a documented summary: pending current claims take precedence over an all-confirmed appearance; no claims means neutral;
- entity type and workspace use text/shape labels instead of competing status colors;
- distinguish a rejected relationship from a rejected subject and a stale claim from a completed task.

A generic entity-level badge must never imply that every personal fact has been verified. Each successful edit offers a concrete result and Undo. Failed saves retain the draft and explain the conflict/error.

### Context Resolver and external integration

Extend the existing resolver in lib/pact.ts and registered capabilities in lib/pact-tools.ts. The browser-side relation navigator is not an authorization authority.

Every resolved bundle must obey workspace, project, agent/tool permissions, sensitivity, review and freshness before serialization. Canonical task state and confirmed eligible claims form the factual basis. If an operation explicitly asks for proposals, conflicts or stale context, return them clearly separated and labeled. Source evidence cannot be read through a claim if the source itself is forbidden.

Add versioned logical operations for context search, claim explanation and proposed context changes through the Tool Registry. Register them explicitly; do not automatically expose them through the external tools allowlist. Update docs/aifred-openapi.json and route schemas only when implementation and authorization tests are complete.

External ChatGPT/Voice and other conversational clients retain their dedicated-token, single-workspace read/propose boundary. They cannot confirm claims, invoke owner Undo/Redo, read arbitrary files or obtain provider credentials. Owner UI mutations require the owner session and existing same-origin protections.

Project Manager and Meeting Prep should cite eligible evidence, report missing/conflicting context and avoid converting inference into a commitment. Scheduled runs may prepare proposals; they do not self-approve them.

### Security, export and recovery

- Apply authorization server-side to claims, sources, evidence, attachments, history, search, exports and provider bundles. UI filters are not security boundaries.
- Keep database files, raw imports, history snapshots, credentials and backups outside static serving. Preserve production authentication, size/rate limits, origin checks and security headers.
- Render Markdown and labels as untrusted content; no unsanitized HTML or execution of source instructions.
- Treat metadata and derived summaries as potentially sensitive. Derivations inherit source restrictions unless the owner explicitly reviews a downgrade with a recorded reason.
- Keep secrets in existing protected server/OS secret storage, never in context exports or agent bundles. Localhost binding and SQLite do not by themselves provide encryption.
- Support complete versioned exports: manifest, Markdown notes, JSON subjects/claims/relations/sources, JSONL owner history and permitted attachments with checksums. Markdown alone is not a full history/graph backup.
- External Markdown editing requires import against a recorded base revision, diff preview and conflict handling; it must not silently overwrite canonical data.
- Add encrypted consistent backups covering database and attachments, key recovery instructions and a tested restore. Existing logical JSON backups are not described as encrypted.
- Define retention, archive and explicit erasure separately, including derived copies, caches, indexes, content-bearing history and expiry from older backups.
- A private note or source must remain private even if referenced by an otherwise visible subject.

### Migration and acceptance gates

**A — Reliability and canonical integration.** Preserve current data and active features; add schemas and command/history handling. Test interrupted transactions, retries, no-op edits, concurrent revisions, rapid selection changes, rename round-trips and all review statuses. Undo/Redo must survive restart and refuse conflicting reversal.

**B — Provenance and review.** Migrate current pact_context and any separately imported Atlas files using an explicit dry run, backup and ID mapping. Preserve original content, scope, sensitivity, archive/pending state and owner confirmations. Owner-origin legacy entries remain attributable owner statements, but active is not blanket confirmation of newly extracted claims. Preserve Atlas entity-wide confirmation as legacy review rather than inventing claim-by-claim approval, actor or time. Retain uncalibrated confidence only in the migration record. Flag unresolved sources and mappings; repeated import must be idempotent.

**C — Owner experience.** Add the Context view, editor, review queue, automatic graph layout and history. Verify that a new entity renders without code changes; all displayed states are correct; confirming a claim does not finish a task or confirm edges; mobile and keyboard flows work; the UI uses the server's saved values.

**D — Portability and security.** Demonstrate full export/restore with IDs, relations, evidence and history preserved. Test unauthorized writes, cross-workspace reads/links, sensitive-source access, cache/session isolation and static-file exposure. This gate is required before adding new real-account connectors; existing ICS behavior remains supported.

**E — Incremental sources and agent use.** Add one chosen personal calendar, then approved work sources and selective email. Target Gmail through its read-only API, M365 through approved delegated Microsoft Graph access and an Apple/iCloud adapter appropriate to the actual backing account. Apple Calendar may display Google or M365 data, so deduplicate by provider/account/source identity. Validate recurrence, timezone, incremental import and disconnect behavior. Metadata-only ingestion must not invent commitments from unread message bodies. Expand agent briefings only after evidence and review behavior is verified.

Acceptance tests must cover integration with existing tasks, workspaces, offline/sync, scheduler and external API—not only the graph in isolation. No live account connection, deployment migration or runtime behavior change is authorized merely by this specification.

## Persistence and backups

- SQLite lives at `.data/store.sqlite` or `$AI_EXECUTIVE_DATA_DIR/store.sqlite`.
- An existing `.data/store.json` is migrated on first access without changing entity IDs or relations and remains as a recovery copy.
- Logical JSON backups live in `.data/backups`. Settings can create and restore them; restore creates a safety backup first.
- One automatic daily backup is created before the first data change of the day.

These describe current backups. Graph v2's complete context export, encrypted recovery and history coverage are target requirements above, not claims about existing logical JSON backups.

## Push reminders

The server creates and stores its VAPID key pair in SQLite. Push subscriptions and per-device delivery claims are durable across process restarts. The scheduler runs inside the single always-on Node.js service, catches up due reminders after a restart, and is not intended for serverless scale-to-zero or multi-host deployments.

On iPhone, install the PWA from its HTTPS address first, open the installed app, then enable notifications in Settings. Explicit reminder timestamps are stored in UTC; the workday shortcut converts the configured IANA timezone and workday profile to an exact instant.

Set `VAPID_SUBJECT` to a public HTTPS app origin (recommended for Apple Push
Service) or a valid `mailto:` contact. Do not use localhost or a `.local`
address: Apple rejects those VAPID identities with `BadJwtToken`. If the value
is omitted, the server uses the first HTTPS origin from
`AI_EXECUTIVE_PASSKEY_ORIGINS` or `AI_EXECUTIVE_ALLOWED_ORIGINS`.

## Security deployment

The MVP4 security layer adds streamed request-size limits, schema validation, rate limits, same-origin checks, security headers, bounded backup retention, and a bounded operational security event log that never stores task content or credentials. The event log is best-effort diagnostics, not a transactionally complete compliance ledger.

MVP4 also introduces the persistent workspace boundary. `All my work` is an aggregate view, never a write target; each create operation resolves to one explicit workspace. Cross-workspace relations are rejected. Shared workspaces currently have an owner membership seam, but invitations and additional accounts remain disabled until multi-user identity and server-side membership authorization are implemented.

The hardened unit template at `deployment/ai-executive.service` intentionally uses a dedicated `ai-executive` account, owner-only state directory, loopback binding, an external root-managed environment file, no Linux capabilities, and systemd filesystem/device isolation. Migrate the existing data and service only during a planned maintenance window; do not install the template over the current shared `hermesadmin` service without moving `.data` and `.env` first.

Production authentication fails closed: without a valid password hash and session secret the protected APIs return `401` and sign-in returns `503`. Only local non-production development can explicitly opt out with `AI_EXECUTIVE_AUTH_ENABLED=false`. Generate a password hash without placing the password in shell history:

```bash
read -s AI_EXECUTIVE_PASSWORD
printf '%s\n' "$AI_EXECUTIVE_PASSWORD" | npm run --silent hash-password
openssl rand -base64 48
unset AI_EXECUTIVE_PASSWORD
```

Store the printed `scrypt:<salt>:<hash>` value as `AI_EXECUTIVE_PASSWORD_HASH`, the random value as `AI_EXECUTIVE_SESSION_SECRET`, and set `AI_EXECUTIVE_AUTH_ENABLED=true` in the required root-managed service environment. The colon-separated form avoids dotenv expansion; legacy dollar-separated hashes remain accepted for migration. If a proxy reconstructs a different request URL, add the exact comma-separated browser origin to `AI_EXECUTIVE_ALLOWED_ORIGINS`. Authentication protects every data, backup, notification and AI API with an opaque 7-day HttpOnly, Secure, SameSite=Strict session cookie. Sign-out clears the current browser cookie; rotate the session secret to revoke all existing sessions. Use `https://vm13861.tail412944.ts.net:8443` on iPhone. On a Mac SSH tunnel, consistently open `http://localhost:3000` (do not switch between `localhost` and `127.0.0.1`) and verify that a reload keeps the session. The plaintext tailnet IP is intentionally unsuitable for secure sign-in.

Passkeys are optional and keep password sign-in as recovery. Set `AI_EXECUTIVE_PASSKEY_ORIGINS` to an exact comma-separated allowlist such as `https://vm13861.tail412944.ts.net:8443,http://localhost:3000`. Each hostname is a separate WebAuthn RP ID; an iCloud-synced passkey is shared across devices only when they use the same HTTPS hostname. Registration requires an existing authenticated owner session, user verification, and a one-time five-minute challenge. Credentials, counters, and metadata are stored in SQLite; private keys never leave the authenticator.

## AI provider

The assistant calls server-side `/api/ai`. It reconstructs its context from the
canonical SQLite snapshot and ignores client-supplied entity data. Task writes
are stored as five-minute proposals and do not mutate data until the owner
confirms them. Confirmation is session-bound, revision-checked and idempotent;
successful changes have a guarded server-side Undo.

The deterministic local planner provides current priorities on request, task creation,
rescheduling/snoozing, completion, priority changes and project moves without
an external model. Every mutation remains a proposal with confirmation and
guarded Undo. For broader read-only answers, set
`AI_PROVIDER=hermes`, `HERMES_AI_ENABLED=true`, `HERMES_BRIDGE_URL` and
`HERMES_BRIDGE_TOKEN`, or configure `OPENAI_API_KEY` and `OPENAI_MODEL`.
Provider secrets remain server-side. The current Hermes bridge invokes the
Hermes agent CLI, so enable it only with a dedicated read-only profile; provider
output never bypasses the application's proposal/confirmation boundary.

## Removed: scheduled briefings

Scheduled morning briefs and evening reviews, their push and Telegram delivery
and the related settings were removed on 2026-10-07 by owner decision. Home is
the brief of the current state, and chat answers "what matters today" on request
from canonical data without storing or sending anything.

Existing databases keep the `executive_briefings` table and old rows untouched;
new databases no longer create it. A server that installed the Telegram adapter
should retire it during the next maintenance window:

```bash
sudo systemctl disable --now ai-executive-briefings.timer ai-executive-briefings.service
sudo rm /etc/systemd/system/ai-executive-briefings.service /etc/systemd/system/ai-executive-briefings.timer
sudo rm /etc/systemd/system/ai-executive.service.d/30-executive-briefings.conf
sudo systemctl daemon-reload
sudo systemctl restart ai-executive
```

`AI_EXECUTIVE_BRIEFING_OUTBOX_DIR` is no longer read. The adapter's script in
`/usr/local/lib/ai-executive-briefings` and its queue in
`/var/lib/ai-executive-briefings` can be deleted once any undelivered files
there have been reviewed. The server security monitor watches the service
drop-in directory, so removing the drop-in raises one expected integrity alert.

## Read-only calendar planning

MVP7 accepts a private HTTPS ICS feed for one explicit workspace. The bearer
URL is encrypted at rest and is never returned by the API, copied into normal
entities/backups, sent to AI, or included in audit records. Set a stable random
`AI_EXECUTIVE_CALENDAR_SECRET` (at least 32 characters); otherwise encryption
falls back to the session secret, and rotating that secret requires reconnecting
calendar feeds.

The fetcher pins a validated public DNS answer for each HTTPS hop, rejects
loopback/private/link-local destinations and credentials in URLs, revalidates
redirects, and bounds redirects, time, bytes, lines, events and recurrence
frequency. Parsing uses `node-ical` for TZID, RRULE, EXDATE and recurrence
overrides. Only normalized title/time/status data is kept; descriptions,
attendees and locations are discarded. Private events are stored under the
generic title “Soukromá událost”.

Calendar events remain read-only. The Calendar view merges overlapping busy
intervals and shows actual free blocks inside the configured workday; Home shows
today's fixed events and the resulting free capacity. A failed
or older-than-24-hours source is marked stale, and on-demand priorities will not
claim a free slot from stale data. The current horizon is 14 days back and 90
days forward; sources refresh at most every 30 minutes in the single always-on
Node process. Microsoft Graph can later implement the same normalized adapter
without changing the planning model.

Lumi's task suggestion endpoint is authenticated, same-origin protected and
workspace-scoped. It compares the new title with project names and earlier
related tasks, estimates effort from explicit duration or task type, and checks
the next 14 configured workdays for up to three sufficiently long free intervals. The
suggestion is advisory: Quick Capture shows every proposed field before save,
allows edits or one-click opt-out, and never blocks task creation when calendar
data or the suggestion service is unavailable. Only the confirmed values are
stored on the task; those final project and area relations become historical
evidence for future suggestions, including when the owner corrected Lumi.

The application badge counts all open tasks whose scheduled date or deadline
is overdue, today or tomorrow. Foreground sync updates it through the Badging
API and every visible Web Push carries the current canonical count for the
service worker to apply while the installed app is closed. The count is cleared
at zero. iOS requires a Home Screen installation, HTTPS, notification permission
and the system Badges toggle; macOS requires an installed web app (for Safari,
Add to Dock). The Install app settings card reports installation, permission,
Badging API support and the canonical count, and provides a one-item badge test
plus a control to restore the real count. Browsers without the Badging API
continue without an in-app badge.

## Security alerts

Rejected requests are recorded with a request ID, route, method and a keyed,
pseudonymous source identifier. The monitor raises alerts for unauthorized
write attempts, repeated authentication failures, protected-route probing and
rate-limit activation. It never sends cookies, request bodies, task content or
raw IP addresses to an alert channel.

Web Push is the fallback alert channel. Production also uses the files in
`ops/security-alerts`: AI Executive writes a narrow JSON alert to a setgid
outbox, and a hardened oneshot service running as the unprivileged `hermes`
account delivers it to the configured Telegram home channel through Hermes.
The application receives no Hermes, Telegram or bridge credential.

Install the production delivery service only from the clean, reviewed commit
you intend to deploy. Before granting `sudo`, confirm that the checkout has no
unexpected modifications and record its exact revision:

```bash
git status --short
git rev-parse HEAD
sudo ./ops/security-alerts/install.sh
```

The installer creates `/var/lib/ai-executive-security`, enables the one-minute
timer, configures the application outbox and restarts AI Executive. Verify with
`systemctl status ai-executive-security-alerts.timer` and inspect delivery
failures with `journalctl -u ai-executive-security-alerts.service`.

## Server security monitoring

The separate collector under `ops/server-security` monitors the host rather
than the application. It detects repeated SSH/sudo failures, new fail2ban bans,
stopped or failed services, new non-loopback/non-Tailscale listeners, changes
to Tailscale Serve/Funnel or UFW, bursts of firewall blocks, and integrity
changes to SSH, sudo, account and selected systemd configuration. The initial
run records a baseline and does not alert on existing ports or configuration.

The root collector has no network access and never sends log text, usernames,
raw addresses, file contents or credentials. It writes a sanitized event to a
dedicated queue that AI Executive cannot access. A separate oneshot running as
`hermes` converts only allowlisted event types into Czech Telegram messages.

Install from a clean, reviewed revision:

```bash
git diff --exit-code -- ops/server-security ops/security-alerts
git rev-parse HEAD
sudo ./ops/server-security/install.sh
```

The installer creates two one-minute timers. Check them with
`systemctl status server-security-monitor.timer server-security-alerts.timer`
and inspect failures with `journalctl -u server-security-monitor.service -u server-security-alerts.service`.
