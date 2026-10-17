# Lumi — produktové zadání

> **Závazný dokument pro produktové chování a priority.** Stav k 14. 10. 2026. [Rozcestník](../README.md) · [UX/UI](UX-UI.md) · [Architektura](ARCHITECTURE.md). Níže jsou zachované a uspořádané původní produktové kontrakty; cílové požadavky nejsou automaticky implementované funkce.

## Jak tento dokument používat

- **PRODUCT.md** rozhoduje o tom, *co* má Lumi dělat a *proč*; **UX-UI.md** o uživatelském ovládání; **ARCHITECTURE.md** o bezpečné technické realizaci.
- Níže zavedené identifikátory `LUMI-FR-xxx` jsou stabilní odkazy na funkční oblasti, nikoli nové změny chování. Detailní zdrojová pravidla a akceptační scénáře zůstávají závazné v původním rozsahu.
- Priorita obrazovky v UX specifikaci nepředstavuje tvrzení, že je již vyvinuta. P0/P1/P2 vyjadřují pořadí cílového dodání.
- Explicitní oddělení **Personal** a **Shared**, důvěryhodnost tvrzení a schválení účinků mají přednost před pohodlím automatizace.
- Stav ve funkčním registru níže je **pouze orientační**. Pro rozlišení skutečně implementovaných funkcí od cílových požadavků jsou závazné části [Current MVP](ARCHITECTURE.md#current-mvp), [PACT implementation status](ARCHITECTURE.md#pact-implementation-status) a [Shipped foundation and phased delivery](#shipped-foundation-and-phased-delivery).

## Registr funkčních požadavků

| ID | Funkční oblast a minimální produktový závazek | Stav (orientační přehled) | Vazba na UX |
|---|---|---|---|
| **LUMI-FR-001** | Remember: kanonické úkoly/projekty/oblasti/poznámky/vztahy, historie a jednoznačné workspaces | Existující základ; širší Graph v2 je cíl | [Projekt](UX-UI.md#ux-přehled), Inbox, Notes |
| **LUMI-FR-002** | Quick Capture, Inbox, bezpečné třídění návrhů a kontextových výtažků | Částečně dodáno, cílová interakce rozšířena | Inbox, mobile capture |
| **LUMI-FR-003** | Attention: vysvětlitelné signály, stabilní pořadí, snooze/dismiss, životní cyklus | Částečně dodáno; kalendářová rizika zůstávají cíl | Home, oznámení |
| **LUMI-FR-004** | Plan: proveditelný plán, oddělení dostupných a neověřených časových bloků | Existuje omezené ICS plánování; cílové UX je širší | Today, Calendar |
| **LUMI-FR-005** | Act: návrh → konkrétní schválení → provedení → audit → bezpečné Undo | Základ pro úkoly existuje; externí zápisy jsou cíl | Approval desktop/mobile |
| **LUMI-FR-006** | Lumi Chat: stejné entity a oprávnění jako UI, nikoli druhý zdroj pravdy | Externí read/planning API; plný chat v aplikaci je cíl | Lumi Chat |
| **LUMI-FR-007** | Kontext a evidence: potvrzované tvrzení po tvrzení, relace a původ | Částečný Graph v2; úplná spolehlivost/export je cíl | Notes, Project detail |
| **LUMI-FR-008** | Globální hledání v přístupných datech s přiznáním chybějících konektorů | Částečně; externí soubory/e-maily jsou cíl | Global search |
| **LUMI-FR-009** | Omezená, deduplikovaná a respektující soukromí proaktivita | Základ notifikací existuje; kompletní kontrakt je cíl | Notifications |
| **LUMI-FR-010** | Mobilní a desktop PWA, offline práce, viditelné sync/freshness stavy | Existující základ; úplné UX cílové | iPhone Home, Today, Calendar |
| **LUMI-FR-011** | Ochrana hranic workspaces, zdrojů, citlivosti a oprávnění | Existující základ a rozšiřující cílové kontrakty | Všechny |
| **LUMI-FR-012** | Hlas, nové konektory a budoucí řízené akce | Cíl; není plně dodáno | Voice, Calendar, Search |

## Záměr, uživatel a hranice produktu

Lumi je **osobní asistent konkrétního člověka**: pamatuje si jeho závazky, vyhodnocuje to, čemu má věnovat pozornost, pomáhá plánovat a připravuje bezpečné kroky. Produktový úspěch není počet vytvořených karet, nýbrž méně přehlédnutých závazků a méně ručního třídění při zachované kontrole uživatele. Lumi **není** podnikový BI cockpit, systém sledování lidí ani autonomní nástroj na neodsouhlasené odesílání zpráv či kalendářové změny.

Typické scénáře: zachytit poznámku hlasem či textem; roztřídit příchozí podklady; zjistit, co nyní vyžaduje pozornost; vytvořit realistický plán dne; připravit bezpečnou změnu kalendáře či úkolu; dohledat závěr schůzky a zdroj doporučení. Mac podporuje přehledovou práci a klávesnici, iPhone rychlé zachycení, rozhodnutí a kontrolu dne.

## Měření přínosu a rozsah

Závazný výčet produktových metrik a pravidla jejich ochrany soukromí jsou uvedeny v kapitole [Shipped foundation and phased delivery](#shipped-foundation-and-phased-delivery), v odstavci začínajícím „Privacy-preserving product metrics“. Toto rozdělení dokumentace nepřidává nové metriky ani nemění jejich pravidla měření.

Do cílového rozsahu patří osobní a sdílené workspaces, PWA, kanonické úkoly, Context Graph a schvalované nástroje. Mimo počáteční rozsah patří firemní BI, povinná nativní macOS aplikace, neomezená autonomie agentů nebo povinný cloudový účet třetí strany.

---

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

## Attention contract — target requirement

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

## Proactivity and notification contract — target requirement

Accepted task/project/context changes, due-time crossings, calendar refresh/conflict, completed snooze and Inbox arrivals may trigger read-only reevaluation. Trigger handling is idempotent and coalesced by workspace, source revision and time window; it never bypasses approval to write or send. The owner configures timezone, enabled rules/channels and quiet hours. Target defaults are quiet hours 22:00–08:00 and three routine interruptive notifications per rolling 24 hours per owner. Lumi sends no scheduled morning or evening digest: Home always shows the current state (owner decision 2026-10-07). Proactive messages are tied to one attention item each. Candidate identity plus notification channel/window prevents duplicate sends across scheduler retries, restart and reconnect. A changed reason may update Home without sending again.

Quiet hours defer routine sends to the next allowed window. A controlled urgent exception is limited by default to a newly detected deadline overdue within 24 hours or a fresh same-day calendar conflict affecting an accepted block, at most one urgent send per incident and one per quiet period; it is independently disableable. “Urgent” is not inferred by a model. Explicit user-set reminders retain their separate configured behavior. When notification permission, push subscription, server, calendar or another source is missing, Lumi records delivery state and shows an in-app explanation when available; it does not claim a notification was delivered or an unavailable calendar checked. Disconnect invalidates affected calendar conclusions and prevents new exact-time alerts. Pausing proactivity suppresses automated sends and scheduled analysis until resumed, while manual Home refresh and manual capture remain available. Reconnect reevaluates once and respects existing dedup and snooze decisions.

## Trust and action contract

Every material recommendation and context claim exposes provenance (owner statement, source extraction, inference or legacy import), review state, freshness, sensitivity and workspace/scope. Unknown source, date or confidence stays unknown. Metadata-only coverage cannot substantiate unseen content; conflicting evidence becomes a reviewable proposal. A private source remains private even when a visible subject points to it. The detailed Context Graph v2 contract below governs claims, evidence, migration and export.

Reads run automatically only inside explicit permitted scopes. The server validates all structured proposals and tool permissions. The required path is **intent/trigger → minimum context → allowed tool → proposal → owner approval → execution → audit → guarded Undo**. The owner sees exact target, workspace, proposed before/after values and side effects. Proposals bind to the creating owner session, workspace, expected object/data revision and expiry; a stale, expired, already-used or different-session approval is rejected, with no partial mutation. Concurrent approvals of the same revision allow at most one successful write. Retries use idempotency keys. External sends and calendar writes require explicit approval by default and dedicated policy; a read-only scheduled agent can prepare, but not approve, its own proposal. Audit records actor, operation, target, before/after revisions, approval and outcome without copying protected content into operational logs. Undo is a new guarded compensating action, available only where side effects can be safely reversed; it refuses to overwrite a later edit, explains non-reversible sends, and never erases history.

## Shipped foundation and phased delivery

The **current MVP** below and PACT implementation status describe implemented foundations: task/workspace views, Quick Capture suggestions, Context Inbox and partial Graph v2 claims, deterministic planning, read-only ICS, approval-bound task actions, basic audit/Undo, PWA shell and reminders. They do not establish an attention-item engine, attention-led Home, universal in-app chat, full offline context editing, complete Graph v2, new account adapters or the notification controls above as shipped. The external integration API provides planning and allowlisted reads; it is not yet universal chat in the app.

1. **Foundation:** product naming, deterministic attention candidates, ranking, reasons and lifecycle as prerequisites for the attention-oriented Home/brief; Quick Capture and Inbox triage improvements; make source/freshness/pending states legible while preserving current task, workspace and sync behavior.
2. **Planning and control:** connect calendar-aware planning, global search and universal chat to the existing Context Resolver, Tool Registry and proposal boundary; validate mobile, offline, accessibility, audit and Undo.
3. **Reliable Context Graph:** complete versioned claims/evidence, review queue, conflict handling, durable history, guarded multi-step Undo/Redo, full backup/restore and portable export/import. Preserve legacy context and fail closed on unknown sensitivity mappings.
4. **Measured proactivity and adapters:** expand the foundation attention engine with scheduled/event triggers, deduplication, quiet hours, notification controls and delivery recovery; then add a selected personal calendar and approved M365/selective email sources only after authorization, privacy, backup and recovery gates. Tune usefulness rather than interruption volume.

Product non-goals: enterprise KPI/BI dashboards, employee monitoring, a second canonical store, unrestricted autonomous agents, model-controlled permissions, automatic fact confirmation, fabricated evidence, mandatory cloud/model provider, mandatory Obsidian or native wrapper, and universal account access before connector gates pass.

Privacy-preserving product metrics are activation (first captured and organized item), capture-to-triage time, brief views and acted-on/dismissed recommendations, plan acceptance and estimate feedback, proposal approval/correction/Undo, offline sync recovery and notification usefulness. Measure aggregate events without exporting content or restricted context; obtain opt-in where required. A growing notification count is not itself success.

## Testable product acceptance scenarios — target requirements

1. **Capture and recall:** On mobile while online, an owner captures an ambiguous sentence. Lumi saves an editable Inbox item in the selected workspace, labels suggestions, leaves unreviewed claims unconfirmed, and later finds the item through authorized search and its project/area relation.
2. **Attention ranking and lifecycle:** At a fixed Prague time, an overdue task, soon-due task, waiting follow-up and 14-day-idle project yield the documented reason codes and stable order. Running evaluation twice yields the same keys and no duplicate notification. Snoozing the waiting item hides it until the chosen instant; completing its task before then resolves it. Dismissing the idle project suppresses that unchanged condition; new accepted activity resolves it.
3. **Revision and concurrency:** While Home displays a deadline item, another client changes the deadline and a delayed earlier evaluation returns. The old item becomes superseded, the newer revision wins and no stale alert is sent. Two approvals of the same task revision produce one write and one explicit conflict; retrying the successful command is idempotent.
4. **Approval safety:** A proposal approved after expiry, from another session or workspace, or after its target changes is rejected without a task/calendar mutation. Its audit shows the rejected attempt. Undo of a reversible accepted change restores it only if the current revision permits it; an irreversible external send is identified before approval and never falsely offered as reversible.
5. **Workspace and evidence privacy:** A Shared viewer cannot retrieve Personal task titles, private note snippets, sensitive evidence or owner history through Home, chat, search, an attention reason, a relation or a provider bundle. Signing out or switching workspace cannot expose cached Personal content in the Shared view, including while offline. Confirming one claim does not confirm another claim or mark a task complete. A metadata-only source cannot support a body-derived fact.
6. **Offline and missing calendar:** An offline mobile capture stays visibly pending, survives app restart, and becomes canonical once with a successful sync or shows a resolvable conflict. It is not used by agents before acceptance. A disconnected/stale calendar removes exact free-block and conflict claims; the day plan still orders tasks and explains the limitation.
7. **Proactivity controls:** Routine events inside quiet hours defer, the bounded urgent exception sends at most once when enabled, pause sends nothing, and reconnect/restart does not duplicate an already delivered incident. Missing push permission is reported as undelivered.

A release meets the full Lumi target only when the user can capture, triage and find work; understand a reasoned Home brief; receive an honest plan; ask chat to prepare a change; approve it in scope; and inspect audit/Undo, including mobile/offline and restricted-workspace cases. Each roadmap phase can ship independently if its partial status is stated accurately.


---

## Sémantická znalostní paměť — varianta C (cílový požadavek)

Lumi rozšiřuje Remember o sémantickou znalostní paměť: pomáhá najít oprávněné kanonické poznámky, Context Graph, úkoly a jejich souvislosti, i když se dotaz neshoduje doslova. Jde o vrstvu vyhledání a vysvětlení, ne o druhý „mozek“ vedle Lumi.

- Kanonickou pravdou zůstávají SQLite entity, Markdown poznámky, claimy, důkazy a jejich revize. Vektorový index, embedding, skóre podobnosti, cache a importovaný text jsou vždy odvoditelné artefakty; nesmějí samy potvrdit claim, vytvořit relaci, změnit úkol ani přežít smazání či omezení zdroje.
- Výsledek sémantického hledání zřetelně rozliší ověřený claim s evidencí, doslovný odkaz nebo bezpečný wikilink a pouze sémanticky podobný kandidát. Podobnost není důkaz, autorství ani vztah.
- Každý výsledek nese typ, workspace, kanonický odkaz, provenance, čerstvost a přístupný zdroj. Pokud je kandidát vynechán kvůli oprávnění, citlivosti, neaktuálnímu indexu nebo neexistující konektivitě, Lumi to popíše bez prozrazení chráněného obsahu.
- PACT Context Resolver je jediná cesta, kterou chat, agent či případné MCP rozhraní dostane výsledky. Vyžaduje jeden explicitní workspace a stejná oprávnění, citlivost, scope, review a freshness pravidla jako UI. MCP může nabídnout jen explicitně registrované typované čtení; není to přímý přístup k SQLite, souborům, indexu ani potvrzování změn.
- Lokální embedding je preferovaný režim. BGE-M3 je kandidát k vyhodnocení na českých a smíšených datech proti předem definovaným ukazatelům relevance, latence, paměti, velikosti modelu, offline chování a riziku úniku dat; jeho volba ani kvalita se touto specifikací nepředpokládá.
- Offline režim může hledat jen v lokálně povoleném, jasně označeném snapshotu. Chybějící, čekající nebo zastaralý index nesmí vytvořit falešné tvrzení o úplnosti výsledků.

Nezavádíme PostgreSQL, pgvector ani paralelní nasazení HumanAgentWiki. Tato varianta přebírá užitečné principy — lokální sémantické vyhledání, citovatelnost, bezpečné wikilinky a obnovitelný index — uvnitř existujícího modelu Lumi a jeho bezpečnostních hranic.

### Produktové akceptační scénáře

1. Dotaz v češtině najde relevantní oprávněnou poznámku i při odlišném slovním vyjádření a umožní otevřít přesný kanonický úsek; podobný výsledek není vydáván za potvrzený fakt.
2. Restricted zdroj, jeho snippet, název, počet ani embedding se nevrátí nepovolanému workspace, agentovi, provideru ani MCP klientovi.
3. Změna, archivace, smazání, změna citlivosti nebo oprávnění zneplatní indexové položky; po reindexaci odpovídají výsledky kanonickým revizím.
4. Vypnutý/nenainstalovaný model, neúspěšná indexace nebo offline mezera vrátí transparentně omezené výsledky a funkční přesné vyhledání, nikoli vymyšlené závěry.
5. Export, záloha a obnova uchovají kanonická data a jejich provenance; index lze po obnově ověřit a znovu vytvořit, aniž by se změnil obsah či review stav.
