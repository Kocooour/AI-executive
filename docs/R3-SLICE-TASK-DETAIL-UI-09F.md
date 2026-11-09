# R3 / UI-09f — izolovaný náhled úkolu

Staging-only, výchozím stavem vypnuto. Přidává přímý read-only `/target-staging/tasks/[taskId]/preview` a volitelný odkaz z globálního indexu. Endpoint `/api/target-staging/task-temporal/detail` při každém GET znovu ověřuje aktéra, session, Area ACL a živé revize úkolu i rodiče; 404 nerozlišuje cizí a neexistující položku. Náhled není produkční detail ani aktivace R3/R4.

Stránka vyžaduje přesně `true` pro `AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED`, `AI_EXECUTIVE_TARGET_STAGING_HTTP_TEMPORAL_ENABLED` a `AI_EXECUTIVE_TARGET_STAGING_TASK_CLIENT_PREVIEW_ENABLED`. Odkaz navíc vyžaduje všechny brány globálního indexu a `AI_EXECUTIVE_TARGET_STAGING_INDEX_DETAIL_LINKS_ENABLED`. Nebezpečné nebo ambivalentní URL segmenty zůstávají neklikatelné; odkaz není oprávnění a nevyvolává prefetch.

Čtení se spouští výhradně ručně, GET má no-store, same-origin a zakázané přesměrování; odpověď má omezenou velikost a přísně ověřený DTO. Zobrazuje název, stav, případný termín, typ oblasti a vlastní přiřazení. Při změně viditelnosti, ztrátě fokusu, offline, opuštění stránky a BFCache se obsah odstraní a probíhající GET zruší. Pozdní odpověď se ignoruje. Žádný zápis, trvalá cache ani produkční konfigurace.

Lokální unit testy `tests/target-staging-task-preview-ui09f.test.mjs`, `tests/target-staging-index-detail-ui09e.test.mjs`; typová kontrola projektu. Cílený workflow `Scoped UI-09f task-preview browser` používá izolovaný port 3128 a syntetické odpovědi; kontroluje výchozí 404, ruční GET, chybové stavy a ignorování pozdní odpovědi po blur/offline/pagehide. Před nasazením zůstávají příslušné R3/R4 brány.

## Konzervativní limity a znovuověření náhledu

Stagingový náhled záměrně přijímá užší množinu dat než obecný serverový temporal read model: název smí mít nejvýše 4096 jednotek UTF-16 (stejná jednotka jako limit task writeru), musí být korektní UTF-16; `areaId` a nenulové `projectId` musí být korektní UTF-16 a mít nejvýše 4096 bajtů UTF-8. Jednotka u ID omezuje velikost přenášených dat. Identifikátor samotného úkolu musí navíc vyhovovat bezpečnému URL segmentu a limitu 512 UTF-8 bajtů. Přísnější kontrola náhledu tedy může odmítnout serverem přečtený záznam, například starší či jinak vytvořený záznam s delším nebo neplatným textem; zobrazí se chyba validace bez obsahu. Tyto limity nejsou omezením databáze ani příslibem plné dostupnosti všech historických ID.

[UX specifikace](UX-UI.md) požaduje nové serverové ověření při online otevření a obnovení přímého odkazu a odstranění nepovolených náhledů po revokaci; [architektura](ARCHITECTURE.md) popisuje opětovné ověření přístupu při návratu fokusu. Konkrétní konzervativní chování tohoto izolovaného stagingového náhledu je přísnější: po ztrátě či návratu fokusu, skrytí, `pagehide`, návratu z BFCache nebo offline obsah skryje a neobnovuje sám; další ověření i zobrazení vyžaduje ruční načtení. Nejde o tvrzení, že UX specifikace vyžaduje právě tuto ruční interakci pro cílovou aplikaci.
