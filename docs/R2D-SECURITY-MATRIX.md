# R2d.6 — konsolidovaná bezpečnostní matice (uživatel × Oblast × kanál)

**Stav:** staging-only, jen testy a dokumentace; produkční kód, schéma, UI ani produkční data se nemění. Test: [`tests/target-r2d-security-matrix.test.mjs`](../tests/target-r2d-security-matrix.test.mjs), v povinné bezpečnostní sadě `scripts/ci-pr-tests.mjs` (spouští se u každého citlivého PR) a ve workflow `r2d-project-reads.yml`. Pokrývá odvozené kanály uvedené níže (≥ 3 identity, osobní i sdílené Oblasti, nepřidělené a cizí úkoly, sdílený projekt bez mého přiřazení, každý globální rozsah, Můj plán jen s mou prací, konzistentní stránkování/počty/Search/Attention, nulové duplicity, postupné odebírání přístupu). **Netvrdí se tím splnění akceptace před R3**: zbývající brány jsou v sekci [Otevřené brány](#otevřené-brány-mimo-tuto-matici). Druhý soubor `tests/target-r2d-security-matrix-mutation-guards.test.mjs` (stejná sada a workflow) pokrývá stavy, které validní data nevyrobí.

## Kanonická fixture

Jedno izolované staging úložiště se syntetickými daty (legacy data adresář je hlídaný sentinelem a zůstává beze změny; na konci proběhne `r2-model` preflight všech úložišť).

| Identita | Role | Oblasti |
|---|---|---|
| `owner` | admin | vlastní soukromá Oblast, **S1** (admin), **S2** (admin) |
| `editor` | editor v S1 | vlastní soukromá Oblast, S1 |
| `viewer` | viewer v S1 | vlastní soukromá Oblast, S1 |
| `stranger` | admin vlastní **S3** | vlastní soukromá Oblast, S3; **bez přístupu** k S1 a S2 |

V každé Oblasti jsou úkoly (přidělené mně / jinému / nepřidělené), projekt s úkoly a poznámkami, hotový úkol, termíny po lhůtě / dnes / zítra, osobní plány a lifecycle řádky Attention (dismissed, snoozed). S1 obsahuje navíc projekt **bez přiřazení editora**. Každá entita má pevný token (`t_s1_03`, `n_pr_ed_01`, …), který nikdy není předponou jiného; jakýkoli serializovaný výstup se proto dá spolehlivě prohledat a očekávaná viditelnost se odvozuje z **aktuálních řádků členství a přiřazení**, nikoli z testovaného kódu. Push je zapnutý pro všechny identity (jedno zařízení každá), první průchod provede baseline a následně vzniká nová „čerstvá“ práce ve všech Oblastech, kterou teprve další průchod oznámí.

## Kanály

Kanály se čtou přes `TargetStagingSessionAuthority` (identita vždy z ověřené session, nikdy z parametru klienta) a vždy z jednoho připnutého snapshotu na volání:

| Skupina | Kanály |
|---|---|
| Osobní a časová čtení | `personal/task-page`, `personal/task-detail`, `personal/project-page`, `personal/project-detail`, `scoped/shared+my-plan`, `temporal/status`, `temporal/due-window`, `temporal/task-detail`, `shared/task-detail`, `personal-when` |
| Projekty a vztahy | `project/index`, `project/detail+tasks`, `relations/project`, `relations/backlinks` |
| Poznámky | `note/read`, `note-sync/bootstrap` (i pokračování kurzorem) |
| Globální index a hledání | `global/task`, `global/project`, `global/note`, `global/combined` (Vše/Osobní/Sdílené), `search/title` |
| Můj plán a přehledy | `my-plan/day` (dnes, nadcházející, dvoudenní), `home/summaries` |
| Attention a notifikace | `attention/list` (active/hidden, všechny filtry), `attention/command-preview`, `notifications/settings`, push průchod (sender zaznamenává příjemce → úkoly) |
| AI | `ai/context-bundle` (všechny účely a rozsahy, včetně provider serializace) |
| HTTP (default-off flagy) | `global-index`, `attention`, `attention/command` (preview), `notifications/settings`, `note-sync` |

## Invarianty a co který test dokazuje

| # | Test | Co dokazuje |
|---|---|---|
| 1 | tabulka aktér × kanál | V žádném kanálu žádného aktéra není token cizí soukromé ani nepřístupné sdílené entity, cizí osobní plán, lifecycle řádek ani zařízení; těla poznámek vydává čtení poznámky a (R2d.4j) `find` balík AI, vždy jen těm, kdo poznámku smějí číst autorizovaným čtením; těla nepřístupných poznámek se nikdy neobjeví; každý push šel na vlastní zařízení příjemce a jen pro jeho čitelnou práci. Pozitivní kontroly zajišťují, že autorizované sondy jsou skutečně zodpovězeny (žádné „vše zamítnuto“). |
| 2a | viewer čtení | Viewer čte vše sdílené (globální Sdílené, Search, projekty, poznámky, AI `find`), ale sdílená práce chybí v Můj plán, Attention, home počtech, AI `what_matters`/`plan_today` i v push; Attention preview pro sdílený úkol je odmítnut. |
| 2b | viewer a křížové zápisy | Pro **každý zapisovač** (název, stav, termín, plánované datum, Attention lifecycle, smazání úkolu, úprava/smazání/vytvoření poznámky, změna členství) je s platným CAS vstupem (vyrobeným oprávněným zapisovačem) odmítnut viewer, editor mimo svou Oblast, cizí admin, cizinec; store je po všech pokusech nezměněný (otisk **všech** tabulek ze `sqlite_master`, bez výjimek; řádky se řadí v JS, protože většina tabulek je `WITHOUT ROWID`). Navíc: člen bez přiřazení (editor na úkolu přiděleném adminovi, nepřiděleném nebo projektovém) je odmítnut v zapisovačích osobního lifecycle (Attention, plánované datum). Kontroly s legitimním editorem ověřují, že odmítnutí způsobuje ACL, ne špatný tvar příkazu. Příkazy s identitou jiného uživatele jsou `invalid_request`, nastavení i zařízení vlastníka se nezmění; read-only, odvolaný a `revokeActor` token nezapisuje. Odmítnutí existujícího cizího a neexistujícího úkolu jsou identická (žádné existenční orákulum v zapisovačích). |
| 3 | členství Můj plán / Vše / Sdílené | Můj plán = vlastní soukromé + mně přidělené sdílené (editor/admin), nikdy nepřidělené, cizí ani úkoly sdíleného projektu bez mého přiřazení; Vše = všechno autorizované včetně nepřidělených; Osobní jen soukromé; Sdílené nikdy soukromé. Funkce `checkMembership` se znovu používá po každém kroku testu 6. |
| 4 | konzistence kanálů | Pro každou identitu a rozsah: globální task/project/note = kombinovaný index = title search = autorizace odvozená z řádků; počty home souhrnů odpovídají seznamům; stránkování po malých stránkách (offset i kombinované pozice) dá přesně jednostránkový výsledek bez duplicit; Attention ⊆ Můj plán (dnes + nadcházející) ⊆ moje otevřená práce; push příjemci ⊆ aktivní Attention (a jen čerstvá práce); AI `what_matters`/`plan_today` ⊆ jejich zdroje a AI `find` = title search. |
| 5 | žádné existenční/počtové orákulum | Po přidání N řádků (úkoly všech druhů, projekty, poznámky, plány a lifecycle řádky cizích uživatelů) a skutečného provozu zapisovačů (úprava a smazání poznámky, změna stavu, nastavení, zařízení) v Oblastech **cizích** danému aktérovi zůstanou jeho výstupy napříč **všemi** kanály stejné (po serializaci) (položky, `hasMore`, počty, revize, linearizace, AI `revision`); sondovaná id nových řádků se před i po chovají stejně. Tři fáze (S2 + soukromá vlastníka; S3 + soukromá cizince; S1 + soukromé editora/viewera) pokrývají každou identitu. **Žádný kanál se při cizí aktivitě nepohybuje**, proto je množina `REVISION_MOVES_WITH_FOREIGN_ACTIVITY` prázdná; jediný záměrně nedeterministický bajt je zapečetěný `cursor` note-syncu (náhodný nonce), který se před porovnáním maskuje. |
| 6 | revokační přechody | Postupně: přeřazení úkolu pryč → dokončení → smazání poznámky → downgrade editor→viewer → odebrání člena → odhlášení všude. Po každém kroku se znovu čtou kanály dotčených aktérů proti aktuálním řádkům: obsah zmizí ze všech kanálů, Můj plán/Attention/AI neobsahují práci, která už není moje, push ji neodešle (čekající oznámení se po změně nedoručí), starý note-sync kurzor vrátí `resync_required` (změna role, odhlášení) nebo `inaccessible` (odebraný člen); smazání poznámky se dostane k oprávněným jako bezobsahový `delete`; downgradovaný i odebraný člen nezapíše žádným zapisovačem. |
| 7 | S3 ↔ S1/S2 | Sdílená Oblast cizince se nikdy neobjeví u členů S1/S2 a naopak (včetně identit členů a push). |
| 9 | AI bundle | Všech 9 platných kombinací účel × rozsah odpovídá pro každou identitu; neplatné (`what_matters/all`, `plan_today/all`, `find/my-plan`, neznámé) a malformované požadavky dávají `null`; provider JSON má přesnou množinu klíčů (jen položky `note` ve `find` smějí mít `body`/`bodyTruncated`, a to přesně podle autorizovaného čtení poznámky; žádné `witness`, `linearization`, `areaEpochs`, `noteAreaEpochs`, `areaId`, `projectId`, assignee ani userId); `plan_today/personal|shared` je podmnožinou mé práce daného druhu. |
| G1–G3 | `mutation-guards` | G1: cizí lifecycle řádek na mém úkolu nikdy neovlivní můj Attention (lifecycle, snooze, revize, hidden pohled); G2: změna během push průchodu (ztráta přístupu, dokončení, dismiss, vypnutí push) zastaví zbylé odesílání na druhé zařízení; G3: úkol přiřazený viewerovi sdílené Oblasti chybí v Můj plán, Attention, push i AI. G1 a G3 vkládají schématem nedosažitelné řádky přes dočasně zrušený jediný guard trigger (DDL se po obnovení porovná bajt po bajtu); tyto stavy kanonický preflight odmítá, proto se čtou db-level read modely a autorita musí selhat uzavřeně. |
| 8 | HTTP spot-checky | Pro každou HTTP rodinu za default-off flagy (`global-index`, `attention`, `attention/command` preview, `notifications/settings`, `note-sync`) route vrací totéž co interní kanál pro stejnou identitu (shodné položky), žádný token mimo autorizaci, jednotné 404 pro cizí i neexistující Oblast/úkol, 401 po odvolání durable session (i bez obsahu), 401 pro padělané hodnoty skutečných cookie `ai_executive_session` i `lumi_target_staging_session` (a durable token pod jménem cookie vlastníka) a 404 pro každý jednotlivý flag každé HTTP rodiny. |

## Pozorování, která matice zafixovala

- Writer členství při downgradu/odebrání sám odpřiřadí úkoly editora (`unassignedTasks`); databázový trigger odmítne přiřazení nečlenovi, takže „stale assignee“ nelze vytvořit.
- Note-sync kurzor je svázaný s rolí/politikou a epochou identity: downgrade i odhlášení vynutí `resync_required`, odebraný člen dostane `inaccessible`.
- Odmítnutí zapisovačů pro existující cizí a neexistující úkol jsou identická; odmítnutí note-syncu a Attention preview pro cizí a neexistující cíl jsou stejná.
- Membership writer při downgradu/odebrání odpřiřadí **všechny** úkoly člena v Oblasti včetně dokončených (komentář v kódu: dokončení atribuce odloženo); test to fixuje jako zdokumentované chování.
- Nalezen **žádný produkční defekt**; test proto nic nedokumentuje jako známou výjimku.

## Spuštění

```bash
node --experimental-loader ./tests/ts-loader.mjs --test tests/target-r2d-security-matrix.test.mjs tests/target-r2d-security-matrix-mutation-guards.test.mjs
```

Běh trvá zhruba 80 s (guards ~3 s) (každé čtení z autority otevírá připnutý snapshot s preflightem; sondovací smyčky jsou omezené na reprezentativní id jednotlivých Oblastí, protože ACL je rozhodováno po Oblastech).

## Zbývající brány před R3 a R4

Matice je brána R2d na stagingu pro vyjmenované kanály, **ne** souhlas s produkční aktivací ani akceptace před R3. Před R3/R4 zůstává:

1. **Živé HTTP guardy AI bundle.** Context Resolver je zatím jen interní (`resolveContextBundle`, bez provider routy). Jakmile route pro volání poskytovatele vznikne, musí před uvolněním ověřit witness bundle proti živému store (jako ostatní rodiny) a tento test se rozšíří o HTTP řádek, včetně odvolané session a změny členství mezi sestavením a odesláním.
2. **Skutečná host politika web-push** (allowlist push služeb Apple/Google/Mozilla je povinná brána R4, vlastník OK 2026-11-08, [záznam](decisions/2026-11-08-ai-telo-poznamek-a-retence.md)). Push je dnes pouze s injektovaným senderem; reálné odesílání vyžaduje allowlist hostů push služeb, SSRF/DNS politiku, šifrování a rotaci VAPID klíčů, plánovač s jedním vlastníkem a test, že odpověď `gone` revokuje cíl. Matice se pak doplní o řádek s reálným adaptérem a fake serverem.
3. **Retence auditu** (odložena na R4, [záznam](decisions/2026-11-08-ai-telo-poznamek-a-retence.md)). Audit zamítnutých a bezpečnostně významných operací, jeho retenční/exportní lifecycle a ochrana proti úniku obsahu (odmítnutí zde jsou obsahově prázdná, ale produkční retence a export auditu nejsou rozhodnuty vlastníkem).
4. **Plné Browser E2E při release.** Matice nepokrývá UI, offline fronty ani klientskou cache (R3/R4); celá sada `Browser E2E` se spouští jen na přesném SHA před nasazením podle [AGENTS.md](../AGENTS.md).
5. Nezměněné brány R4: inventura dat/zařízení/konektorů, ověřená archivní záloha a restore, samostatný souhlas vlastníka s přesným rozsahem cutoveru, nezávislé bezpečnostní review citlivých změn a žádná produkční aktivace příznaků.

## Otevřené brány (mimo tuto matici)

Matice tyto oblasti **nepokrývá**; zůstávají otevřené:

- Matice HTTP write-route včetně receipts/CSRF napříč všemi routami (existují samostatné sady po routách).
- Retry/replay a zastaralá `restoreGeneration`/politika uprostřed zápisu na úrovni matice.
- Změna členství uprostřed čtení (pinned snapshot je ověřen jinde, ne v matici).
- Offline/stará snapshot replay.
- Historie vlastníka (route auditu názvu úkolu), change feed.
- Citlivost context claims/evidence.
- Časové pásmo Attention ze serverového profilu (rozhodnuto, implementace R2d.4k; [záznam](decisions/2026-11-08-ai-telo-poznamek-a-retence.md)).
- Undo (klientské) a Inbox (zatím bez target selectoru).

## Mutační testování

Úniky, které přežily první kolo nezávislého mutačního testu, byly po tomto kole znovu aplikovány v izolovaném detached worktree (smazán po běhu):

| Mutace | Kde | Výsledek |
|---|---|---|
| M05 `ON (s.user_id=? OR 1=1)` v lifecycle LEFT JOIN | `lib/target-attention-read-model.ts` | **zabita** (G1) |
| M06 push průchod používá první stav místo re-readu před každým odesláním | `lib/target-attention-push-pass.ts` | **zabita** (G2) |
| M07 `publicPart` emituje `witness` | `lib/target-context-bundle.ts` | **zabita** (test 9, přesná množina klíčů) |
| M02 viewer připuštěn v role filtru denního výběru Můj plán | `lib/target-my-plan-day-task-read-model.ts` | **zabita** (G3) |

Přežilé mutace: žádné z těchto čtyř. Ostatní mutace prvního kola nebyly znovu spuštěny.
