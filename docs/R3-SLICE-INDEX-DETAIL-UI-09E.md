# R3 / UI-09e — propojení globálního stagingového Vše s bezpečným detailem

**Staging-only, výchozí stav vypnuto.** Navazuje na sloučené UI-09a (#308), UI-09c (#312) a UI-09d (#314). Propojuje již existující globální autorizovaný čtecí náhled s izolovanými čtecími náhledy jednotlivých projektů a poznámek. Produkční shell, cílové UI-09/R3 oprávnění, datový cutover a schválený model Mého plánu zůstávají nedotčeny.

## Nezávislé serverové příznaky

Zdrojová stránka `/target-staging/global-index/preview` už sama vyžaduje tři dosavadní explicitní `true`:
- `AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED`
- `AI_EXECUTIVE_TARGET_STAGING_HTTP_GLOBAL_COMBINED_ENABLED`
- `AI_EXECUTIVE_TARGET_STAGING_GLOBAL_INDEX_CLIENT_PREVIEW_ENABLED`

Odkazy se **ani na povolené stránce neobjeví**, dokud není navíc `AI_EXECUTIVE_TARGET_STAGING_INDEX_DETAIL_LINKS_ENABLED=true`. Každý typ má další nezávislý serverový opt-in:

- Projekt: `AI_EXECUTIVE_TARGET_STAGING_PROJECT_TASKS_CLIENT_PREVIEW_ENABLED=true`.
- Poznámka: **oba** `AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_ENABLED=true` a `AI_EXECUTIVE_TARGET_STAGING_NOTE_CLIENT_PREVIEW_ENABLED=true`.

Příznaky nikde nenastavujeme v produkční konfiguraci; `noindex,nofollow` a izolace od běžné navigace zůstávají. Při nedostupném cílovém preview je název položky **text**, nikoli rozbitý odkaz. Úkoly se zde zatím neotevírají, protože nemají odpovídající samostatný autorizovaný cílový detail v tomto řezu.

## Bezpečnost odkazu a navigace

- Projekt/poznámka získá obyčejný sémantický **odkaz** s přístupným popisem a klávesnicovým fokusem 44 px, **nikoli automatický klientský prefetch**. URL obsahuje jen jednu bezpečně zakódovanou kanonickou ID položky, žádný titulek, roli, `areaId`, výpis oprávnění, identitu, obsah poznámky ani cursor.
- Identifikátory se validují před vytvořením URL. Ambivalentní segmenty, ASCII controls, neplatný UTF-16, slash/backslash, trimované a příliš dlouhé ID nemají odkaz; původní oprávněný text zůstane viditelný. Testy ověřují zvláštní znaky i proti pokusu přesměrovat URL.
- **Odkaz není autorizační token.** Cílový projekt i poznámka mají vlastní výchozím stavem zavřený serverový gate a svůj **ruční GET**. Backend znovu ověřuje aktivního aktéra, relaci, oprávnění v Oblasti a potřebné revize v době čtení; 404 pro nedostupné/cizí ID zůstává nerozlišitelné. UI název nebo URL nikdy nemění ani nezvyšují práva.
- Zdrojový přehled nadále maže staré výsledky při offline, skrytí, ztrátě kontextu, přepnutí rozsahu a při pokračování stránkování. Návrat ze stránky vyžaduje nové ověření. Žádný nový zápis, stav do storage, automatický retry nebo deploy.

## Ověření

- `tests/target-staging-index-detail-ui09e.test.mjs`: samostatné serverové příznaky, bezpečná tvorba odkazu, task/no-link a nepřítomnost produkčního propojení.
- **Rozšířený existující** `Focused global Vše privacy preview browser`: s vypnutým novým příznakem ověří zobrazení názvů bez odkazů a HTTP 404 cílových route; s `LUMI_INDEX_DETAIL_PREVIEW_E2E=true` *jen v druhé části CI* syntetickým/mockovaným GET ověří projekty, poznámky a úkoly, skutečné kliknutí v Chromiu, nulový detail GET bez ručního ověření, a 404 při revokaci. Port 3113, izolované přihlášení, ephemeral data, bez reálného stagingu.
- Standardní `PR Checks` (TS, unit včetně ACL/security, produkční build). Plná Browser E2E zůstává vyhrazena pro explicitní předprodukční release gate.

Větev `codex/ui09e-staging-index-detail-links`. GitHub-only změny; žádný společný worktree, proces, databáze nebo port. PR neslučovat před úspěšným CI a čistým celým review na aktuálním SHA; produkční nasazení pouze po samostatných R4 branách.
