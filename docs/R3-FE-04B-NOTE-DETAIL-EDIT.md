# R3-FE-4b — autorizovaná editace poznámky v hlavním UI

**Stav:** navazující, default-off UI řez po sloučeném #357. Bez produkční aktivace nebo změny datového modelu. API `GET/PATCH /api/target-staging/notes/[noteId]/edit` už existuje v R2d; tento PR k němu pouze propojuje detail poznámky.

## Funkční tok

1. Uživatel v cílovém seznamu otevře serverově autorizovaný detail poznámky. Tlačítko **Upravit poznámku** se zobrazí pouze při povolené samostatné UI bráně.
2. Stisknutím začne nový serverový `GET /edit` pro konkrétní note ID. Server vrátí jen neobsahový `expectedRevision`, `writeAreaId` a `restoreGeneration` a pouze současnému writerovi. Viewer, cizí uživatel, revokovaný člen nebo chybné ID nedostane editaci.
3. Název a text lze změnit jako čistý text; obsah se nepersistuje lokálně, nepřechází přes legacy store ani browser storage. Validují se limity serverového writeru.
4. Uložení použije jeden `commandId` UUID a přesně token z posledního schváleného preflightu. Server pod zámkem znovu ověří identitu, Area práva, revizi a restore generation.
5. Po úspěchu se detail znovu načte přes autorizované serverové čtení. Konflikt 409 zachová viditelný koncept bez přepsání; uživatel může koncept zahodit a načíst aktuální data. Nejednoznačný výsledek (síťový výpadek, 5xx nebo nevalidní odpověď) **nikdy není prezentován jako úspěch**; jediná dostupná opakovaná akce používá nezměněný přesný příkaz a UUID.
6. Po odebrání přístupu/změně identity, skrytí stránky nebo offline se panel řídí existujícím R3-FE-4a suspend/revoke protokolem; nezachovává draft ani token mezi relacemi.

## Brány

Všech sedm musí být přesně `"true"`:

- `AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED`
- `AI_EXECUTIVE_TARGET_UI_ENABLED`
- `AI_EXECUTIVE_TARGET_UI_DETAILS_ENABLED`
- `AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_ENABLED`
- `AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED`
- `AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_WRITE_ENABLED`
- `AI_EXECUTIVE_TARGET_UI_NOTE_EDIT_ENABLED` (nový; default-off)

Navíc musí být dostupný autorizovaný cílový seznam poznámek a samotný detail. `Vše / Osobní / Sdílené` je filtr čtení, nikoli důkaz zápisových práv. Příznaky nikdy nezvyšují oprávnění.

## Není součástí

Quick Capture ani vytváření úkolů/projektů, změny termínů a dokončení projektů, offline write queue, Undo úprav poznámky, editace jiné entity, automatické sloučení souběžných změn nebo nasazení. UI nemá trvalou frontu a po ztrátě záložky nedokáže obnovit nejistý příkaz — tento limit je explicitní a musí se uzavřít před R3 release. Vytvoření soukromé poznámky řeší samostatně draft backend PR #361; tento UI PR na něm nezávisí.

## Validace

`tests/target-note-edit-ui.test.mjs`: default-off matice všech 7 bran, přísná kontrola serverového CAS preflightu a command DTO, odmítnutí cizích polí, hranice Unicode a velikosti, GET/PATCH request kontrakt, idempotentní replay a nulové falešné úspěchy při timeoutu či odmítnutí. PR CI zahrnuje typecheck, scoped testy a build; plná Browser E2E až před nasazením přesného release SHA.
