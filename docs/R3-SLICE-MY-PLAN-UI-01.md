# R3-slice / UI-01 — skutečný stagingový čtecí náhled Mého plánu

**Stav:** izolovaný task-only klient nad sloučeným [BE-01/#258](https://github.com/Kocooour/AI-executive/pull/258) a [BE-02/#260](https://github.com/Kocooour/AI-executive/pull/260). Není to produkční Můj plán ani část legacy Today/IndexedDB; UI-04c (#259) zůstává samostatný designový preview proud. Řídí se rozhodnutím [5. 11. 2026](decisions/2026-11-05-ui-revize-a-vertikalni-rez.md).

## Zobrazení a zapnutí pouze v izolovaném stagingu

- Ruční adresa: `/target-staging/my-plan/preview`; **žádná položka navigace** ani prolink na produkční aplikaci.
- Serverová stránka vrací 404, pokud nejsou současně nastavené **všechny** výchozím nastavením vypnuté příznaky:
  - `AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED=true`
  - `AI_EXECUTIVE_TARGET_STAGING_HTTP_MY_PLAN_DAY_ENABLED=true`
  - `AI_EXECUTIVE_TARGET_STAGING_HTTP_MY_PLAN_SLICE_ENABLED=true`
  - `AI_EXECUTIVE_TARGET_STAGING_MY_PLAN_CLIENT_PREVIEW_ENABLED=true`
- Tento PR žádný příznak nezapíná a nepřidává veřejný způsob vydání staging session. Syntetická staging identita/session je vydávána výhradně existující interní autoritou. Backend prověřuje identitu, ACL, datum, signed cursor a epoch při **každém** volání.
- Náhled používá lokální kalendářní datum zařízení (ne serverový čas), filtr **osobního Mého plánu** `all|personal|shared` (nikdy globální Vše) a zobrazuje Dnes včetně minulých otevřených úkolů a Zítra. Úkoly jsou blokově skupinovány podle aktuální Oblasti bez názvu a ID; sdílená práce pouze přiřazená aktuálnímu aktérovi.
- Je to **pouze čtecí** pohled na úkoly: bez událostí, doplňkových AI návrhů, CAS dokončení, přesunu `whenOn` ani Undo. Tyto interakce naváže příští fáze až po bezpečném preview+receipt kontraktu. Neprezentovat statickou rozpracovanou stránku jako kompletní cílové UI.

## UI-02 — aktuálnost kalendáře a opětovná autorizace po návratu

- Základní režim **Aktuální den** sleduje místní datum v zařízení; denní timer používá následující **místní půlnoc** (ne přičítání pevně 24 hodin, což by selhávalo při změnách letního času). Dnes/Zítra se po půlnoci automaticky přepočítají a znovu načtou ze serveru.
- Ručně vybraný den přepíná náhled do režimu **pevného data**. Půlnoc mu datum nezmění, ale znovu ověří čerstvost a oprávnění. Popisky nepředstírají, že libovolné historické datum je „Dnes“; tlačítko **Aktuální den** vrací živý režim.
- Při přepnutí karty na pozadí nebo přechodu offline se citlivý přehled **okamžitě odstraní z React stavu** a probíhající požadavek se zruší. Po návratu na viditelnou kartu, `focus`, `pageshow` nebo `online` se výsledky musí znovu potvrdit přes serverový ACL/session/epoch guard; stará data se bez něj neobnovují. **I rychlý cyklus skrytí a zobrazení do 350 ms musí vždy spustit nové načtení**; omezení duplicit se týká jen dvojice focus/visibility událostí, mezi nimiž nenastalo další skrytí/offline.
- Zůstává **read-only**, bez trvalého klientského úložiště, nových cookies, zápisů, pokusu o oprávnění z UI ani zapnutí feature flags. Šlo o zpevnění náhledu před pozdějším napojením s UI-04c.
- Testy: `tests/target-staging-my-plan-lifecycle.test.mjs` pro přechod měsíc/rok/přestupný den, místní půlnoc včetně letního/zimního času, ruční datum a statické ověření životního cyklu. Plné browser E2E s revokací session a mobilním zobrazením zůstává podmínkou před produkčním nasazením.

## Ochrana soukromí a stavů

- Browser požadavky pouze **same-origin GET**, `credentials: same-origin`, `cache: no-store`, žádná trvalá cache/IndexedDB/localStorage ani optimistická mutace.
- Přísná client DTO allowlist validační vrstva nedovolí skryté actor/ACL/epoch/revision metadaty, sdílené úkoly bez `assignedToMe: true`, cizí scope, neplatné dny, duplicity, nesouvislé stránky ani nesprávné počty/kurzory.
- Na `401/403` zmizí všechna dosud zobrazená data (ztráta identity), `409` = konflikt/stale a nové načtení bez zachování starých dat; chybná či ne-cache-safe odpověď = stejný fail-closed postup. Výpadek sítě/neznámá chyba nemaže nic na serveru, nezobrazuje starý seznam jako aktuální a neslibuje potvrzenou synchronizaci.
- Nové načtení, změna filtru či data zruší předchozí request; pozdní odpověď starého requestu se ignoruje. Paging používá serverem podepsaný cursor, před přidáním další stránky odmítá duplicity a přestavění chronologického pořadí.
- Pokud se dva dny v response mění během čtení, bezpečný backend vrátí stale/409. Klient není autoritou oprávnění.

## Reprodukce / validace

- Větev `codex/r3-slice-ui01-gated-my-plan-read-20261105`, oddělená od UI-04c. Předchozí `main`: `ed650d7d316afdc06de626500951c38f8a1d2000`. Žádný spuštěný lokální port ani sdílené mutable prostředí; testy CI používají izolovaná syntetická data.
- `node --experimental-loader ./tests/ts-loader.mjs --test tests/target-staging-my-plan-client.test.mjs`; na PR standardní `pnpm typecheck`, cílené unit+ACL/security podle CI a `pnpm build`. Samostatný browser E2E až v release gate na přesném SHA.
- Jakékoli společné propojení s UI-04c a jeho designovými skupinami musí být až v integračním PR, které řeší jejich kontrakty, offline/pending/konflikt a bezpečné serverové CAS/receipts. Bez produkční aktivace, deploy, migrace či práce s produkční DB.
