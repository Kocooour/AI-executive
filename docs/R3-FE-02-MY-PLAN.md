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

Chybí-li kterýkoli z prvních dvou příznaků, `app/page.tsx` se vykreslí jako dosud (bez provideru, bez konfigurace, bez nového požadavku). Je-li zapnutý jen R3-FE-1, provider běží, ale Můj plán zůstává dosavadní.

## Co se přepíná a co zůstává

- Přepíná se jen položka **Můj plán** ve v1 shellu (`NEXT_PUBLIC_LUMI_DESIGN_V1_PREVIEW=1`, pohled `Today` s aktivním „Můj plán“). Zobrazí osobní plán z cílových dat: vlastní soukromé úkoly a sdílené úkoly přiřazené uživateli (editor/admin), na serveru autorizované.
- Navigace, nadpis „Můj plán“, datum, Rychlý záchyt, Kalendář, Projekty a všechny ostatní pohledy zůstávají dosavadní.
- V cílovém režimu se nevykreslí dosavadní seznam Dnes, jeho přeřazení, souhrn „Dnes: n · Zítra: n“, pás události a patička; vývojová poznámka nově říká, že jde o serverový plán ze stagingu, nikoli o místní seznam.
- Místní data (IndexedDB) se pro tuto obrazovku nečtou ani nepíší; hook `useLumiApp` ale dál běží beze změny pro zbytek aplikace.

## Struktura

- `app/ui/target-staging-my-plan-preview.tsx` — jediná implementace (čtení, stav, Kdy, Undo, vlastní skrytí při `hidden`/`offline`). Nové volitelné props `embedded` (bez `<main>`, `<h1>` a hlavičky; kořen je `<section>`) a `onRefusal`. Stagingová stránka `/target-staging/my-plan/preview` je beze změny.
- `app/ui/target-my-plan.tsx` — obálka pro hlavní aplikaci. Načítá se líně (`next/dynamic`, `ssr:false`) jen v cílovém režimu, takže při vypnutých příznacích se modul ani jeho CSS vůbec nestáhne.
- `lib/target-my-plan-embed.ts` — čistá brána `checking | signed_out | ready` z runtime.
- `app/ui/target-my-plan.css` — styly jen pro `.stagingMyPlanEmbedded` a `.targetMyPlanGate`; styly náhledu se přebírají z `preview.css`.

## Životní cyklus

1. Dokud runtime nemá serverem potvrzenou generaci (`known()`), neodešle se žádné čtení; zobrazí se „Ověřuji přihlášení…“ s tlačítkem Zkusit znovu.
2. Odmítnutá / neznámá generace (odhlášení, odvolání, 401/403/404 z `/session`): komponenta `TargetDataStatus` (česká taxonomie, akce Přihlásit se) a žádná data.
3. Plán je `key={generation}`: jakákoli změna generace (odhlášení v jiné záložce, přepnutí účtu, odvolání, přihlášení v téže záložce) plán odpojí; zahodí se všechny zobrazené úkoly, reference rozpracovaných příkazů i Undo. Po nové potvrzené generaci vznikne čistá instance.
4. Při 401/403 ze čtení či zápisu komponenta zavolá `runtime.reportRefusal("session_revoked")`.
5. Komponenta si ponechává vlastní, přísnější skrytí dat při `hidden`/`pagehide`/`offline` a vlastní kontrolu změny dne; runtime dělá nezávisle ověření generace při návratu na kartu.
6. Nic se neukládá do `localStorage`/`sessionStorage`/IndexedDB a neloguje se obsah odpovědí.

## Známá omezení a brány

- Zatím bez přepínačů Vše / Osobní / Sdílené v hlavní aplikaci (v hlavičce plánu zůstává stagingový filtr „Moje práce“).
- Bez událostí kalendáře, přesunu dne a offline fronty.
- Žádná produkční aktivace a žádný reset/přenos dat; to je samostatné rozhodnutí (R4) po záloze a ověřené obnově.
- Nový tok nenahrazuje nic bez příznaku; plná E2E sada zůstává vyhrazená pro předprodukční bránu.

## Testy

`tests/target-ui-config.test.mjs` (všechny kombinace příznaků), `tests/target-my-plan-embed.test.mjs` (brána runtime, změna generace, odhlášení, zdrojová zapojení při vypnutém i zapnutém příznaku), `tests/target-client-runtime-wiring.test.mjs` (aktualizováno) a stávající `tests/target-staging-my-plan-*.test.mjs`. Jsou součástí cíleného workflow `r2d-project-reads.yml`.
