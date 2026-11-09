# R3-FE-2 — Můj plán v hlavní aplikaci na cílových datech

**Stav:** default-off, bez produkční aktivace. Součást UI-09/R3 ([ROADMAP](ROADMAP.md)), navazuje na [R3-FE-1](R3-FE-01-CLIENT-RUNTIME.md). První obrazovka, která v hlavní aplikaci čte cílová (serverem autorizovaná) data.

## Příznaky

Cílový Můj plán se v hlavní aplikaci použije **pouze tehdy, když jsou všechny tyto proměnné přesně `"true"`** (čtou se při každém požadavku v `app/page.tsx` přes čistou funkci `targetUiConfig` v `lib/target-ui-config.ts`):

| Příznak | Význam |
| --- | --- |
| `AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED` | stagingové HTTP |
| `AI_EXECUTIVE_TARGET_UI_ENABLED` | klientský běh R3-FE-1 (provider) |
| `AI_EXECUTIVE_TARGET_UI_MY_PLAN_ENABLED` | **nový:** přepnutí pohledu Můj plán |
| `AI_EXECUTIVE_TARGET_STAGING_HTTP_MY_PLAN_DAY_ENABLED` | čtení dne |
| `AI_EXECUTIVE_TARGET_STAGING_HTTP_MY_PLAN_SLICE_ENABLED` | čtení plátku (seznam) |

Zápisové prvky jsou nezávislé a mají vlastní serverové brány jako stagingový náhled: stav / Undo `myPlanStagingWriteUiEnabled`, osobní „Kdy“ `myPlanStagingWhenUiEnabled`. Server stránky předá klientovi jen tři booleany `{myPlan:{enabled,statusWrite,whenWrite}}`; zápisy se zobrazí jen u zapnutého Můj plán. Zobrazení není oprávnění: endpointy dál samy vynucují relaci, Origin, ACL oblasti a CAS.

Chybí-li kterýkoli z prvních dvou příznaků, `app/page.tsx` se vykreslí jako dosud (bez provideru, bez konfigurace, bez nového požadavku). Provider (a s ním ověřování `/api/target-staging/session`) se připojí, jen když je cílový Můj plán skutečně zapnutý (všech pět příznaků). Je-li zapnutý jen R3-FE-1, nevzniká žádný provider ani požadavek, protože zatím nemá žádného konzumenta.

## Co se přepíná a co zůstává

- Přepíná se jen položka **Můj plán** ve v1 shellu (`NEXT_PUBLIC_LUMI_DESIGN_V1_PREVIEW=1`, pohled `Today` s aktivním „Můj plán“). Zobrazí osobní plán z cílových dat: vlastní soukromé úkoly a sdílené úkoly přiřazené uživateli (editor/admin), na serveru autorizované.
- Navigace, nadpis „Můj plán“, datum, Rychlý záchyt, Kalendář, Projekty a všechny ostatní pohledy zůstávají dosavadní.
- V cílovém režimu se nevykreslí dosavadní seznam Dnes, jeho přeřazení, souhrn „Dnes: n · Zítra: n“, pás události a patička; vývojová poznámka nově říká, že jde o serverový plán ze stagingu, nikoli o místní seznam.
- Seznam Mého plánu se z místních dat (IndexedDB) nesestavuje a tato obrazovka do nich nic nezapisuje. Hook `useLumiApp` ale dál běží beze změny pro celou aplikaci (včetně načtení místních dat), takže nejde o úplné odpojení legacy vrstvy.
- Klasický pohled „Dnes“ (bez aktivního náhledu Mého plánu v nové navigaci) zůstává dosavadní.
- Popisky navigace (spodní lišta i postranní panel) v cílovém režimu uvádějí „serverový plán ze stagingu“, ne „stávající data“.

## Struktura

- `app/ui/target-staging-my-plan-preview.tsx` — jediná implementace (čtení, stav, Kdy, Undo, vlastní skrytí při `hidden`/`offline`). Nové volitelné props `embedded` (bez `<main>`, `<h1>` a hlavičky; kořen je `<section>`) a `onRefusal`. Stagingová stránka `/target-staging/my-plan/preview` je beze změny.
- `app/ui/target-my-plan.tsx` — obálka pro hlavní aplikaci. Načítá se líně (`next/dynamic`, `ssr:false`) jen v cílovém režimu, takže při vypnutých příznacích se modul ani jeho CSS vůbec nestáhne.
- `lib/target-my-plan-embed.ts` — čistá brána `checking | signed_out | ready` z runtime.
- `app/ui/target-my-plan.css` — styly jen pro `.stagingMyPlanEmbedded` a `.targetMyPlanGate`; styly náhledu se přebírají z `preview.css`.

