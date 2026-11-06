# UI-05c — Sjednocený detail projektu na desktopu

## Účel a izolace

Po dokončení prvních dvou částí desktopového shellu (#266 a #269) navazuje toto samostatné UI-05c na již dodanou mobilní projektovou stránku UI-05b. Je to pouze **opt-in preview** `NEXT_PUBLIC_LUMI_DESIGN_V1_PREVIEW=1`, bez zapnutí produkčních dat, migrace, změny autorizace nebo aktivace globálního cílového rozsahu `Vše`. Dřívější legacy stránka při vypnutém náhledu zachovává současné pořadí kontextu a svou dosavadní cestu změny stavu.

## Akceptace

- Desktopová projektová stránka začíná názvem a stavovým přehledem, pak **seznamem nedokončených úkolů**. Dlouhý kontext projektu následuje až **za úkoly** a je dosažitelný přes nativní otevření jednoho `details/summary`. Poznámky a další rozbalitelné údaje zůstávají na původních místech. Projektový postup je zobrazen **jen v detailu**, ne v řádku seznamu.
- Stejná existující komponenta `ProjectContext` se vykreslí právě jednou: v náhledu v rozbalení po úkolech, v legacy v hlavičce. Nenahrazuje se žádný datový a editační model kontextu, autosave ani konfliktní merge.
- **Dokončit / znovu otevřít projekt** na desktopu sdílí potvrzovací a blokovací cestu s mobilním preview. Nelze to při `all`, cizím workspace, probíhajícím zápisu, held-back stavu, lokálním/remote konfliktu nebo během jiné stavové akce. Potvrzení výslovně upozorní, že otevřené podřízené úkoly **zůstanou otevřené**; žádná kaskádová změna úkolů.
- Po potvrzení se před změnou stavu i smazáním znovu ověří workspace, held/unsent/konflikt a nezměněný záznam přímo v IndexedDB transakci. Zastaralé potvrzení skončí s `role=alert`; souběžná potvrzení jsou blokována. Testy pokrývají změny stavu, revize, workspace, konflikt i smazání během dialogu.
- Chyba synchronizace je zobrazena jako `role=alert`, nikoli tiché potvrzení. Původní akce v legacy bez v1 příznaku zůstává nezměněná; jiná oprávnění a serverové validace tím nevznikají.
- Na desktopu (`min-width:701px`) má `summary` minimální plochu 44px, viditelný fokus, otevřený stav, kontrastní popisek a respektuje omezení animací. CSS je scoped pouze na `data-project-detail-preview=lumi-v1`. Mobilní CSS UI-05b se nemění.

## Kontrola

Testy `tests/project-desktop-ui05c.test.mjs` ověřují pořadí JSX, jednu instanci kontextu, guard/confirm, pravdivý stav otevřených podřízených úkolů, data/ACL gate, dostupnost `summary` a izolaci legacy a mobile. Standardní PR Checks: typecheck, cílené testy, build na přesném commitu PR, review. Vizuální testování desktopu na Macu, klávesnice, VoiceOver a celé browser E2E jsou samostatnou povinnou bránou **před produkčním releasem**, nikoli součástí rutinního PR. Žádný release ani cutover v této iteraci.
