# UI-06d — Jedno rozbalení sekundárních polí v desktopovém detailu úkolu

## Kontext a rozsah

Po UI-06a, UI-06b a UI-06c je desktopový detail úkolu ve vývojovém náhledu stále příliš dlouhý: nejprve nabízí seznam a řadu sekundárních vlastností. Tato změna přenáší **stejnou hierarchii jako mobilní náhled** na desktop a Mac.

- Viditelně a v pořadí klávesnice: primární Kdy/termín/projekt, poznámky a checklist; při aktivním pracovním bloku samostatná akce jeho dokončení; nakonec jediné tlačítko **Další vlastnosti**.
- Po rozbalení se zpřístupní seznam, priorita, čekání, časový odhad, připomenutí, opakování, historie, odložení a smazání. `aria-expanded` a `aria-controls` ukazují na skutečné tři skupiny s ID podle ID úkolu; cílová oblast tlačítka má alespoň 44 px.
- Složené sekce jsou **stále připojené v Reactu**, jen jsou vizuálně a z klávesového pořadí skryté pomocí `display: none`. Po přepnutí viewportu i při návratu zachovává React identitu a rozepsané hodnoty, namísto remountu formuláře. Po otevření jiného úkolu se rozbalení správně uzavře.
- Pořadí se mění skutečně v DOM, nikoli kosmetickým CSS `order`; čtečky obrazovky i Tab proto odpovídají zobrazení. Mobilní UI-06b a dosavadní desktopové UI s vypnutým preview zůstávají beze změny.
- Nezasahuje se do zápisů, oprávnění, synchronizace, přímých URL, objektových ID ani dokončení úkolu: čtvercový ovladač z UI-06c stále používá existující guard; nechráněné legacy dokončení je v preview vždy vypnuté.

## Brány

Funkce je pouze za `NEXT_PUBLIC_LUMI_DESIGN_V1_PREVIEW=1`, bez produkčního cutoveru, bez zapnutí R3/UI-09 Area ACL a bez migrace dat. Cílené PR testy ověřují DOM/tab pořadí, viditelnost skupin, `aria-expanded`, konzistentní stav rozbalení, neduplikované dokončení a desktop/mobile/legacy izolaci. Reálná klávesnice, VoiceOver a browser E2E zůstávají součástí předprodukční kontroly.
