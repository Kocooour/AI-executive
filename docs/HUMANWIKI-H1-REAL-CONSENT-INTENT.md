# HumanWiki H1-real.3a — zdrojově oddělené záměry souhlasu (příprava)

**Stav:** implementovaný lokální SQLite registr **záměrů**, nikoli účinný souhlas pro import.
Navazuje na H1-real.2 ([sloučený PR #374](https://github.com/Kocooour/AI-executive/pull/374)), který ověřuje skutečnou owner-private Oblast; jeho read-only preflight však není write-time autorizací záměrů souhlasu. Tato iterace nepřidává HTTP route, tlačítko v UI, operátorský nástroj pro reálné údaje ani právo nahrát export.

## Rozsah

- `lib/humanwiki-consent-intents.mjs`: interní `createHumanWikiConsentIntentSchema`, `appendHumanWikiConsentIntent`, `humanWikiConsentIntentReadiness`.
- Skutečná perzistence do vyhrazeného soukromého SQLite souboru dodaného důvěryhodným volajícím; nikoli do kanonické R2d/R3 SQLite databáze. Volající musí chránit adresář, práva, zálohy a klíč. Zapisovač vynutí SQLite `synchronous=FULL` a **povoluje pouze `journal_mode=DELETE` uvnitř BEGIN IMMEDIATE**; `OFF`, `MEMORY`, `WAL` i ostatní módy odmítá. Tento záměrně jednosouborový kontrakt zatím nemá samostatný bezpečný backup/checkpoint protokol pro WAL sidecary. Testy používají `DELETE`. V produkčním prostředí se registr zatím **nikde neotevírá**.
- Události `grant_requested` / `withdrawal_requested` jsou **požadavky**, ne dokončené souhlasy nebo revokace. Jen `chatgpt_user_export` / `claude_user_export`; `purpose=humanwiki_context_bootstrap`; pevná volba retence 30/90/180/365 dní. Bez původních textů, úryvků, e-mailu, jmen souborů, tokenů či identifikátorů konkrétního exportu. Retence je jen deklarovaná preference, ne implementovaná karanténa a expirační worker.
- V každé kombinaci pseudonymního owner+private-Area scope a typu zdroje je monotonická revize a explicitní compare-and-swap (`expectedRevision`). Zápis vyžaduje `explicitConfirmation=true`, přísný sedmipoložkový příkaz a náhodné `commandId` v UUIDv4. Stejný příkaz se idempotentně přehraje; stejné ID s jiným obsahem je konflikt.
- HMAC-SHA256 na scope i na souvislý, neupdatovatelný a nemazatelný řetěz všech událostí; ověření celé lokální historie při čtení i změně, limit 10 000 událostí. **Běžné grant požadavky** jsou zastaveny při 9 000 celkových záznamech; **posledních 1 000 slotů** je rezervováno pouze pro `withdrawal_requested`. Režim se kontroluje v téže zapisovací transakci jako CAS; idempotentní přehrání již přijatého UUID funguje i po vyčerpání kapacity. Chybějící klíč, porušení záznamu/řetězu, chybné SQL či neplatný příkaz znamená zamítnutí. Klíč **nikdy** není v DB.
- Výsledky **vždy** vracejí `importAuthorized=false`; u všech záznamů `consentVerified=false`, `independentWitnessVerified=false`, `withdrawalComplete=false`. Stávající `POST /api/humanwiki/import` zůstává vždy zamítací.

## Bezpečnostní omezení

Při vyčerpání všech 10 000 událostí ani nový požadavek na odvolání **nelze zaznamenat**; vrátí `capacity`, nikoli potvrzení dokončeného odvolání, a veškerá ingestace zůstává zablokovaná. Rezerva je pouze preventivní prostor, ne neomezená dostupnost: před jejím vyčerpáním je nutný nezávisle ověřovaný rollover/revokační witness a operátorský postup (dosud neimplementován). Samotná lokální HMAC historie neumí odhalit konzistentní rollback DB a její historie ani potvrdit úplné odvolání: při návratu ze staré zálohy bude stále lokálně konzistentní. Bez **nezávislého high-water witness mimo recovery doménu**, stabilní vazby na konkrétní uživatelský export a autentizované write-time actor+Area ACL nelze událost povýšit na souhlas použitelný pro import. Schválené pravidlo vyžaduje revokaci evidence i všech odvozených claimů a cache a kontrolu před vydáním dat. Nic z toho tato iterace neslibuje.

**Zejména:** `trustedScope` je pouze programátorský vstup interní knihovny, **není** autentizační důkaz. Nezapojovat jej přímo na hodnoty z requestu, nepřidávat endpoint podle těchto příkladů a nepovažovat `explicitConfirmation=true` od klienta za autentizovaný souhlas. Budoucí server musí současně zkontrolovat skutečnou cookie/identitu, přesnou soukromou Oblast a revokační stav ve stejném use-time kroku a nezávislý witness. H1-real.2 je pouze read-time preflight, nikoli časově atomické přidělení oprávnění.

## Ověření

```sh
node --experimental-loader ./tests/ts-loader.mjs --test tests/humanwiki-h1-real-consent-intents.test.mjs
```

Testy používají **skutečný dočasný SQLite soubor, pouze fiktivní účty**: potvrzení požadavku a restart, izolace typů zdrojů/scope, CAS, idempotentní retry a konflikty, strict allowlist, SQL immutable triggery, režimy žurnálu `OFF`/`MEMORY`/`WAL` versus `DELETE`, skutečnou kapacitu 9 000 i 10 000 událostí a vyhrazené sloty pro odvolání, tampering HMAC, chybějící klíč, obnovení staré DB a stálé zamítání importu. Nejde o HTTP acceptance, skutečný owner-consent, dokončení revokace ani produkční akceptaci.

## Navazující H1-real.3b

Provázat záznamy s podepsanou owner session a **konkrétním exportem** v bezpečné serverové cestě, s atomickým ověřením soukromé Oblasti v okamžiku zápisu; dokončit nezávislý revokační registry/witness a source-specific retenci i karanténu. Do té doby všech šest H1-real bran zůstává `not_verified_blocked`, skutečné exporty se nečtou a Gmail/iCloud jsou mimo scope.
