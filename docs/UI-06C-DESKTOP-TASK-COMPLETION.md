# UI-06c — Desktopový detail úkolu: jediné čtvercové dokončení

## Rozsah

Navazuje na již sloučené UI-06a/06b a na UI-01d. V opt-in design preview `NEXT_PUBLIC_LUMI_DESIGN_V1_PREVIEW=1` přenáší osvědčené chování mobilní hlavičky úkolu do desktopového inspektoru: **jeden čtvercový ovladač dokončení / znovuotevření přímo u názvu**. Samostatné původní tlačítko dokončení v rozbalených akcích se pro desktopový preview skryje, aby jedna akce nebyla nabídnuta dvakrát.

- Používá existující `LumiCompletionControl` a společné stavy: normální prázdný čtverec, oranžová/červená kontura pozornosti bez výplně, dokončeno tlumeně s fajfkou.
- V češtině i angličtině má ovladač výstižný přístupný název a `aria-pressed`; klikací oblast je 44 × 44 px. Dokončený název je méně výrazný.
- Stejný klientský guard jako v mobilním náhledu odmítne změnu při Vše/jiném prostoru, Fallback Area, čekající synchronizaci, konfliktu nebo aktivním pracovním bloku. **Nejde o autorizaci**; serverová Area ACL patří do R3/UI-09.
- Aktivní pracovní blok má zvláštní možnost ukončení; nedovolí obejít bezpečnostní stav běžným dokončením.
- Mobilní ovladač a pole jsou beze změny. Desktopový legacy detail bez preview zůstává beze změny. Nezasahuje do dat, synchronizace, URL, draftů ani příloh.

## Ověření

Nové cílené testy kontrolují jedinou akci, zdroj pravdivého stavu, částečné blokace a styly pro desktop/legacy. PR checks: typecheck, cílené testy a build. Browser klávesnice/VoiceOver a plné E2E zůstávají v předprodukční bráně.

## Oprava P2 — úvodní render při neznámé šířce

Do vyhodnocení `matchMedia` je `mobileViewport=null`, takže se nezobrazuje ani mobilní, ani desktopový preview checkbox. Původní nezabezpečená legacy akce dokončení se proto nesmí použít jako náhradní prvek: je nyní vykreslena **pouze při zcela vypnutém** `NEXT_PUBLIC_LUMI_DESIGN_V1_PREVIEW`, nikoliv podle dvou viewportových booleanů. Tím nelze při prvním renderu obejít preview guard pro prostor Vše, fallback, konflikty, čekající synchronizaci nebo pracovní blok. Testy kontrolují neznámou šířku, mobilní i desktopový preview a zachování vypnutého legacy režimu.
