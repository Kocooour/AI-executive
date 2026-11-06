# UI-01d — Vrácení fokusu při návratu z detailu projektu

## Rozsah

Úzká pokračovací iterace UI-01 podle [roadmapy](ROADMAP.md): ovládání klávesnicí a VoiceOver při návratu z detailu projektu. Platí pouze pro již existující opt-in preview `NEXT_PUBLIC_LUMI_DESIGN_V1_PREVIEW=1`. Nemění typované adresy, historii, data, autorizaci, synchronizaci, ani produkční default-off brány.

- Po uživatelském otevření projektu si aplikace v paměti poznamená konkrétní tlačítko otevření, ID projektu, aktuální pohled a prostor a zda šlo o sidebar či řádek seznamu.
- Po tlačítku **Zpět** i skutečném browserovém **Back** obnoví fokus na původní tlačítko (nebo jeho znovu vykreslenou náhradu) až **po vykreslení původního seznamu**. Nezávisí na textu projektu, URL `history.state` ani na časovači.
- Pokud původní projekt zmizel, už není v aktuálním prostoru, změnil se pohled/prostor nebo tlačítko není viditelné, fokus se **nenutí**. Otevření přímé kopírovatelné URL žádný cizí fokus nevytváří; ruční volba jiné záložky úmysl návratu ruší.
- Mobilní náhled a desktopový sidebar, stejně jako legacy řádky projektů, vystavují neprůhledné `data-project-open` k bezpečnému nalezení elementu. Identifikátory se nepoužívají jako ACL. Není nutný `CSS.escape` ani skládání selektoru s hodnotou ID.
- Regresní testy pokrývají původní pohled/prostor, chybějící či nedostupný projekt, přímý odkaz, explicitní navigaci a jednotlivé otvírací prvky.

## Ověření

Standardní PR Checks: typecheck, cílené testy a produkční build na přesném HEAD. Skutečná klávesnice / VoiceOver, reload, popstate, mobilní viewport a regresní browser E2E jsou součástí brány před produkčním releasem. Žádný cutover ani povolení target R3 ACL.
