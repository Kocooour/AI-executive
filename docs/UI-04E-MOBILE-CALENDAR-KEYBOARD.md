# UI-04e — Klávesnice ve výběru dne mobilního kalendáře

Navazuje na schválený Lumi Design v1.0 a jednodenní mobilní kalendář. Změna je čistě opt-in přes `NEXT_PUBLIC_LUMI_DESIGN_V1_PREVIEW=1` a neaktivuje cílová staging data ani R3 oprávnění.

## Interakce
- Výběr dne má právě jednu zastávku klávesy Tab: aktuálně zvolenou datumovou bublinu; tlačítko **Dnes** je nadále samostatně dostupné.
- Šipka vlevo/vpravo přepne vybraný den o −1/+1; Page Up/Page Down o −7/+7 dní. Aktivní datum se znovu vykreslí a zůstane fokusované. Ostatní klávesy a modifikované zkratky fungují jako dříve.
- Každá bublina zachovává plné přístupné datum `aria-label`, stav `aria-pressed` a kontrakt vybrané/předchozí/pastelové barvy.
- Výpočty používají občanské dny, nikoli posun časových razítek o 24 hodin, proto přesuny fungují i přes DST či Nový rok.
- U mobilního kalendáře se nadále zobrazuje **právě jeden vybraný den**, navíc v naší vývojové větvi dostupný stávající jednodenní API read pro další dny. Nejde o cílový víceuživatelský filtr a nic se nezapisuje.

## Ověření
- `tests/mobile-calendar-day.test.mjs`: výběr dne, neobsluhované klávesy, změna času, hranice roku.
- `e2e/mobile-navigation-v1.spec.ts`: v preview Chromium ověří jeden Tab stop, souvislé soustředění fokusu a klávesové přesuny. Existující `Focused Lumi mobile More preview` path-scoped workflow spouští tento soubor s `NEXT_PUBLIC_LUMI_DESIGN_V1_PREVIEW=1`, takže test není skrytě přeskočen.
- Standardní `PR Checks`: typecheck, vybrané unit testy, build. Kompletní Browser E2E zůstává pouze před release.
