# QA-02 — skutečné syntetické globální čtení od endpointu po BE-19

**Stav:** test-only staging integrace; nenahrazuje Browser E2E release gate. Navazuje na R2d.3m.8 (autorizovaný globální HTTP index), R3 BE-16/17 (transport a stránkování) a BE-18/19 (identitně vázaná čtecí relace a suspend/resume).

## Předmět ověření

`tests/target-staging-global-index-live-session-qa02.test.mjs` používá izolovaný SQLite bootstrap, skutečné serverové `GET /api/target-staging/global-index`, skutečné owner a durable sessions, child snapshot, per-session HMAC kurzory a běžný browser transport přesměrovaný pouze v procesu testu na reálný route handler. Nejde o stub serverové autorizace ani o browser/prod UI.

Šest scénářů:
- jedna identita owner a další editor/viewer; globální **Vše** i **Sdílené** zahrnují sdílenou nepřidělenou práci podle skutečné ACL, nikdy cizí osobní titulky, bodies poznámek nebo serverové epochy;
- změna aktéra uprostřed stránkování zahodí předchozí cursor a obsah, včetně A→B→A;
- trvalá revokace session mezi dvěma skutečnými GET vrátí odmítnutí bez dříve nashromážděných titulů;
- odebrání viewer členství při `suspend()` znemožní po `resume()` vydat staré sdílené projekty, úkoly nebo názvy poznámek; data se objeví jedině po explicitním novém GET dle aktuálního live ACL;
- změna **jen těla poznámky** zneplatní podepsaný cursor kombinovaného indexu a vymaže již složený klientský seznam;
- vypnutý serverový flag skutečně vrací 404 a čtečka chybu `unavailable`; znovuzapnutí pouze v testovací instanci samo nic nenačte a nové načtení vyžaduje explicitní `loadFirst()`.

Test uchovává legacy sentinel v odděleném adresáři a po skončení vrátí všechny procesní proměnné a odstraní syntetický store. Nemění serverové routy, autorizaci, UI, navigaci, DB schéma ani produkční data. Veškeré feature flagy jsou zapnuté výhradně v testovacím procesu, nikoliv v produkci.

Kritické brány: běžná `PR Checks` na přesném head (security/unit, typecheck, build), code review; `Main Regression` po merge. Plná Browser E2E na přesném SHA až před schváleným produkčním nasazením.
