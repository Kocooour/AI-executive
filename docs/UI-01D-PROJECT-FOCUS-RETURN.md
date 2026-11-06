# UI-01d — Vrácení fokusu při návratu z detailu projektu

## Rozsah

Úzká pokračovací iterace UI-01 podle [roadmapy](ROADMAP.md): ovládání klávesnicí a VoiceOver při návratu z detailu projektu. Platí pouze pro již existující opt-in preview `NEXT_PUBLIC_LUMI_DESIGN_V1_PREVIEW=1`. Nemění typované adresy, historii, data, autorizaci, synchronizaci, ani produkční default-off brány.

- Po každém novém uživatelském otevření projektu vzniká samostatný neprůhledný token v `history.state` (nikoliv v URL). Ten v paměti odkazuje na konkrétní tlačítko otevření, ID projektu, původní adresu, původní otevřený projekt či seznam, pohled a prostor a zda šlo o sidebar či řádek seznamu.
- Po tlačítku **Zpět** i skutečném browserovém **Back** vezme aplikace token **opouštěného** záznamu historie a obnoví fokus na jeho původní tlačítko (nebo jeho znovu vykreslenou náhradu) až **po vykreslení cílového pohledu**. Funguje i projekt **A → B → Back na A → Back na seznam**: B vrací fokus na tlačítko B v sidebaru A, A až při druhém Back na původní tlačítko v seznamu. Následné Forward neobnovuje fokus z nesouvisejícího záznamu, opakovaný Back pracuje se stejnými uloženými vazbami. Token je čistě lokální identifikátor historie, nikoliv oprávnění; nedochází ke změně URL ani použití časovače.
- Pokud původní projekt zmizel, už není v aktuálním prostoru, změnil se pohled/prostor nebo tlačítko není viditelné, fokus se **nenutí**. Otevření přímé kopírovatelné URL žádný cizí fokus nevytváří; ruční volba jiné záložky úmysl návratu ruší.
- Mobilní náhled a desktopový sidebar, stejně jako legacy řádky projektů, vystavují neprůhledné `data-project-open` k bezpečnému nalezení elementu. Identifikátory se nepoužívají jako ACL. Není nutný `CSS.escape` ani skládání selektoru s hodnotou ID.
- Regresní testy pokrývají cestu A → B → Back A → Back seznam, Forward a opětovný Back, shodu původní adresy/pohledu/prostoru, chybějící či nedostupný projekt, přímý odkaz, explicitní navigaci a jednotlivé otvírací prvky.

## Ověření

Standardní PR Checks: typecheck, cílené testy a produkční build na přesném HEAD. Skutečná klávesnice / VoiceOver, reload, popstate, mobilní viewport a regresní browser E2E jsou součástí brány před produkčním releasem. Žádný cutover ani povolení target R3 ACL.
