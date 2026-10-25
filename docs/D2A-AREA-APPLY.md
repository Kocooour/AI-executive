# D2a, část 3 — transakční, zálohovaný a vratný aplikátor normalizace Oblastí

**Stav: nástroj existuje, ale NENÍ aktivován.** Nic ho nevolá ze startu serveru, schématických migrací, API ani UI a v této iteraci se nespouští nad produkčními daty. Navazuje na planner (PR #105) a preflight (PR #106).

## Co aplikátor dělá

`applyAreaNormalization(expected, { now })` v `lib/area-normalization-apply.ts` pracuje nad živým store (`getDatabase()`, data podle `AI_EXECUTIVE_DATA_DIR`) a při jakékoli chybě selže uzavřeně (`AreaNormalizationBlocked`, jen sanitizované kódy):

1. **Mimo transakci, na samostatném read-only spojení** k živému souboru `store.sqlite` (cesta stejně jako v `server-store.ts`, soubor musí existovat; jinak `missing-store`) přečte zdroj sdíleným čtečkou `readAreaNormalizationSource` (`lib/area-normalization-source.ts`; **stejná** funkce používá `preflight-area-normalization.mjs`, takže se preflight a aplikace nemohou číst odlišně) a ověří manifest (`verifyAreaPreflight`). Drift = `preflight-source-drift`, žádná záloha, žádný zápis a **`getDatabase()` se vůbec nevolá**, takže se neprovede ani start-up migrace/oprava/retence. `noChanges` skončí stejně. `noChanges` → `{ status: "noop" }` bez zálohy a zápisu.
2. `createBackup("before-area-normalization")` (plná záloha SQLite + sidecar; selhání zálohy = blokace bez zápisu). Název, sha256 a velikost zálohy jdou do výsledného manifestu.
3. `BEGIN IMMEDIATE`, znovu přečte zdroj stejnou čtečkou a znovu ověří manifest. Pod zámkem se navíc porovná otisk ostatních obnovovaných tabulek živé DB s otiskem souboru zálohy otevřeného read-only; rozdíl (zápis do např. `attention_states` mezi zálohou a zámkem, který nezvedá revizi) = `other-tables-drift`, `ROLLBACK`, žádný zápis. Takto ověřená hodnota je `otherTablesSha256` (zavře mezeru mezi zálohou a zápisem; zápis entit/relací/tombstones vždy zvedá revizi, takže ověřený zdroj = záloha — počty se navíc kontrolují proti sidecaru). Znovu spustí planner.
4. Sestaví další stav (kromě níže uvedeného i **odstranění `properties.areaId`** u zdědících úkolů projektu, viz bod 4a): plánované entity a relace; u každé existující Oblasti bez `kind` doplní `properties.kind` (`private` v personal workspace, jinak `shared` — stejné mapování jako planner) a posune jí `updatedAt` na `max(now, starý + 1)`, nic jiného na entitě se nemění; pro každou odstraněnou redundantní relaci přidá tombstone `{ id, deletedAt: now }` (staří klienti v `mergeSnapshots` tombstonovanou relaci nevzkřísí); stávající tombstones se zachovají; `revision + 1`, `restoreGeneration` beze změny. **4a.** Zdědící úkol projektu, který ještě nese neprázdné `properties.areaId`, o tuto jedinou vlastnost přijde (`updatedAt = max(now, starý + 1)`). Klientská migrace při načtení (`migratePropertyRelations`, `lib/db.ts`) by ji jinak změnila zpět na odstraněnou vazbu `belongs_to_area`. Preflight tuto práci hlásí jako `pendingAreaIdCleanups` a do té doby není `noChanges`; v manifestu aplikace je `counts.areaIdCleanups`.
   `now` musí být bezpečné celé číslo ≥ nejnovější `updatedAt`/`createdAt` zdroje. Další stav projde `validateSnapshotStructure`.
5. Zapíše řádky přes `writeSnapshotRows` (dříve privátní `replaceUnchecked` ze `server-store.ts`; stejné konvence řádků jako každý jiný zápis, **ne** `replaceSnapshot`).
6. Ve stejné transakci znovu čte a ověří: kanonický SHA výsledku = SHA očekaného stavu, každé původní ID existuje ve stejném workspace a (mimo doplněné Oblasti) s bajtově shodným kanonickým payloadem, čerstvý preflight hlásí `noChanges === true`. Jakákoli chyba = `ROLLBACK`; až poté `COMMIT`.
7. Těsně před `COMMIT` spočítá kanonický otisk všech ostatních obnovovaných tabulek (`replacedTables` v `backup-scope.ts`: kontext, pracovní relace, pozornost atd.). Vrátí manifest bez obsahu: `status`, `sourceSha256`, `resultSha256`, `otherTablesSha256`, `revisionBefore/After`, `restoreGeneration`, `backup {name, sha256, bytes}`, `counts`, `appliedAt`.

`rollbackAreaNormalization(applied)` nejprve ověří soubor zálohy (sha256/velikost podle manifestu i sidecaru; jinak `backup-mismatch`). Všechny kontroly stavu pak běží **uvnitř transakce obnovy** (volitelné haky `verifyBefore` / `verifyAfter` v `restoreDatabaseFile`/`restoreBackup` ve `server-store.ts`; bez haků se obnova chová jako dřív): před přepsáním musí být store **přesně** výsledkem aplikace (revize = `revisionAfter`, `restoreGeneration` beze změny, SHA = `resultSha256`) a nesmí se změnit žádná jiná obnovovaná tabulka (`otherTablesSha256`), jinak `post-migration-changes` a nic se neobnoví. Před `COMMIT` se ověří, že SHA obnoveného stavu = `sourceSha256` a `restoreGeneration` vzrostl; při selhání (`rollback-verification-failed`) se celá obnova vrátí zpět a aplikovaný stav zůstane nedotčený. Obnova je standardní `restoreBackup` (zvedne `restoreGeneration`, klienti převezmou obnovenou kopii místo slučování).

Úprava `nextSnapshotAfterRestore`: obnovená relace už nezůstane vedle tombstonu vlastního ID (jinak by po rollbacku zůstaly tombstones odstraněných redundantních vazeb vedle znovu obnovených relací).

### Co se odmítne dříve, než se store otevře (read-only předkontrola)
Otevření store (`getDatabase()`) by samo zapisovalo, proto aplikace i rollback před ním odmítnou:
- `pending-schema-migrations` — v `schema_migrations` chybí některá známá migrace (chybějící tabulka = všechny čekají). Migrace přepisují payloady a zvedají revizi. **Postup operátora:** službu jednou spustit (migrace proběhnou), zastavit, preflight znovu udělat nad čerstvou kopií.
- `missing-default-workspace` — `workspace:personal` neexistuje (otevření by ho vložilo).
- `retention-pending` (jen rollback) — mailová retence by při otevření smazala řádky a smazání by se commitlo dřív, než by kontrola obnovy rollback odmítla; rollback by pak už nešel. Neprovádí se žádný zápis; sonda `countExpiredMailMetadata` (`lib/mail-sync-retention.ts`) sdílí predikáty s mazáním. U aplikace sonda není: retence před zálohou je neškodná (záloha pak obsahuje její výsledek).

Odmítnutí nikdy nemění **obsah** store; read-only otevření WAL databáze ale může vytvořit prázdné soubory `store.sqlite-wal` / `-shm`.

### Omezení rollbacku
- Tabulky vyprázdněné při každé obnově (`excludedClearedTables` v `backup-scope.ts`: `context_commands`, `work_session_commands`, `ai_proposals`, `calendar_events`, `semantic_index_outbox`, `mail_oauth_pending`) **nejsou v otisku** a rollback je vyprázdní jako každá obnova (jde o cache, čekající návrhy a výsledky příkazů).
- Otisk `otherTablesSha256` označuje typ každé hodnoty (NULL, číslo, ±Infinity, celé číslo i nad 2^53, text, BLOB), takže se různé hodnoty nesplynou.
- Rollback nejprve (na read-only spojení, bez `getDatabase()`) ověří zálohu a stav store (revize, `restoreGeneration`, SHA výsledku, otisk ostatních tabulek) a při odmítnutí store vůbec neotevře; tytéž kontroly se opakují uvnitř transakce obnovy.
- **Zbytkové omezení:** jakmile ověření projde, otevření store (`getDatabase()`) spustí běžné start-up opravy a retenci (migrace schématu, `pruneExpiredMailMetadata` apod.) ještě **před** zálohou, takže záloha už jejich výsledek obsahuje. Pokud retence později změní některou obnovovanou tabulku (např. vyprší maily), rollback může být odmítnut (`post-migration-changes`; fail-closed) — rollback proto proveďte prakticky hned po aplikaci.
- Kód `other-tables-drift`: viz bod 3 výše; stejně jako `backup-mismatch` blokuje před jakýmkoli zápisem (záloha zůstane na disku).
- Obnova vrací do stavu zálohy všechny zálohované tabulky (kontext, pracovní relace, pozornost, ... viz `backup-scope.ts`). Pozdější zápis do kterékoli z nich po aplikaci proto rollback **odmítne** (`post-migration-changes`, otisk `otherTablesSha256`), místo aby ho tiše zahodil. Takovou změnu je třeba vyřešit ručně; nic se nepřepisuje automaticky.
- Rollback vytvoří i vlastní zálohu `before-restore`.
- **Po rollbacku zůstávají tombstones vygenerovaných Oblastí** (aby je klienti smazali). Planner proto další normalizaci odmítne (`tombstoned-generated-area-id`), takže 2a nelze prostě spustit znovu. Opakování vyžaduje samostatné, zrecenzované rozhodnutí; žádné obcházení není implementováno.
- Selhání po kroku zálohy (drift zjištěný pod zámkem, chyba) nechá soubor zálohy `before-area-normalization` na disku. Je neškodný a operátor ho může smazat.
- Kód `invalid-apply-timestamp`: `now` není bezpečné celé číslo nebo je starší než nejnovější `updatedAt`/`createdAt` zdroje; blokuje se před zálohou.
- Rollback je i tak určen pro zastavenou službu: obnova vyžaduje, aby stav odpovídal výsledku aplikace, a proběhlá služba by jej mohla měnit.

## Provozní postup (až bude aktivováno)
Služba musí být zastavená při rollbacku; zastavit ji doporučujeme i při aplikaci (aplikace je bezpečná vůči souběžným zápisům díky zámku, zastavení jen předejde zbytečnému přepisování u klientů).

1. Konzistentní záloha (včetně WAL) a `node scripts/check-data.mjs <kopie>`.
2. Preflight nad **offline kopií**: `node --experimental-loader ./tests/ts-loader.mjs scripts/preflight-area-normalization.mjs --offline-copy <kopie>/store.sqlite > preflight.json`. Zkontrolovat počty, `pendingAreaKindBackfills`, `removedRelations`, `blocked` důvody. Vypsaný JSON (včetně obalu `status: "offline-preflight-only"`) se použije beze změny.
3. Zastavit službu. Spustit nad živým datovým adresářem (absolutní `AI_EXECUTIVE_DATA_DIR`):
   `node --experimental-loader ./tests/ts-loader.mjs scripts/apply-area-normalization.mjs --manifest preflight.json --confirm <sourceSha256>`
   `--confirm` musí přesně odpovídat `sourceSha256` v manifestu, jinak skript skončí kódem 2 **bez otevření databáze**. Výstup je jen manifest (uložit jako `applied.json`); při selhání `{"status":"blocked","reasons":[...]}` s kódy a kód 1. Manifest preflightu musí mít jen známá pole a přesně odpovídat živému zdroji (kopie musí pocházet ze stejné revize).
4. Ověřit: `check-data` nad živým store, čerstvý preflight (`noChanges: true`), spuštění služby a kontrola čitelnosti `GET /api/store`.
5. Rollback (služba zastavená): `... scripts/apply-area-normalization.mjs --rollback applied.json --confirm <resultSha256>`. Při selhání viz výše (`post-migration-changes`, `backup-mismatch`); v takovém případě se rozhoduje ručně z uložené zálohy, nic se nepřepisuje automaticky.

## NENÍ aktivováno — stav bran pro část 4
**Hotovo (část 4, viz [D2A-AREA-WRITES.md](D2A-AREA-WRITES.md)):**
- Serverová autorita `lib/area-write-invariants.ts` je zapojena do `replaceSnapshot` (PUT /api/store), Inbox batch, AI akcí a opakovaných výskytů; nové zápisy tedy nevytvářejí task-level vazby na Oblast u úkolů v projektu, nezanechávají projekty a samostatné úkoly bez Oblasti (záložní Oblast) a Oblasti mají vždy `kind`. Dříve zdokumentovaná mezera („KNOWN GAP“: starý klient bez sync base smazal `kind`) je opravena a test přepsán.
- Klient: `migratePropertyRelations` už nevytváří `belongs_to_area` pro úkol v projektu, `create`/`relate`/Inbox triage/dávka/detail/stránka projektu/Quick Capture/událost kalendáře → úkol/přetažení dodržují model; Oblasti vznikají s `kind`.
- Odpověď PUT (opravený snímek) klient převezme; opravená relace se neposílá znovu (testy round trip s bází i bez ní).

**Zbývá před produkčním spuštěním aplikátoru (nic z toho tato iterace nedělá):**
- Výslovné schválení vlastníkem projektu.
- Provozní postup v tomto dokumentu (záloha, preflight nad offline kopií, zastavená služba, `--confirm`, ověření, rollback) nad skutečnými daty; po aplikaci nová device base klientů.
- Stará (legacy) porušení, kterých se nové zápisy nedotkly, řeší právě aplikátor; do jeho spuštění preflight správně hlásí `pending…` položky.
- Jsou dokončeny části 2b/2c a serverová autorizace Oblastí.
- Plná browser E2E sada jako release gate na přesný SHA nasazení (AGENTS.md). Pozn.: pomocné čištění ve specifikacích E2E (`e2e/helpers.ts` aj.) musí mazat i vazby smazaných záznamů, protože nové úkoly a projekty mají vazbu na Oblast.
