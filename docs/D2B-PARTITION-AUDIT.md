# D2b, část 1 — read-only audit rozdělení sdílených Oblastí

**Stav:** čistě diagnostické, **neprovádět na produkčním živém store**. Nová iterace nepřepisuje workspace, neprovádí normalizaci 2a, nezvyšuje restoreGeneration, neupravuje synchronizaci, nezavádí identitu dalších členů a **neaktivuje sdílení ani přepínač Můj plán**.

## Co teď existuje

- `lib/area-partition-audit.ts` — deterministická, bezdatabázová analýza; výstup obsahuje **počty, kódy rizik a SHA-256** kanonického snapshotu, nikoliv ID uživatele, Oblastí, úkolů nebo texty.
- `scripts/audit-area-partition.mjs` — **read-only** analýza konzistentní offline kopie SQLite se sdíleným readerem 2a. Čte `sqlite_master` a vypíše souhrn počtu řádků ve všech tabulkách; neznámé tabulky označí `unclassified-schema-table`. Nedotýká se produkční služby, nevolá `getDatabase` ani žádný zapisující příkaz.
- `tests/area-partition-audit.test.mjs` — testuje identitu zdroje, determinismus, meziarea vazby, chybějící oblasti poznámek, nevyřešené navázané tabulky, riziko neprovedené 2a a neměnnost obsahu offline SQLite.

## Použití pouze na offline kopii

```bash
node --experimental-loader ./tests/ts-loader.mjs \
  scripts/audit-area-partition.mjs --offline-copy /path/to/offline-copy/store.sqlite
```

Výstup je `status:"audit-only"`, `executable:false`, `sharingEnabled:false`. **Není** to manifest, který lze předat migračnímu aplikátoru. Čtení SQLite v režimu WAL může vytvořit prázdné soubory `-wal`/`-shm`; obsah store se nemění. Vždy použít konzistentní kopii ze zálohy (včetně WAL), ne živý soubor.

Kontrolované modelové vztahy: projekty a samostatné úkoly mají vlastní právě jednu Oblast, projektové úkoly a přímo zařazené poznámky dědí projektovou Oblast, samostatné poznámky potřebují jednoznačně určenou vlastní Oblast. **U poznámek se kromě relací zohledňují také legacy `properties.projectId` a `properties.areaId`**: shodné odkazy se vyhodnotí jako jeden cíl, různá projektová přiřazení nebo rozdílná Oblast poznámky a jejího projektu blokují audit (`ambiguous-note-project-membership`, `ambiguous-note-area-membership`, `project-note-area-disagrees`). Poznámku bez kanonické relace, která má platné legacy `areaId`, nelze chybně vykazovat jako nezařazenou. **Aktivní poznámka nesmí být přiřazena do archivované či jinak neaktivní Oblasti**, včetně oblasti zděděné přes projekt; audit ji označí `inactive-area-for-active-item`. Tyto kontroly jsou nezávislé na 2a preflightu, protože současný 2a planner routování poznámek nekontroluje.

Vazba mezi dvěma různými cílovými Oblastmi je `cross-area-relation`; bez explicitní bezpečné strategie ji nesmí budoucí migrace tiše zahodit. Zároveň se kontroluje, zda je 2a normalizace v dodané kopii dokončena; nedotčená historická data mohou vracet `2a-not-normalized`.

**Každý záznam v nekanonické tabulce stále potřebuje vlastní routing/invalidation rozhodnutí.** Počty `unmapped-side-table-rows` jsou předběžným signálem, nikoli důkazem, že konkrétní řádek patří do sdíleného workspace. Audit nesmí na základě nulového počtu automaticky považovat tabulku za schválenou. Schéma je klasifikováno podle `lib/backup-scope.ts`; nové tabulky jsou označeny. Nároky `attention_states`, `notification_deliveries`, `calendarDecisions`, event/task identity, email/context zdrojů, historie, příkazů a PACT zůstávají blokující, dokud neexistuje konkrétní mapa transformace/revokace a její testy.

## Co musí přijít před migrací 2b

1. Produkční aplikace a ověření **2a** po explicitním schválení, bezpečné záloze a offline preflightu.
2. Plná matice mapování legacy `workspaceId → areaId / nový workspaceId` pro všechny workspace-bound entity/relace/notes/claims/revize/indexy/attention/kalendáře/notifikace a tokeny; bez nejasností či cross-area hran.
3. Předmigrační **offline sync barrier**: atomické zvýšení `restoreGeneration`, odmítnutí starých PUT, možnost zachovat/exportovat lokální neodeslané změny a uživatelem kontrolovaná rekonsiliace. Nesmí vzniknout tichá ztráta offline front.
4. Auditovaný transakční aplikátor s bezpečnou zálohou, kontrolními součty a ověřenou vratností; migrace nesmí měnit kanonická ID úkolů, projektů ani poznámek.
5. Nezávislé bezpečnostní review a samostatný release gate s plnou browser E2E sadou **až před nasazením**. Fáze 2c a aktivace D3 jsou až za tímto postupem.

Žádná z výše uvedených podmínek není označena jako splněná pouze na základě `audit-only` výsledku. Pole `outstandingGates` je záměrně neodstranitelné a explicitně hlásí chybějící realizační práce.
