# HumanWiki H1-real.4a — owner-authenticated withdrawal intent (default OFF)

**Rozsah:** skutečná serverová HTTP integrace s existujícím podepsaným owner cookie, živým čtením soukromé Oblasti v připnuté staging SQLite a samostatnou diskovou SQLite evidencí **záměrů** souhlasu. Tento milník přijímá pouze `withdrawal_requested`; neumožňuje založit `grant_requested`, otevřít soukromý export, potvrdit revokaci ani povolit import.

## Aktivace a konfigurace

Záměrně **výchozí OFF**. Pro samotnou bezpečnostní zkoušku lze nastavit `AI_EXECUTIVE_HUMANWIKI_WITHDRAWAL_INTENT_HTTP_ENABLED=true` společně s:

- Existující owner auth (`AI_EXECUTIVE_AUTH_ENABLED`, `AI_EXECUTIVE_PASSWORD_HASH`, `AI_EXECUTIVE_SESSION_SECRET`), staging konfigurace (`AI_EXECUTIVE_TARGET_STAGING_DIRECTORY`, `AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION`, `AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID`) a serverová `AI_EXECUTIVE_HUMANWIKI_PRIVATE_AREA_ID`.
- `AI_EXECUTIVE_HUMANWIKI_CONSENT_LEDGER_DIRECTORY`: **ručně zřízený samostatný absolutní adresář** pod kontrolou aplikačního UID, režim maximálně 0700; nepovolují se symbolické linky, veřejná práva ani cesta s jiným kanonickým tvarem. Trvalý soubor `humanwiki-consent-intents.sqlite` vzniká **výhradně jednorázovým offline operátorským bootstrapem** v režimu 0600 pomocí `O_CREAT | O_EXCL | O_NOFOLLOW`, nikdy při HTTP GET ani POST. Oba HTTP handlery vyžadují existující soubor; chybějící databáze se odmítá i tehdy, když dříve obsahovala evidované žádosti. Pro existující soubor je vyžadováno stejné UID, jediný hard-link, nanejvýš 0600, žádné `-wal` / `-shm`, režim žurnálu DELETE a přesně očekávaná definice tabulky, indexu a obou immutable triggerů. Poškozené/částečné schéma se automaticky neopravuje.
- `AI_EXECUTIVE_HUMANWIKI_CONSENT_LEDGER_HMAC_KEY`: samostatný kryptograficky náhodný **32B klíč** v kanonickém Base64URL (43 znaků), jiný než session secret a soukromý Ed25519 klíč externího svědka. Ztráta či změna klíče znamená nedostupnost původního registru, nikoli jeho restart. Zálohovat odděleně a bezpečně. Nikdy necommittovat.

## Jednorázové založení a obnova

Správce nejprve ručně založí **prázdný soukromý adresář** v režimu 0700 a samostatně bezpečně uloží HMAC klíč. Při vypnutém `AI_EXECUTIVE_HUMANWIKI_WITHDRAWAL_INTENT_HTTP_ENABLED` spustí **mimo běžný webserver**:

```bash
AI_EXECUTIVE_HUMANWIKI_CONSENT_LEDGER_DIRECTORY=/secure/empty-ledger-directory \
AI_EXECUTIVE_HUMANWIKI_CONSENT_LEDGER_HMAC_KEY='<samostatný tajný base64url klíč>' \
node scripts/bootstrap-humanwiki-consent-ledger.mjs
```

Následné HTTP volání smí pouze používat již založený registr. Příkaz bootstrap selže na existujícím souboru (i po neúspěšném pokusu o založení). Vytvoření schématu je jednou SQLite transakcí `BEGIN IMMEDIATE / COMMIT`, při chybě se vrací `ROLLBACK`; obě immutable triggery i jejich přesné definice se kontrolují při každém čtení/zápisu. Zápis nové položky už **neumožňuje** založit chybějící DB.

**Po ztrátě databáze, nebo při neúplném / pozměněném schématu je systém zablokován.** Správce musí příčinu vyšetřit; nesmí vynulovat historii opětovným bootstrapem, dokud nebude dostupné nezávisle ověřitelné obnovení monotónního stavu. Tento příkaz **není** nezávislý revokační witness: vědomé vytvoření nového registru po ztrátě nelze bez externího svědka odlišit od prvního spuštění.

