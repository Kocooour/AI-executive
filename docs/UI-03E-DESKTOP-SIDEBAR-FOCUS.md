# UI-03e — Přístupný fokus při desktopové navigaci

## Problém
Opt-in Lumi Design v1 desktop sidebar zůstává při výběru pohledu zafokusovaný v levé navigaci. Nově otevřený hlavní obsah není čtečce obrazovky ani klávesnici automaticky oznámen, přestože u mobilního dialogu Více se tato navigační chyba řeší v UI-02c.

## Kontrakt
- **Pouze vývojový náhled**, `NEXT_PUBLIC_LUMI_DESIGN_V1_PREVIEW=1`, a viewport nad 700 px; legacy UI a mobil zůstávají bez změn.
- Výslovné zvolení jiného pohledu v hlavní navigaci, přímo dostupném sekundárním seznamu nebo přes Nastavení na spodku sidebaru nejprve naviguje a uzavře detail; až po dokončeném přepnutí přesune fokus na programově fokusovatelný `h1` v obsahu.
- Nadpis musí být před fokusem viditelný pod sticky topbarem a nad spodním okrajem viewportu. Fokus sám nemá způsobit další neřízené scrollování.
- Vyhledávání, Back/Forward, navigace po projektu či otevření detailu nezakládají fokusový záměr. Když se přepne pohled, breakpoint nebo uživatel aktivuje jiný prvek, starý záměr nesmí fokus ukrást. Volba již aktivního pohledu nepřesouvá fokus.
- Jde jen o lokální UI stav. Žádná změna URL kontraktu, dat, ACL, produkčních příznaků, Workspace či R3.

## Testování
- `tests/desktop-sidebar-focus-ui03e.test.mjs`: chybějící/stale destination, mobil, legacy, nezávislý fokus uživatele, propojení UI.
- `e2e/mobile-navigation-v1.spec.ts`: cílené Chromium preview s 1280 px: hlavní, sekundární a spodní navigace, zachování fokusu ve vyhledávání a viditelnost nadpisu po přechodu z dlouhé posunuté obrazovky.
- Path-scoped workflow `Focused Lumi mobile More preview` testovací soubor spouští s aktivním příznakem v izolovaném prostředí. Standardní PR Checks vyžadují typecheck, relevantní unit testy a build; plná Browser E2E zůstává součástí release gate.
