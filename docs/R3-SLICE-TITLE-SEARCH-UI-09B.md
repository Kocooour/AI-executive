# R3 / UI-09b — izolovaný náhled hledání podle názvů

**Stav:** samostatná staging-only read-only adresa `/target-staging/title-search/preview`, bez odkazu v produkční navigaci. Nejde o zapnutí hledání v běžném Lumi, změnu cílových práv ani nahrazení Mého plánu globálním Vše. Navazuje na hotový BE-15 HTTP title-search a BE-16–20 transport/session kontrakt.

## Explicitní serverový opt-in

Všechny tři serverové příznaky musí mít **přesně** hodnotu `true`:

- `AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED`
- `AI_EXECUTIVE_TARGET_STAGING_HTTP_TITLE_SEARCH_ENABLED`
- `AI_EXECUTIVE_TARGET_STAGING_TITLE_SEARCH_CLIENT_PREVIEW_ENABLED`

Jinak stránka vrací 404. Tento PR příznaky nikde nenastavuje; `robots` zakazuje indexaci. Backend stále samostatně vynucuje live identity/session/Area ACL, `restoreGeneration`, aktuální revokaci a rate limit.

## Chování

- Uživatel zadá dotaz (2–80 znaků, nejvýše osm slov) a **výslovně** odešle formulář. Žádný autosuggest, debounce, prefetch, automatický retry nebo zápis. Data se nestahují při otevření stránky.
- `Vše / Osobní / Sdílené` přepíná pouze požadovaný **serverový** rozsah a ruší předchozí výsledky. Globální Vše zahrnuje dostupné autorizované položky, ne pouze úkoly osobního `Můj plán`.
- Zobrazí se pouze `kind`, `title` a soukromé/sdílené barevné rozlišení. Poznámky poskytují **jen název**, nikdy obsah. Interní `areaId`, `projectId`, identita ani role se nevypisují.
- Stránkování se děje pouze ručním kliknutím. Do výsledku dalšího live autorizovaného GET se **všechny staré titulky skryjí**. Klientský BE-17 session blokuje opakované/cyklické cursory, porušené řazení a paměť nad 1000 položek.
- Změna vstupu/rozsahu, hidden, `pagehide`, BFCache návrat, offline, opuštění okna a jeho opětovné zaměření zruší in-flight fetch, vynulují generaci i viditelný seznam. Při ztrátě fokusu se smaže i text dotazu. Obnova nebo online stav **nespouští** nový dotaz bez uživatele.
- Výsledky neukládat do lokálního úložiště, offline cache ani URL; žádná API změna, produkční cutover či migrace.

## Testovací postup

`node --experimental-loader ./tests/ts-loader.mjs --test tests/target-staging-title-search-ui09b.test.mjs tests/target-staging-title-search-session.test.mjs tests/target-staging-title-search-client.test.mjs` + standardní `PR Checks` (typecheck, cílené regrese, build). Browser E2E kompletní sady až na předprodukční release gate. Rozsah i status odpovídají současnému stagingovému modelu, nikoli produkční autoritě.

Samostatná větev `codex/ui09b-title-search-staging-preview`; žádný souběžný běžící worktree, port ani testovací databáze (GitHub-only změna). Případné manuální preview provozovat v izolovaném prostředí na portu 3001 s výhradně syntetickými daty a samostatným staging aktérem.
