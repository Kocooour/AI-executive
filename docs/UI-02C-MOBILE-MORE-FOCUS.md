# UI-02c — Fokus po navigaci z mobilního „Více“

Navazuje na UI-01d/e a existující čtyřpoložkové mobilní menu Lumi Design v1.0.

## Problém
Dialog „Více“ dosud při každém zavření automaticky vrátil fokus na tlačítko „Více“. Po výběru jiné obrazovky tím klávesnice a čtečky obrazovky zůstaly v navigaci místo nově otevřeného obsahu.

## Chování
- Escape, tlačítko Zavřít, klepnutí mimo dialog a obyčejné zavření bez výběru: vrátit fokus na „Více“ jako dosud.
- Volba položky v „Více“: po dokončení navigace přesunout fokus na programově fokusovatelný nadpis h1 cílové obrazovky; nepřesouvat scroll při samotném fokusu.
- Před přesunem ověřit, že cílový pohled je stále aktuální, dialog nebyl znovu otevřen, existuje viditelný nadpis a jde o mobilní viewport. Po rychlém přepnutí jinam, ztrátě autentizovaného obsahu nebo návratu na desktop nekrást fokus.
- Záměr se spotřebuje právě jednou. Není uložen v perzistentní cache, URL ani synchronizován.
- Změna platí pouze při `NEXT_PUBLIC_LUMI_DESIGN_V1_PREVIEW=1`; legacy mobilní navigace stále vrací fokus na spouštěč.
- Žádná změna serverových dat, ACL, URL, historii, produkčního cutoveru ani příznaků R3.

## Testování
`tests/mobile-more-focus-ui02c.test.mjs` ověřuje rozhodovací větev a propojení callbacku. `e2e/mobile-navigation-v1.spec.ts` pokrývá skutečný focus po volbě i po Escape v opt-in Chromium testu. PR checks: `typecheck`, vybrané unit testy, build. Plná Browser E2E pouze před nasazením dle `AGENTS.md`.
