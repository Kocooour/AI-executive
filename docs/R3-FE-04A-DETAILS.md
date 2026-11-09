# R3-FE-4a — autorizované detaily v hlavní aplikaci a sjednocení pod globálním rozsahem

**Stav:** default-off, bez produkční aktivace, **jen čtení**. Druhý čtecí řez UI-09/R3 ([ROADMAP](ROADMAP.md)); navazuje na [R3-FE-1](R3-FE-01-CLIENT-RUNTIME.md), [R3-FE-2](R3-FE-02-MY-PLAN.md) a [R3-FE-3](R3-FE-03-SCOPES.md). Kanonická sémantika: [PRODUCT.md](PRODUCT.md) (LUMI-FR-013, detail a navigace) a [UX-UI.md](UX-UI.md) (detaily, projektová stránka začíná úkoly, stabilní neprůhledná ID, přímý odkaz a Zpět/Vpřed ověřují přístup, zaostření). R3-FE-4 se dělí: **4a (tento dokument)** = detaily jen pro čtení + navigace + sjednocení; **4b (navrženo)** = zápisy a úpravy se sjednoceným pending / CAS konfliktem / uncertain / Undo / offline.

## Rozhodnutí vlastníka 2026-11-09

„Ano, sjednoť to dle zadání.“ V **cílovém režimu** (zapnutý globální přepínač rozsahu) musí **boční seznam projektů**, **inspektor** (DetailPanel) a **Quick Capture** řídit jediný globální rozsah (LUMI-FR-013), nikoli legacy data. Viz [Sjednocení](#sjednocení-pod-globálním-rozsahem).

## Příznaky

Detail daného druhu se zapne **jen když jsou všechny jeho příznaky přesně `"true"`** (čte `targetUiConfig` při každém požadavku, `lib/target-ui-config.ts`). Druh bez všech příznaků zůstává dosavadní: řádek je text, adresa se bere jako nedostupná.

| Druh | Příznaky navíc k `AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED` + `AI_EXECUTIVE_TARGET_UI_ENABLED` | Serverová trasa |
| --- | --- | --- |
| úkol | `AI_EXECUTIVE_TARGET_UI_DETAILS_ENABLED` + `AI_EXECUTIVE_TARGET_STAGING_HTTP_TEMPORAL_ENABLED` | `GET /api/target-staging/task-temporal/detail?taskId=` |
| projekt | `AI_EXECUTIVE_TARGET_UI_DETAILS_ENABLED` | `GET /api/target-staging/projects/[projectId]/tasks` (trasa vyžaduje jen základní HTTP příznak) |
| poznámka | `AI_EXECUTIVE_TARGET_UI_DETAILS_ENABLED` + `AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_ENABLED` | `GET /api/target-staging/notes/[noteId]` |

Konfigurace má nově `details:{task,project,note}` (prosté booleany). Provider se připojí i kvůli detailu (`targetDataNeeded(config)` — Můj plán **nebo** seznam **nebo** libovolný detail); příznaky detailů jsou nezávislé na Mém plánu a rozsazích. Při vypnutých příznacích je strom identický s dosavadním: žádný nový požadavek ani posluchač (`useTargetSearch(false)` je nečinný), panel a boční seznam se nenačtou (`next/dynamic`, `ssr:false`); do kořene se staticky importují jen dva drobné bezstavové moduly bez CSS a bez síťového kódu.

## Navigace a adresa

Detail se otevírá **uvnitř hlavní aplikace** (ne na samostatné stagingové stránce) typovanými cíli z `lib/view-url.ts` s ID dle UI-09e (neprůhledná, ≤ 256 znaků, bez řídicích znaků) a zachovaným `scope`. Parser a serializace jsou v `lib/target-detail-route.ts`:

| Detail | Adresa |
| --- | --- |
| projekt | `?view=Projects&projectId=P` |
| úkol v projektu | `?view=Projects&projectId=P&taskId=T` |
| úkol z Mého plánu | `?view=MyPlanPreview&taskId=T` |
| poznámka | `?view=Notes&noteId=N` |

Přijímají se jen tvary, které aplikace sama vytváří; vše ostatní (duplicitní klíče, dva cíle, prázdné/řídicí ID, neznámý pohled, úkol bez projektu mimo Můj plán, poznámka v projektu) je **tentýž klidný stav „nedostupné“**, stejně jako druh s vypnutým příznakem.

- Řádky seznamů Projekty/Poznámky, úkoly v detailu projektu a úkoly v Mém plánu jsou tlačítka (`data-detail-row`, cíl ≥ 44 px, `aria-label` „Otevřít …“), jen pokud je zapnutý příznak daného druhu.
- **Otevření** = nový záznam historie (`pushState` se značkou `{lumiTargetDetail:{scope}}`), **zavření** (tlačítko, Esc, klik na pozadí) = `history.back()`, jen když záznam vytvořila tato záložka **a rozsah je stejný**; jinak (vložený odkaz, jiná záložka, mezitím změněný rozsah) se adresa **nahradí** rodičem pro **aktuální** rozsah (úkol v projektu → projekt, jinak seznam / Můj plán) a stránku neopustí.
- **Znovunačtení, Zpět/Vpřed a přímý odkaz** otevřou detail znovu; **každé otevření je nové serverové čtení** (žádná klientská cache detailu mimo otevřené zobrazení). Adresa je jen požadavek, nikdy oprávnění.
- Cizí, odvolané, neexistující i nevalidní položky: jedna věta „Tato položka není dostupná.“ (cs/en), bez rozlišení důvodu a bez úniku existence; 404, 400 i „disabled“ se sbíhají do téhož výsledku.
- Starý legacy překladač adres se pro typovaný cíl v tomto režimu **nepoužije** (nikdy nehledá ID v místních legacy záznamech, nevypisuje legacy „odkaz nelze otevřít“ a nepřepisuje adresu); `use-lumi-app.tsx` mění chování jen za příznakem `targetDetails` (výchozí vypnuto).
- Výběr pohledu při otevřeném detailu vytvoří jeden nový záznam historie na čistou adresu pohledu (rozsah zůstane).

## Obsah detailu (jen čtení)

Rozložení opakuje inspektor: na širokém desktopu panel vedle seznamu, na tabletu a telefonu celá obrazovka (třídy `inspectorBackdrop` / `inspectorDetail`, tlačítko „← Zpět“ / „Zavřít“). Panel je `aside` s `aria-label` „Druh: název“, přebírá zaostření při otevření a po zavření vrací zaostření na řádek, který jej otevřel (klíč `data-detail-row`; klíč, ne element, takže přežije přemontování seznamu); bez řádku na nadpis stránky.

- **Úkol:** název, druh Oblasti (Osobní/Sdílená; bez viditelných nadpisů Oblastí), stav (Otevřeno/Dokončeno), termín, „Přiřazeno mně“ u sdílených; název nadřazeného projektu jen pokud jej server také autorizuje (best effort druhé čtení `limit=1`, selhání název jen vynechá). Z detailu úkolu otevřeného v projektu je název projektu odkaz.
- **Projekt:** začíná úkoly (řádky otevírají detail úkolu, je-li zapnutý), „Načíst další“ stránkuje serverovým kurzorem (řetěz kurzorů a řazení kontroluje stávající klient). **Postup se nezobrazuje**: stávající trasa úkolů projektu nevrací stav úkolů. Kontext na vyžádání se nezobrazuje: trasa `relations` vyžaduje další příznaky a mimo tento řez je.
- **Poznámka:** název a tělo jako čistý text (`white-space:pre-wrap`, bez Markdownu); revize se nezobrazuje a není nabídnuta žádná úprava.

Použité jsou existující přísné klienty (`lib/target-staging-task-preview-client.ts`, `-note-preview-client.ts`, `-project-tasks-client.ts`: přesné klíče DTO, ID, limity, `no-store`, bez přesměrování); samostatné stagingové stránky `/target-staging/**` zůstávají beze změny.

## Životní cyklus (jako R3-FE-2/3)

`lib/target-detail-session.ts` je jednorázová relace svázaná s generací (`contextVersion`): čtení vzniká jen pro serverem potvrzenou generaci (`useTargetSession` + `useTargetGate`), změna generace je **koncová** (A → B → A relaci neoživí), odpověď doručená po změně se zahodí, novější čtení nahradí starší. 401/403 → `signed-out` → rozpočet odmítnutí (`createRefusalBudget`, jako seznamy); stávající 60s revalidace běhu platí. Při `hidden` / `pagehide` / `offline` / BFCache se čtení přeruší (`suspend`) a obsah zmizí; po návratu se přístup znovu ověří. Nic se neukládá (žádné localStorage/sessionStorage/IndexedDB), nic se neloguje (test), všechna čtení jsou `GET`.

**Změna rozsahu při otevřeném detailu (rozhodnutí):** rozsah je čtecí filtr seznamů. Otevřený detail autorizované položky **zůstává otevřený** (klíčem relace je cíl, ne rozsah); seznamy pod ním se načtou pro nový rozsah a **zavření vrací seznam nového rozsahu** (viz výše). Autorizaci vždy rozhoduje server, ne rozsah.

## Sjednocení pod globálním rozsahem

Platí, když je zapnutý přepínač rozsahu (`scopes.enabled`); jinak je vše dosavadní.

- **Boční seznam projektů:** `TargetSidebarProjects` čte `project-index/global` pro aktuální rozsah (stejný druh relace a životní cyklus jako seznam Projektů; kompaktní, jen první stránka, odkaz „Všechny projekty“). Řádek otevře detail projektu (přepne na Projekty a přidá adresu). **Legacy seznam projektů dle pracovního prostoru se v cílovém režimu nezobrazuje.** Bez příznaku `..._GLOBAL_PROJECTS_ENABLED` se v bočním panelu nezobrazí žádné projekty (legacy se nepoužije), bez příznaku detailu projektu jsou řádky text.
- **Inspektor:** legacy `DetailPanel` se v cílových pohledech (cílové Projekty, Poznámky, Můj plán) nevykreslí a nedostane legacy záznam; položky se otevírají jen cílovým detailem. Legacy pohledy (Inbox, Hledání …) zůstávají beze změny.
- **Quick Capture:** **cílové API pro vytváření neexistuje** (trasy `tasks` a `projects` jsou jen `GET`, kolekce poznámek nemá trasu; existují jen úpravy názvu/stavu/termínu/smazání konkrétního záznamu). V cílovém režimu proto `openCapture()` nic neudělá a jsou skryta všechna vstupní místa: plovoucí tlačítko a zkratka ⌘⇧., tlačítko „＋ Nový“ a vstup z inspektoru v bočním panelu, mobilní tlačítko ＋, prázdný stav Domů a „Zkontrolovat v Quick Capture“ v Kontextu je vypnuté. **Otevřená položka (backend, 4b/R3):** cílový endpoint pro vytvoření úkolu/projektu/poznámky v Oblasti zvoleného rozsahu; do té doby se v cílovém režimu nic nevytváří a legacy data se nezapisují.
- **Vyhledávání — navazující krok:** legacy hledání **zůstává beze změny a není skryto** (rozhodnutí řezu: nic nemlčet). Existuje cílová trasa `title-search` ([UI-09b](R3-SLICE-TITLE-SEARCH-UI-09B.md)); její napojení na aktuální rozsah a otevírání výsledků cílovým detailem je samostatný navazující řez. Výsledek otevřený z legacy hledání otevře legacy inspektor (pohled Hledání není cílový).

## Omezení a nezahrnuto

Žádné zápisy, úpravy, Undo, CAS konflikty ani offline fronta (4b). Žádný postup projektu ani kontext na vyžádání (viz výše). Detail poznámky v projektu a úkol bez projektu mimo Můj plán nemají adresu. Neověřeno v živém prohlížeči mimo cílené testy (plná Browser E2E je vyhrazena pro release gate).

## Testy

`tests/target-ui-config.test.mjs` (matice `details`, mount rule), `tests/target-detail-route.test.mjs` (adresa, kulatý průchod s rozsahem, neplatná ID, Zpět), `tests/target-detail-session.test.mjs` (generace, 404 vs. cizí, 401, suspend/dispose, žádné ukládání), `tests/target-detail-copy.test.mjs` (cs/en shoda, klidná slova), `tests/target-details-wiring.test.mjs` (flags off = legacy, sjednocení, skrytý capture, žádný legacy záznam do inspektoru). Zahrnuto v `r2d-project-reads.yml` (cesty i příkaz).
