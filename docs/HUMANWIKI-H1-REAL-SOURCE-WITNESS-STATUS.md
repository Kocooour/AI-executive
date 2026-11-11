# HumanWiki H1-real.8 — owner-private source intent + real witness HTTP observation

**Milník a skutečná integrační akceptace:** vlastník při explicitně povoleném opt-in `GET /api/humanwiki/source-witness-status` nad skutečnou privátní SQLite HMAC evidencí, živou staging Area ACL a podepsanou externě konfigurovanou HTTPS witness službou uvidí **source-specific poslední záměr** pro ChatGPT/Claude a zda podepsaný vzdálený HMAC prefix pokrývá **události tohoto vlastníka** (nikoli globální lag jiných vlastníků). Po skutečném source-specific `POST /api/humanwiki/withdrawal-intent` endpoint zobrazí `withdrawal_requested` a `signed_witness_prefix_lags_owner_intents`; po oddělené offline witness publikaci `signed_witness_prefix_covers_owner_intents`. **Ani jeden výsledek není dokončená revokace ani autorizace.**

Toto je skutečný konzumentský GET handler se stávajícím write API a fyzickou evidence/witness službou, nikoli další samostatný fixture-only plánovač. Testy používají výhradně syntetickou identitu/export-free metadata, ale skutečné izolované SQLite, owner HTTP route a certifikátem validovaný TLS listener. Nic se automaticky nenasazuje.

## Kontrakt API

- Default **OFF**: `AI_EXECUTIVE_HUMANWIKI_SOURCE_WITNESS_STATUS_ENABLED=true` explicitně na serveru. GET bez platného owner cookie, živé owner-private Area ACL, správného restore generation, pinned HMAC ledgeru a witness Ed25519 SPKI/HTTPS originu je uniformní `404` bez úniku existence zdroje. Query ani request body se nečtou, žádná klientská identita/Area/registr/nonce/URL není akceptována. Max. 12 kontrol / 10 min dle serverového rate limiteru.
- Při validní owner session používá existující privátní HMAC SQLite; dva úplné audity místní historie a kanonického append-only schématu obklopují skutečný nonce-bound Ed25519 H1-real.7 plánovač s 2s deadline. Další audit čte pouze source-specific poslední intent/revizi pro serverem ověřenou scope. Head před/po source výběru musí být nezměněný; owner cookie, config a Area ACL se po síťové odpovědi znovu ověřují.
- **Pouze vlastníkovi příslušný** `witnessState` je `signed_witness_prefix_covers_owner_intents` nebo `signed_witness_prefix_lags_owner_intents`. Hodnota se odvozuje jen z poslední sekvence ověřených událostí přihlášeného vlastníka vůči podepsanému globálnímu prefixu; **cizí-only append nezmění žádnou položku owner HTTP odpovědi**. Globální backlog je dostupný pouze operátorskému procesu, nikoli uživatelskému API; cizí podpis, witness ahead, cizí prefix, poškozený HMAC, obnovená starší lokální DB, chybné certifikáty, timeout či neplatná session dávají `404`. HTTP **nikdy** nevydá navržený publikační tuple, digest, sekvenci, zdrojové ID ani lokální klíč; `sources` obsahuje jen `revision` a `latestIntent` (`withdrawal_requested`, `grant_requested`, `null`) pro dvě známé třídy zdrojů.
- Odpověď má `cache-control: no-store` a explicitní `importAuthorized=false`, `consentVerified=false`, `independentWitnessVerified=false`, `withdrawalComplete=false`, `realImportEnabled=false`, `claimsCreated=0`. Ani `signed_witness_prefix_covers_owner_intents` nedokazuje fyzicky nezávislé domény, dokončení revokace, source-specific ACK ani aktuální právo importovat.
- Právo k přenosu reálných soukromých exportů zůstává **zamítnuto**: `POST /api/humanwiki/import` je beze změn deny-only a nesmí číst request body. Žádný Gmail obsah, mailbox archivace, Context Graph claims ani release.

## Akceptace

```bash
node --experimental-loader ./tests/ts-loader.mjs --test \
  tests/humanwiki-h1-real-source-witness-status.test.mjs
```

Test musí projít skutečným owner POST withdrawal intent → soukromý SQLite commit → owner GET se zpožděním **vlastních** událostí → samostatný offline witness publish → owner GET s pokrytým podepsaným prefixem, a zachovat všechna oprávnění `false`. Samostatně se ověřuje invariant: **pouze cizí globální append nemění ani `witnessState`, ani ostatní JSON vlastníka**; dále neautentizovaná session, cizí Area, parametry, vypnutý flag, špatný veřejný klíč, změna lokálního ledgeru během HTTPS, podpisem potvrzený **nesprávný** remote prefix a trvalé odmítnutí importního POST bez přečtení těla. Certifikát a klíče jsou pouze dočasné, generované v CI.

## Neuzavřené brány

Provozní potvrzení skutečně nezávislého witness hostu, source-level write-before-ack a trvalý ack v source DB, monotónní off-backup antirollback kotva, use-time atomická Area ACL pro budoucí zápisy, revokační invalidace derivací, retence/sensitivity a R3/R4 release gate zůstávají nesplněné. Pro dokončenou revokaci nestačí kontrola stejného globálního digestu. **Žádný reálný import ani nasazení bez samostatného bezpečnostního a provozního rozhodnutí vlastníka.**
