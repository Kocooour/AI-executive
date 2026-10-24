# D2a, část 2 — auditovatelný preflight

Tato změna navazuje na **již sloučené PR #105**, nikoli na hotovou migraci. Vytváří deterministický hash vstupního a plánovaného snapshotu, sváže ho se serverovými revision a restoreGeneration a ověří neměnnost stávajících ID, workspace, payloadů, counts a záznamů tombstones.

Nástroj `scripts/preflight-area-normalization.mjs` pracuje **pouze se samostatnou offline SQLite kopií**, kterou otevírá v read-only režimu. Neukládá návrh ani nemění metadata. Vypisuje výhradně kontrolní součty a počty bez osobního obsahu.

Po konzistentním zálohování včetně WAL a `node scripts/check-data.mjs <offline-copy>` lze spustit:

```bash
node --experimental-loader ./tests/ts-loader.mjs scripts/preflight-area-normalization.mjs --offline-copy /cesta/ke/kopii/store.sqlite
```

**Důležité:** výsledný manifest musí budoucí transakční aplikátor ověřit **uvnitř stejné zamčené SQLite transakce**, ve které mění stav. Tady žádný aplikátor ještě neexistuje; nechrání to offline klienty ani návrat starých snapshotů. Před zapnutím normalizace 2a zbývá záloha a rollback, kompatibilita offline klientů a validace nových zápisů. Před Mým plánem navíc kroky 2b a 2c a serverová autorizace. Full browser E2E zůstává až release gate.

Vývoj: `codex/d2a-offline-preflight-20261024`, po sloučení PR #105 cílený proti `main`; žádný běžící server/worktree/port ani sdílená mutabilní databáze. Oddělené modelové testery v této relaci nejsou k dispozici; CI a nezávislé review jsou nezbytné před merge.

**Nová brána základního PR #105:** existující legacy Oblasti bez `properties.kind` jsou v manifestu označené jako `pendingAreaKindBackfills` / `areaKindBackfillRequired`. `noChanges` nesmí znamenat hotovou normalizaci, pokud ještě zbývá bezpečnostní typ doplnit. Tento PR tyto oblasti **nemění** a aplikátor musí backfill zvlášť auditovat.


## SQLite a plný otisk zdroje
- `restoreGeneration` v `metadata` může před první obnovou zcela chybět; tehdy je podle serverového kontraktu **0**. Přítomná hodnota však musí být validní nezáporné celé číslo; `revision` je povinná.
- Při samotném plánování se tombstones z načtené SQLite kopie předávají normalizačnímu planneru z PR #105, takže nikdy nevznikne relace s dříve smazaným ID; auditovaně redundantní vazby `belongs_to_area` i `belongs_to_project` jsou přípustné pouze při konkrétně vykázaném odstranění.
- Zdrojový i cílový SHA-256 zahrnují všechny entity, relace a také tombstones s dvojicí `id` + `deletedAt`. Ověření pozdějšího stavu zamítne jak změnu času smazání, tak přidání nebo odebrání tombstonu bez posunu revize. Pořadí tabulek nehraje roli.
- `entities.updated_at` musí odpovídat `payload.updatedAt || 0` a `relations.created_at` musí odpovídat `payload.createdAt || 0`, přesně podle zápisu v `server-store.ts`. Při nesouladu je offline kopie odmítnuta.
- Manifest nadále **nepokrývá ostatní SQLite tabulky** (context, historie, tokens, atd.) a není aplikátorem. Konzistentní plná záloha, audit a transakční read/write bariéra proto zůstávají nutnou podmínkou před případnou živou migrací.
