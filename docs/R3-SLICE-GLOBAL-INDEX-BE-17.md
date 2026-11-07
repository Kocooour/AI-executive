# R3 / BE-17 — bezpečný řetězec explicitního stránkování globálního indexu

**Účel:** navázání na BE-16. Serverový staging GET `/api/target-staging/global-index` zůstává jedinou autoritou pro identitu, Area ACL, scope, revokaci a podepsaný kurzor. Nový **pouze paměťový, read-only** klientský kontrakt chrání skládání více než dvou explicitně vyžádaných stránek do `Vše / Osobní / Sdílené`. Nevydává `Můj plán` za `Vše`.

## API a bezpečnostní chování

- `beginGlobalIndexPageChain(result,{scope,limit})` přijme jen úspěšnou a znovu přesně validovanou první stránku (povolená pole/typy, bezpečné ID, UTF-8 BINARY pořadí, `limit` 1–100).
- `advanceGlobalIndexPageChain(previous,requestedCursor,result)` vyžaduje **právě ten podepsaný kurzor**, který předchozí stránka nabídla, správný scope a striktní navazující pořadí a unikátnost položek.
- Pamatuje všechny dosud vydané kurzory v daném **neperzistentním** řetězci. Třetí či pozdější stránka nesmí znovu vydat dřívější kurzor (cyklus A → B → A), ani zopakovat záznam, přehodit pořadí, přidat tajná pole, obejít limit nebo smíchat Osobní se Sdíleným.
- Při `401`, `409`, offline, abortu, chybě DTO či jiném odmítnutí vrací `null`, **nikoli částečně sestavený seznam**. Volající musí zahozený řetězec nepoužít a při změně identity, scope nebo odhlášení zahodit předchozí stav; bez nové autorizace nesmí zobrazit staré tituly. Do chainu se proto nikdy neposílají soukromé actor/Area/ACL parametry.
- Funkce samy nic nestahují, nepřednačítají, nezapisují, nereplikují a nikde nic necachují. Každý GET si musí výslovně vyžádat volající. `fetchGlobalIndexPage` z BE-16 zůstává samostatný `same-origin/no-store` transport.

## Regrese

`tests/target-staging-global-index-pagination-be17.test.mjs` ověřuje tři a více stránek, pořadí podle ID a typu, nepřímé opakování kurzoru, nesprávnou kontinuitu, duplicitní či nadlimitní položky, nepovolený scope, chybné DTO, 401/409/offline/abort bez částečných dat, neporušitelnost staré generace a **jeden explicitní GET na každou stránku**.

Staging-only, default OFF. Bez změn serverového endpointu, oprávnění, databáze, identity, zápisů, migrace, produkčního UI nebo nasazení. Zcela odlišný osobní `Můj plán` není tímto řetězcem aktivován. Celá Browser E2E je až release gate na přesném produkčním SHA.
