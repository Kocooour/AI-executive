# R2d.6 — konsolidovaná bezpečnostní matice (uživatel × Oblast × kanál)

**Stav:** staging-only, jen testy a dokumentace; produkční kód, schéma, UI ani produkční data se nemění. Test: [`tests/target-r2d-security-matrix.test.mjs`](../tests/target-r2d-security-matrix.test.mjs), v povinné bezpečnostní sadě `scripts/ci-pr-tests.mjs` (spouští se u každého citlivého PR) a ve workflow `r2d-project-reads.yml`. Splňuje akceptaci před R3 z [ARCHITECTURE.md](ARCHITECTURE.md) (odvozené kanály, ≥ 3 identity, osobní i sdílené Oblasti, nepřidělené a cizí úkoly, sdílený projekt bez mého přiřazení, každý globální rozsah, Můj plán jen s mou prací, konzistentní stránkování/počty/Search/Attention, nulové duplicity, změna členství během čtení) a kritéria „Read/write bezpečnost“ a „Funkční úplnost“ z [ROADMAP.md](ROADMAP.md#kritéria-dokončení-r2-před-d3).

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
| 1 | tabulka aktér × kanál | V žádném kanálu žádného aktéra není token cizí soukromé ani nepřístupné sdílené entity, cizí osobní plán, lifecycle řádek ani zařízení; těla poznámek vydává jediný kanál (čtení poznámky) a jen čtenářům; každý push šel na vlastní zařízení příjemce a jen pro jeho čitelnou práci. Pozitivní kontroly zajišťují, že autorizované sondy jsou skutečně zodpovězeny (žádné „vše zamítnuto“). |
| 2a | viewer čtení | Viewer čte vše sdílené (globální Sdílené, Search, projekty, poznámky, AI `find`), ale sdílená práce chybí v Můj plán, Attention, home počtech, AI `what_matters`/`plan_today` i v push; Attention preview pro sdílený úkol je odmítnut. |
| 2b | viewer a křížové zápisy | Pro **každý zapisovač** (název, stav, termín, plánované datum, Attention lifecycle, smazání úkolu, úprava/smazání/vytvoření poznámky, změna členství) je s platným CAS vstupem (vyrobeným oprávněným zapisovačem) odmítnut viewer, editor mimo svou Oblast, cizí admin, cizinec; store je po všech pokusech bajt po bajtu nezměněný (otisk tabulek). Kontroly s legitimním editorem ověřují, že odmítnutí způsobuje ACL, ne špatný tvar příkazu. Příkazy s identitou jiného uživatele jsou `invalid_request`, nastavení i zařízení vlastníka se nezmění; read-only, odvolaný a `revokeActor` token nezapisuje. Odmítnutí existujícího cizího a neexistujícího úkolu jsou identická (žádné existenční orákulum v zapisovačích). |
| 3 | členství Můj plán / Vše / Sdílené | Můj plán = vlastní soukromé + mně přidělené sdílené (editor/admin), nikdy nepřidělené, cizí ani úkoly sdíleného projektu bez mého přiřazení; Vše = všechno autorizované včetně nepřidělených; Osobní jen soukromé; Sdílené nikdy soukromé. Funkce `checkMembership` se znovu používá po každém kroku testu 6. |
| 4 | konzistence kanálů | Pro každou identitu a rozsah: globální task/project/note = kombinovaný index = title search = autorizace odvozená z řádků; počty home souhrnů odpovídají seznamům; stránkování po malých stránkách (offset i kombinované pozice) dá přesně jednostránkový výsledek bez duplicit; Attention ⊆ Můj plán (dnes + nadcházející) ⊆ moje otevřená práce; push příjemci ⊆ aktivní Attention (a jen čerstvá práce); AI `what_matters`/`plan_today` ⊆ jejich zdroje a AI `find` = title search. |
| 5 | žádné existenční/počtové orákulum | Po přidání N řádků (úkoly všech druhů, projekty, poznámky, plány a lifecycle řádky cizích uživatelů) a skutečného provozu zapisovačů (úprava a smazání poznámky, změna stavu, nastavení, zařízení) v Oblastech **cizích** danému aktérovi zůstanou jeho výstupy napříč **všemi** kanály bajt po bajtu stejné (položky, `hasMore`, počty, revize, linearizace, AI `revision`); sondovaná id nových řádků se před i po chovají stejně. Tři fáze (S2 + soukromá vlastníka; S3 + soukromá cizince; S1 + soukromé editora/viewera) pokrývají každou identitu. **Žádný kanál se při cizí aktivitě nepohybuje**, proto je množina `REVISION_MOVES_WITH_FOREIGN_ACTIVITY` prázdná; jediný záměrně nedeterministický bajt je zapečetěný `cursor` note-syncu (náhodný nonce), který se před porovnáním maskuje. |
| 6 | revokační přechody | Postupně: přeřazení úkolu pryč → dokončení → smazání poznámky → downgrade editor→viewer → odebrání člena → odhlášení všude. Po každém kroku se znovu čtou kanály dotčených aktérů proti aktuálním řádkům: obsah zmizí ze všech kanálů, Můj plán/Attention/AI neobsahují práci, která už není moje, push ji neodešle (čekající oznámení se po změně nedoručí), starý note-sync kurzor vrátí `resync_required` (změna role, odhlášení) nebo `inaccessible` (odebraný člen); smazání poznámky se dostane k oprávněným jako bezobsahový `delete`; downgradovaný i odebraný člen nezapíše žádným zapisovačem. |
| 7 | S3 ↔ S1/S2 | Sdílená Oblast cizince se nikdy neobjeví u členů S1/S2 a naopak (včetně identit členů a push). |
| 8 | HTTP spot-checky | Pro každou HTTP rodinu za default-off flagy (`global-index`, `attention`, `attention/command` preview, `notifications/settings`, `note-sync`) route vrací totéž co interní kanál pro stejnou identitu (shodné položky), žádný token mimo autorizaci, jednotné 404 pro cizí i neexistující Oblast/úkol, 401 po odvolání durable session (i bez obsahu), 401 pro padělanou cookie a 404 při vypnutém flagu. |

## Pozorování, která matice zafixovala

- Writer členství při downgradu/odebrání sám odpřiřadí úkoly editora (`unassignedTasks`); databázový trigger odmítne přiřazení nečlenovi, takže „stale assignee“ nelze vytvořit.
- Note-sync kurzor je svázaný s rolí/politikou a epochou identity: downgrade i odhlášení vynutí `resync_required`, odebraný člen dostane `inaccessible`.
- Odmítnutí zapisovačů pro existující cizí a neexistující úkol jsou identická; odmítnutí note-syncu a Attention preview pro cizí a neexistující cíl jsou bajt po bajtu stejná.
- Nalezen **žádný produkční defekt**; test proto nic nedokumentuje jako známou výjimku.

## Spuštění

```bash
node --experimental-loader ./tests/ts-loader.mjs --test tests/target-r2d-security-matrix.test.mjs
```

Běh trvá zhruba minutu (každé čtení z autority otevírá připnutý snapshot s preflightem; sondovací smyčky jsou omezené na reprezentativní id jednotlivých Oblastí, protože ACL je rozhodováno po Oblastech).

## Zbývající brány před R3 a R4

Matice je brána R2d na stagingu, **ne** souhlas s produkční aktivací. Před R3/R4 zůstává:

1. **Živé HTTP guardy AI bundle.** Context Resolver je zatím jen interní (`resolveContextBundle`, bez provider routy). Jakmile route pro volání poskytovatele vznikne, musí před uvolněním ověřit witness bundle proti živému store (jako ostatní rodiny) a tento test se rozšíří o HTTP řádek, včetně odvolané session a změny členství mezi sestavením a odesláním.
2. **Skutečná host politika web-push.** Push je dnes pouze s injektovaným senderem; reálné odesílání vyžaduje allowlist hostů push služeb, SSRF/DNS politiku, šifrování a rotaci VAPID klíčů, plánovač s jedním vlastníkem a test, že odpověď `gone` revokuje cíl. Matice se pak doplní o řádek s reálným adaptérem a fake serverem.
3. **Retence auditu.** Audit zamítnutých a bezpečnostně významných operací, jeho retenční/exportní lifecycle a ochrana proti úniku obsahu (odmítnutí zde jsou obsahově prázdná, ale produkční retence a export auditu nejsou rozhodnuty vlastníkem).
4. **Plné Browser E2E při release.** Matice nepokrývá UI, offline fronty ani klientskou cache (R3/R4); celá sada `Browser E2E` se spouští jen na přesném SHA před nasazením podle [AGENTS.md](../AGENTS.md).
5. Nezměněné brány R4: inventura dat/zařízení/konektorů, ověřená archivní záloha a restore, samostatný souhlas vlastníka s přesným rozsahem cutoveru, nezávislé bezpečnostní review citlivých změn a žádná produkční aktivace příznaků.
