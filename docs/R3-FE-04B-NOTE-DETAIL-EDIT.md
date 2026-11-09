# R3-FE-4b — autorizovaná editace poznámky v hlavním UI

**Stav:** navazující, default-off UI řez po sloučeném #357. Bez produkční aktivace nebo změny datového modelu. API `GET/PATCH /api/target-staging/notes/[noteId]/edit` už existuje v R2d; tento PR k němu pouze propojuje detail poznámky.

## Funkční tok

1. Uživatel v cílovém seznamu otevře serverově autorizovaný detail poznámky. Tlačítko **Upravit poznámku** se zobrazí pouze při povolené samostatné UI bráně.
2. Stisknutím začne nový serverový `GET /edit` pro konkrétní note ID. Server vrátí jen neobsahový `expectedRevision`, `writeAreaId` a `restoreGeneration` a pouze současnému writerovi. Viewer, cizí uživatel, revokovaný člen nebo chybné ID nedostane editaci.
3. Název a text lze změnit jako čistý text; obsah se nepersistuje lokálně, nepřechází přes legacy store ani browser storage. Validují se limity serverového writeru.
4. Uložení použije jeden `commandId` UUID a přesně token z posledního schváleného preflightu. Server pod zámkem znovu ověří identitu, Area práva, revizi a restore generation.
5. Po úspěchu se detail znovu načte přes autorizované serverové čtení. Konflikt 409 zachová viditelný koncept bez přepsání; uživatel může koncept zahodit a načíst aktuální data. Nejednoznačný výsledek (síťový výpadek, 5xx nebo nevalidní odpověď) **nikdy není prezentován jako úspěch**; jediná dostupná opakovaná akce používá nezměněný přesný příkaz a UUID.
6. Při zavření detailu, přechodu jinam nebo skrytí stránky **nezanikne už odeslaný příkaz**. Klientský koordinátor jej uchovává pouze v paměti běžícího runtime, včetně původního UUID a CAS tokenu. Po návratu se nejprve znovu ověří přístup přes GET /edit; teprve poté lze koncept zobrazit a stejný příkaz zopakovat. Do konce probíhajícího požadavku nelze zahájit druhý zápis pro stejnou poznámku. Při změně identity/generace se paměť původní relace vyčistí.
7. Při odmítnutí GET /edit nebo PATCH se okamžitě skryje **celý dříve načtený detail**, nikoli pouze editor. Následuje nové serverové čtení; pokud se uživatel pouze změnil na viewer, může se mu poznámka znovu zobrazit v read-only režimu.
8. Po ztracené odpovědi a pasivním refetchi může být revize poznámky vyšší. To nesmí zabránit opakování **již odeslaného** commandId; lokální kontrola staré revize blokuje jen nový zápis.

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

Quick Capture ani vytváření úkolů/projektů, změny termínů a dokončení projektů, offline write queue, Undo úprav poznámky, editace jiné entity, automatické sloučení souběžných změn nebo nasazení. UI nemá trvalou frontu. Recovery funguje pouze přes navigaci uvnitř právě běžící aplikace (včetně hide/wake); po zavření celé záložky nebo reloadu procesu nelze nejistý příkaz obnovit — tento limit zůstává explicitní release gate pro R3. Vytvoření soukromé poznámky řeší samostatně draft backend PR #361; tento UI PR na něm nezávisí.

## Validace

`tests/target-note-edit-ui.test.mjs`: default-off matice všech 7 bran, přísná kontrola serverového CAS preflightu a command DTO, odmítnutí cizích polí, hranice Unicode a velikosti, GET/PATCH request kontrakt, idempotentní replay, runtime-scoped command recovery při zavření detailu a ztracené odpovědi, odmítnutí nového UUID dokud není starý příkaz vyřešen, okamžitou redakci při revokaci a nulové falešné úspěchy při timeoutu či odmítnutí. Doplňková sada: `tests/target-note-edit-recovery.test.mjs`. PR CI zahrnuje typecheck, scoped testy a build; plná Browser E2E až před nasazením přesného release SHA.

## Ošetření transportu a odhlášení (review follow-up)

- Jeden pokus o PATCH má **nejvýše 20 sekund** na dokončení. Po vypršení klient požadavek abortuje a **i když transport ignoruje abort**, uvolní uzamčený stav do `uncertain`. Výsledek se nikdy neprezentuje jako úspěch či jisté selhání zápisu. Následující pokus může opakovat pouze stejný `commandId` a přesně stejný payload; backendově kontrolovaný idempotentní receipt řeší commit se ztracenou odpovědí.
- Koordinátor je **registrován u skutečného target runtime** nezávisle na otevřeném detailu. Při změně auth generation, sign-out, reportRefusal nebo dispose jej runtime synchronně vyřadí; koordinátor abortuje pending transport, vymaže všechny uložené titulky, těla a CAS tokeny, odstraní listeners a nepřijme nové zápisy se starou generací. Pouhá navigace/hidden stránka sama příkaz nemaže.
- Ověřovací scénáře `tests/target-note-edit-recovery.test.mjs`: navždy zaseklý transport nereagující na abort, retry se stejným UUID, odmítnutí jiného příkazu, změna skutečného runtime bez otevřeného editoru, sign-out/dispose, nepovolení dispatch před revokací a ochrana před opožděným dokončením.
