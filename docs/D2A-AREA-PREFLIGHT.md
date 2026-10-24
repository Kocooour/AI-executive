# D2a, část 2 — auditovatelný preflight

Tato změna je **závislý návrh na PR #105**, nikoli plně připravená migrace. Vytváří deterministický hash vstupního a plánovaného snapshotu, sváže ho se serverovými revision a restoreGeneration a ověří neměnnost stávajících ID, workspace, payloadů, counts a záznamů tombstones.

Nástroj `scripts/preflight-area-normalization.mjs` pracuje **pouze se samostatnou offline SQLite kopií**, kterou otevírá v read-only režimu. Neukládá návrh ani nemění metadata. Vypisuje výhradně kontrolní součty a počty bez osobního obsahu.

Po konzistentním zálohování včetně WAL a `node scripts/check-data.mjs <offline-copy>` lze spustit:

```bash
node --experimental-loader ./tests/ts-loader.mjs scripts/preflight-area-normalization.mjs --offline-copy /cesta/ke/kopii/store.sqlite
```

**Důležité:** výsledný manifest musí budoucí transakční aplikátor ověřit **uvnitř stejné zamčené SQLite transakce**, ve které mění stav. Tady žádný aplikátor ještě neexistuje; nechrání to offline klienty ani návrat starých snapshotů. Před zapnutím normalizace 2a zbývá záloha a rollback, kompatibilita offline klientů a validace nových zápisů. Před Mým plánem navíc kroky 2b a 2c a serverová autorizace. Full browser E2E zůstává až release gate.

Vývoj: `codex/d2a-offline-preflight-20261024`, stacked proti `feat/d2a-area-normalization-20261023`, žádný běžící server/worktree/port ani sdílená mutabilní databáze. Oddělené modelové testery v této relaci nejsou k dispozici; CI a nezávislé review jsou nezbytné před merge.