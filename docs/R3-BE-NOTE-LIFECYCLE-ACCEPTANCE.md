# R3-BE-QA — Integrovaný životní cyklus soukromé poznámky

**Milník:** [R3 — integrační QA před R4](ROADMAP.md).
**Akceptace:** jeden skutečný izolovaný stagingový SQLite store, skutečné Next route handlery a write-child procesy; owner vytvoří samostatnou soukromou poznámku, čte ji, mění pomocí autorizovaného CAS, opakuje tentýž příkaz idempotentně a smaže ji s tombstonem. Cizí identita nesmí obsah ani CAS přečíst ani změnit. Po odvolání durable session se nepovolí další čtení ani zápis. Nezapisuje se do legacy adresáře.

Tento krok **nepřidává nový endpoint ani UI funkci**. Ověřuje první skutečný backendový tok napříč již sloučenými HTTP a perzistentními komponentami před dokončením R3. Nejde o mock HTTP ani čistě syntetickou policy laboratoř: identita i obsah jsou testovací, ale autorizační cesta, subprocesy, SQLite transakce, receipt, editace a smazání jsou skutečné.

## Reprodukce a kontrola

```bash
node --experimental-loader ./tests/ts-loader.mjs --test tests/r3-backend-note-lifecycle-http.test.mjs
pnpm typecheck
pnpm build
```

Test kontroluje:
- create POST a přesný retry 201/200 bez duplicit, včetně neměnnosti SQLite notes, lifecycle receipt/audit, change sequence, anchor a fyzického journalu;
- autorizované GET a edit preview; PATCH stejného příkazu, čtení změněného obsahu;
- izolaci Alice/Bob a odmítnutí cizích soukromých dat;
- DELETE a opakování, 404 po smazání, přesně jeden edit audit, delete audit a tombstone; následný nový create se stejným noteId je odmítnut bez vedlejších zápisů;
- odvolání živé durable session: 401 pro čtení, preflight, zápis a create, žádná změna původní poznámky ani vedlejší vytvoření nového noteId, receipt, auditu, anchoru nebo journalu;
- zachování legacy sentinel souboru v oddělené cestě.

Všechny testovací flagy žijí pouze uvnitř izolovaného testovacího procesu a jsou po dokončení obnoveny. Žádná produkční aktivace, reálné uživatelské údaje, deployment ani povolení R4. Před release nadále chybí kompletní integrovaná R3 QA včetně skutečného UI a **plné Browser E2E na přesném release SHA**. Rozpracovaná PR #370 a #383 ani již sloučená PR #380 a #384 nejsou součástí tohoto kroku. Je nutné samostatné code review a zelené PR Checks.
