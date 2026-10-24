# D2a, část 3 — transakční, zálohovaný a vratný aplikátor normalizace Oblastí

**Stav: nástroj existuje, ale NENÍ aktivován.** Nic ho nevolá ze startu serveru, schématických migrací, API ani UI a v této iteraci se nespouští nad produkčními daty. Navazuje na planner (PR #105) a preflight (PR #106).

## Co aplikátor dělá

`applyAreaNormalization(expected, { now })` v `lib/area-normalization-apply.ts` pracuje nad živým store (`getDatabase()`, data podle `AI_EXECUTIVE_DATA_DIR`) a při jakékoli chybě selže uzavřeně (`AreaNormalizationBlocked`, jen sanitizované kódy):

1. **Mimo transakci** přečte zdroj sdíleným čtečkou `readAreaNormalizationSource` (`lib/area-normalization-source.ts`; **stejná** funkce používá `preflight-area-normalization.mjs`, takže se preflight a aplikace nemohou číst odlišně) a ověří manifest (`verifyAreaPreflight`). Drift = `preflight-source-drift`, žádná záloha, žádný zápis. `noChanges` → `{ status: "noop" }` bez zálohy a zápisu.
2. `createBackup("before-area-normalization")` (plná záloha SQLite + sidecar; selhání zálohy = blokace bez zápisu). Název, sha256 a velikost zálohy jdou do výsledného manifestu.
3. `BEGIN IMMEDIATE`, znovu přečte zdroj stejnou čtečkou a znovu ověří manifest (zavře mezeru mezi zálohou a zápisem; zápis entit/relací/tombstones vždy zvedá revizi, takže ověřený zdroj = záloha — počty se navíc kontrolují proti sidecaru). Znovu spustí planner.
4. Sestaví další stav: plánované entity a relace; u každé existující Oblasti bez `kind` doplní `properties.kind` (`private` v personal workspace, jinak `shared` — stejné mapování jako planner) a posune jí `updatedAt` na `max(now, starý + 1)`, nic jiného na entitě se nemění; pro každou odstraněnou redundantní relaci přidá tombstone `{ id, deletedAt: now }` (staří klienti v `mergeSnapshots` tombstonovanou relaci nevzkřísí); stávající tombstones se zachovají; `revision + 1`, `restoreGeneration` beze změny. `now` musí být bezpečné celé číslo ≥ nejnovější `updatedAt`/`createdAt` zdroje. Další stav projde `validateSnapshotStructure`.
5. Zapíše řádky přes `writeSnapshotRows` (dříve privátní `replaceUnchecked` ze `server-store.ts`; stejné konvence řádků jako každý jiný zápis, **ne** `replaceSnapshot`).
6. Ve stejné transakci znovu čte a ověří: kanonický SHA výsledku = SHA očekaného stavu, každé původní ID existuje ve stejném workspace a (mimo doplněné Oblasti) s bajtově shodným kanonickým payloadem, čerstvý preflight hlásí `noChanges === true`. Jakákoli chyba = `ROLLBACK`; až poté `COMMIT`.
7. Vrátí manifest bez obsahu: `status`, `sourceSha256`, `resultSha256`, `revisionBefore/After`, `restoreGeneration`, `backup {name, sha256, bytes}`, `counts`, `appliedAt`.

`rollbackAreaNormalization(applied)` je povolen jen tehdy, když je živý store **přesně** výsledkem aplikace (revize = `revisionAfter`, `restoreGeneration` beze změny, SHA = `resultSha256`) a soubor zálohy odpovídá zaznamenanému i sidecarovému sha256/velikosti. Jinak `post-migration-changes` / `backup-mismatch` — nikdy se nepřepisují pozdější zápisy. Provede se standardním `restoreBackup` (zvedne `restoreGeneration`, klienti převezmou obnovenou kopii místo slučování) a ověří, že SHA obnoveného stavu = `sourceSha256`.

Úprava `nextSnapshotAfterRestore`: obnovená relace už nezůstane vedle tombstonu vlastního ID (jinak by po rollbacku zůstaly tombstones odstraněných redundantních vazeb vedle znovu obnovených relací).

### Omezení rollbacku
- Obnova vrací do stavu zálohy **všechny zálohované tabulky** (kontext, pracovní relace, ... viz `backup-scope.ts`), nejen entity a relace. Proto se rollback dělá jen při zastavené službě a bezprostředně po chybné aplikaci. Změny těchto tabulek po aplikaci rollback neodmítne, ale přepíše.
- Rollback vytvoří i vlastní zálohu `before-restore`.
- Po rollbacku zůstávají tombstones Oblastí vytvořených migrací (aby je klienti smazali). Planner proto další normalizaci odmítne (`tombstoned-generated-area-id`); opětovná aplikace vyžaduje vědomé rozhodnutí, ne tichý re-run.
- Mezi kontrolou a obnovou (rollback) neexistuje jeden společný zámek; služba proto musí být zastavená.

## Provozní postup (až bude aktivováno)
Služba musí být zastavená při rollbacku; zastavit ji doporučujeme i při aplikaci (aplikace je bezpečná vůči souběžným zápisům díky zámku, zastavení jen předejde zbytečnému přepisování u klientů).

1. Konzistentní záloha (včetně WAL) a `node scripts/check-data.mjs <kopie>`.
2. Preflight nad **offline kopií**: `node --experimental-loader ./tests/ts-loader.mjs scripts/preflight-area-normalization.mjs --offline-copy <kopie>/store.sqlite > preflight.json`. Zkontrolovat počty, `pendingAreaKindBackfills`, `removedRelations`, `blocked` důvody. Vypsaný JSON (včetně obalu `status: "offline-preflight-only"`) se použije beze změny.
3. Zastavit službu. Spustit nad živým datovým adresářem (absolutní `AI_EXECUTIVE_DATA_DIR`):
   `node --experimental-loader ./tests/ts-loader.mjs scripts/apply-area-normalization.mjs --manifest preflight.json --confirm <sourceSha256>`
   `--confirm` musí přesně odpovídat `sourceSha256` v manifestu, jinak skript skončí kódem 2 **bez otevření databáze**. Výstup je jen manifest (uložit jako `applied.json`); při selhání `{"status":"blocked","reasons":[...]}` s kódy a kód 1. Manifest preflightu musí mít jen známá pole a přesně odpovídat živému zdroji (kopie musí pocházet ze stejné revize).
4. Ověřit: `check-data` nad živým store, čerstvý preflight (`noChanges: true`), spuštění služby a kontrola čitelnosti `GET /api/store`.
5. Rollback (služba zastavená): `... scripts/apply-area-normalization.mjs --rollback applied.json --confirm <resultSha256>`. Při selhání viz výše (`post-migration-changes`, `backup-mismatch`); v takovém případě se rozhoduje ručně z uložené zálohy, nic se nepřepisuje automaticky.

## NENÍ aktivováno — brány pro část 4
Produkční běh je zakázán, dokud:
- Zápisové cesty klienta i serveru stále vytvářejí task-level vazby na Oblast a položky bez Oblasti, takže by se normalizovaný stav rozpadal: `app/ui/views/detail-panel.tsx` (výběr Oblasti u úkolu), `app/ui/views/project-page.tsx`, `lib/inbox-batch-store.ts`, `app/ui/use-lumi-app.tsx` (`relate(... "belongs_to_area")`), `lib/task-suggestions.ts`, `lib/ai-actions.ts`. Nové zápisy musí být normalizovány/validovány (část 4).
- Jsou dokončeny části 2b/2c a serverová autorizace Oblastí.
- Produkční spuštění proběhne až po části 4 a po výslovném schválení vlastníkem projektu.
- Plná browser E2E sada se spouští jen jako release gate bezprostředně před nasazením na přesný SHA (viz AGENTS.md), nikoli během vývoje tohoto nástroje.
