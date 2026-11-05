# Rozhodnutí vlastníka Lumi: revize UI 5. 11. 2026 a první vertikální řez

- **Datum:** 2026-11-05
- **Status:** schválené upřesnění Lumi Design v1.0 a změna pořadí implementace; **nejde o souhlas s produkčním cutoverem, resetem dat ani nasazením**
- **Navazuje na:** [Lumi Design v1.0](../UX-UI.md#lumi-design-v10--závazné-grafické-principy-schváleno-2026-11-04), [jednoduché obrazovky](../proposals/2026-11-jednoduche-obrazovky.md), [čistý start](2026-10-26-cisty-start-d3.md)
- **Podklad:** revize vývoje a návrh rozhraní pro telefon a desktop (lokální build `main` s `NEXT_PUBLIC_LUMI_DESIGN_V1_PREVIEW=1`, syntetická data)

## Rozhodnutí

1. **Ikona Návrhu Lumi je čtyřcípá jiskra (✦), nikoli hvězda.** Hvězda zůstává ikonou **Mého plánu** ve spodní navigaci a sidebaru. Ostatní pravidla Návrhu Lumi se nemění: fialová plocha/akcent, výslovný štítek „Návrh Lumi“, „Posoudit“, dopad a explicitní Schválit/Odmítnout.
2. **Přepínač světlého/tmavého motivu není v hlavičce.** Je v **Nastavení**; výchozí volba sleduje systém. Mobilní ani desktopová hlavička jej nezobrazuje.
3. **Quick Capture je plovoucí tlačítko (FAB) na telefonu i na desktopu**, ve fialovém akcentu Lumi v1. Na desktopu zůstávají v horní liště Hledání a Lumi Chat; Quick Capture je navíc dostupné klávesovou zkratkou. FAB nikdy nepřekrývá akce řádků, poslední položku seznamu, inspektor ani spodní navigaci (seznam má dolní odsazení) a je přístupný klávesnicí a čtečkou.
4. **Prvním vertikálním řezem je Můj plán pro jednu identitu**, upřednostněný před R2d.4 (Search/AI) a R2d.5 (attention/push): skutečné UI Mého plánu nad cílovými staging endpointy pro čtení dne, dokončení/obnovení, osobní „Kdy“ (dnes/zítra) a bezpečné Undo, včetně offline/pending/konfliktu a revokace.

## Hranice

- Bod 4 mění **pořadí** práce, nikoli bezpečnostní kontrakt. Řez běží **na stagingu a za výchozím vypnutím**; legacy UI zůstává výchozí. Aktivace v produkci patří do UI-09/R3 a R4 a vyžaduje všechny tamní brány: inventuru, ověřenou zálohu a restore, plnou Browser E2E na přesném SHA a **samostatný výslovný souhlas** s rozsahem cutoveru.
- Globální filtr Vše/Osobní/Sdílené, sdílení mezi více lidmi a pozvánky se tímto rozhodnutím neaktivují.
- R2d.4 a R2d.5 zůstávají povinné před UI-09; jsou jen zařazeny za první řez.

## Navazující práce

Doporučené pořadí UI práce z revize: runtime tokeny Lumi v1 → sdílený ovladač dokončení (čtverec/kruh) a řádek → Můj plán Dnes/Zítra se skupinami Oblastí → kalendář bez technických údajů → desktop shell → vertikální řez Můj plán. Pořadí platí jen mezi závislými iteracemi: desktop shell a serverová část vertikálního řezu mohou začít i být sloučeny nezávisle. Závislosti a paralelní proudy uvádí [ROADMAP](../ROADMAP.md#rozhodnutí-2026-11-05--revize-ui-a-první-vertikální-řez).