## Životní cyklus

1. Dokud runtime nemá serverem potvrzenou generaci (`known()`), neodešle se žádné čtení; během prvního ověření se zobrazí „Ověřuji přihlášení…“.
2. Výsledek posledního ověření (`runtime.lastOutcome()`, jen pro texty, nikdy pro rozhodnutí o přístupu) určuje stav bez dat: 5xx / síť / timeout → „Služba teď není dostupná“ se Zkusit znovu; 404 (funkce na serveru vypnutá) → „Serverový plán teď není zapnutý“; 401/403 nebo neznámá generace → taxonomie `signed_out`. Akce nikdy nenačítá stránku znovu: zavolá `runtime.refresh()`; skutečně ukončené přihlášení převezme přihlašovací obrazovka aplikace.
3. Plán je `key={generation}`: jakákoli změna generace (odhlášení v jiné záložce, přepnutí účtu, odvolání, přihlášení v téže záložce) plán odpojí; zahodí se všechny zobrazené úkoly, reference rozpracovaných příkazů i Undo. Po nové potvrzené generaci vznikne čistá instance.
4. Při 401/403 ze čtení či zápisu komponenta zavolá `runtime.reportRefusal("session_revoked")`. Rozpočet odmítnutí (nejvýš 2 za 60 s) brání smyčce odmítnutí → nové ověření → nové připojení, kdyby `/session` generaci potvrzovalo, ale čtení plánu ji odmítalo (rozjeté příznaky, závod s odvoláním, 403 z kontroly Origin u zápisu). Po vyčerpání zůstane plán skrytý se stavem „Server opakovaně odmítl zobrazit plán“, dokud uživatel nezvolí ověření, nebo dokud se generace nezmění zvenčí (přihlášení, přepnutí účtu).
5. Komponenta si ponechává vlastní, přísnější skrytí dat při `hidden`/`pagehide`/`offline` a vlastní kontrolu změny dne; runtime dělá nezávisle ověření generace při návratu na kartu.
6. Nic se neukládá do `localStorage`/`sessionStorage`/IndexedDB a neloguje se obsah odpovědí.

## Známá omezení a brány

- Zatím bez přepínačů Vše / Osobní / Sdílené v hlavní aplikaci (v hlavičce plánu zůstává stagingový filtr „Moje práce“).
- Bez událostí kalendáře, přesunu dne a offline fronty.
- Texty cílového plánu jsou dvojjazyčné (R3-FE-2b, rozhodnutí vlastníka 2026-11-09: „připrav i anglickou verzi“). Vložený plán sleduje jazyk aplikace (`language` z `useLumiApp`): `LumiAppRoot` → `TargetMyPlan` → `TargetStagingMyPlanPreview` a `TargetDataStatus`. Texty jsou v typovaných tabulkách `lib/target-my-plan-copy.ts` (cs/en se shodnou sadou klíčů, hlídá test) a `lib/target-client-errors.ts` (`mapTargetClientFailure(input, language="cs")`, `targetClientActionLabelsFor(language)`); data a časy se formátují `cs-CZ` / `en-GB`. Samostatná stagingová stránka (`/target-staging/my-plan/preview`) zůstává česky (výchozí jazyk). Anglické texty jsou klidné a krátké, bez technických id a stavových kódů; nejistý výsledek nikdy netvrdí úspěch ani selhání. Datový tok, rozpočet odmítnutí, brány, životní cyklus, skrývání a blokace zápisů se nemění.
- 403 z kontroly Origin u zápisu se zatím zobrazí jako ukončené přihlášení (data se skryjí a ověří znovu); bezpečné, ale nepřesné.
- Žádná produkční aktivace a žádný reset/přenos dat; to je samostatné rozhodnutí (R4) po záloze a ověřené obnově.
- Nový tok nenahrazuje nic bez příznaku; plná E2E sada zůstává vyhrazená pro předprodukční bránu.

## Testy

`tests/target-ui-config.test.mjs` (všechny kombinace příznaků), `tests/target-my-plan-embed.test.mjs` (brána runtime, změna generace, odhlášení, zdrojová zapojení při vypnutém i zapnutém příznaku), `tests/target-client-runtime-wiring.test.mjs` (aktualizováno) a stávající `tests/target-staging-my-plan-*.test.mjs`. Jsou součástí cíleného workflow `r2d-project-reads.yml`.
