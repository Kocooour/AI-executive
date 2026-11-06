# UI-01d — Vrácení fokusu při návratu z detailu projektu

## Rozsah

Úzká pokračovací iterace UI-01 podle [roadmapy](ROADMAP.md): ovládání klávesnicí a VoiceOver při návratu z detailu projektu. Platí pouze pro již existující opt-in preview `NEXT_PUBLIC_LUMI_DESIGN_V1_PREVIEW=1`. Nemění typované adresy, historii, data, autorizaci, synchronizaci, ani produkční default-off brány.

- Po každém novém uživatelském otevření projektu vzniká samostatný neprůhledný token v `history.state` (nikoliv v URL). Token dostane také **původní záznam historie**, včetně seznamu projektů. Každý token vznikne náhodně v aktuálním běhu aplikace a je platný pouze při přítomnosti v paměťovém registru; osamocené či staré `history.state` po reloadu se ignoruje. K záznamu otevřeného projektu se připojí jeho původní token, konkrétní tlačítko otevření, ID projektu, původní adresa, původní otevřený projekt či seznam, pohled a prostor.
- Po tlačítku **Zpět** i skutečném browserovém **Back** vezme aplikace token **opouštěného** záznamu historie a ověří, že token **cílového** záznamu je přesně zachyceným původem (nestačí stejná URL). Obnoví fokus na původní tlačítko (nebo jeho znovu vykreslenou náhradu) až **po vykreslení cílového pohledu**. Funguje i projekt **A → B → Back na A → Back na seznam**: B vrací fokus na tlačítko B v sidebaru A, A až při druhém Back na původní tlačítko v seznamu. Následné Forward neobnovuje fokus z nesouvisejícího záznamu, opakovaný Back pracuje se stejnými uloženými vazbami. To platí i pro **A₁ → B → A₂ → Back → Back → Forward → Forward**, kde A₁ a A₂ mají shodnou URL, ale jinou identitu historie. Token je čistě lokální identifikátor historie, nikoliv oprávnění; nedochází ke změně URL ani použití časovače.
- Pokud původní projekt zmizel, už není v aktuálním prostoru, změnil se pohled/prostor nebo tlačítko není viditelné, fokus se **nenutí**. Otevření přímé kopírovatelné URL žádný cizí fokus nevytváří; ruční volba jiné záložky úmysl návratu ruší.
- Mobilní náhled a desktopový sidebar, stejně jako legacy řádky projektů, vystavují neprůhledné `data-project-open` k bezpečnému nalezení elementu. Identifikátory se nepoužívají jako ACL. Není nutný `CSS.escape` ani skládání selektoru s hodnotou ID.
- Regresní testy pokrývají cestu A → B → Back A → Back seznam, identické URL v různých záznamech A₁ → B → A₂ → Back → Back → Forward → Forward, opakovaný Back, identitu historie i adresu/pohled/prostor, zneplatněný token po reloadu, chybějící či nedostupný projekt, přímý odkaz, explicitní navigaci a jednotlivé otvírací prvky.

## Ověření

Standardní PR Checks: typecheck, cílené testy a produkční build na přesném HEAD. Skutečná klávesnice / VoiceOver, reload, popstate, mobilní viewport a regresní browser E2E jsou součástí brány před produkčním releasem. Žádný cutover ani povolení target R3 ACL.