## Kontrakt

`GET /api/humanwiki/withdrawal-intent` — owner-only read-only stav: per-source **revize**, bez původních identifikátorů, záznamů, tajemství a surového obsahu. Dokud správce nenainicializuje korektní file-backed ledger nebo chybí živá soukromá Oblast, vrací obecné `404`; pouze explicitní operátorské zřízení zpřístupní první stav revize `0`.

`POST /api/humanwiki/withdrawal-intent` — pouze vlastník s reálnou podepsanou cookie, serverem určenou soukromou Oblastí a povoleným flagem. Vyžaduje `Origin` odpovídající stejné webové origin (standardní ochrana CSRF), JSON nanejvýš **1024 B** s přísným UTF-8, rate-limit 20 požadavků za 10 minut na klienta (navíc globální ochrana) a přesně sedm polí:

```json
{
  "commandId": "uuid-v4",
  "decision": "withdrawal_requested",
  "sourceType": "chatgpt_user_export",
  "purpose": "humanwiki_context_bootstrap",
  "retentionDays": null,
  "expectedRevision": 0,
  "explicitConfirmation": true
}
```

Zdroj smí být `chatgpt_user_export` nebo `claude_user_export`; `expectedRevision` plyne z autorizovaného GET. Volající nemůže určovat owner/Area ani přidat soukromý text, source excerpt, mail nebo deklarovaný consent. Stejné UUID a stejný obsah se přehrává idempotentně; konfliktní revize, jiný obsah, cizí zdroj, vadný stav registru nebo chybějící autorizace skončí default-deny `404`. Všechny odpovědi používají `no-store` a `nosniff`. Úspěch vrací jen **`withdrawal_intent_recorded_not_completed`**, revizi a `replayed`; `importAuthorized=false`, `consentVerified=false`, `withdrawalComplete=false`, `independentWitnessVerified=false`.

Před otevřením registru, před zápisem a před vydáním odpovědi se opakuje autentizace / kontrola owner-private Area, konfigurační konzistence a revize. Ověření Area (staging store) a zápis do **jiné** SQLite nejsou atomická transakce; během změny Area může být obsahově neutrálný záměr již uložen, i pokud odpověď skončí 404. To není ani bude z tohoto modulu pravomoc ke změně Context Graphu nebo autorizaci exportu.

## Nevyřešené brány

Tato iterace není dokončená revokace. Chybí nezávisle hostovaný monotónní witness, potvrzení revokačního high-water po commitu a jeho atomický durable publish/ack, závazná podoba export-consent evidence, explicitní uživatelské workflow, kompletní ochrana perzistence proti TOCTOU (SQLite soubor se otevírá jménem a jeho inode se ověřuje jen před/po operaci), transakční use-time ACL a invalidace downstream odvozenin. **Před povolením skutečných importů nebo označením revokace za dokončenou je nutná samostatná implementace a bezpečnostní review.** `POST /api/humanwiki/import` stále odmítá bez čtení request body.

## Reprodukce

```bash
node --experimental-loader ./tests/ts-loader.mjs --test tests/humanwiki-h1-real-withdrawal-intent-http.test.mjs
```

Testy používají skutečně oddělený staging store a dedicated SQLite, avšak fiktivní owner ID, smyšlené UUID, testovací klíč a žádný reálný export. Ověřují jednorázový operator-only bootstrap, odmítnutí GET i POST před bootstrapem, obnovení evidovaného stavu po reopen, **ztrátu databáze bez tichého resetu**, neúplný a pozměněný immutable trigger, **ROLLBACK po simulovaném přerušení DDL**, izolaci ChatGPT/Claude, idempotenci, odmítnutí grantu a content fields, CSRF, auth bypass, cizí Area, chybnou generaci, ztrátu HMAC klíče, symlink, práva adresáře a trvale deny-only import. CI provádí cílené PR testy; plné Browser E2E patří před produkční release.
