# UI-03f — Můj plán v desktopovém sidebaru (vývojový náhled)

Navazuje na schválené rozvržení Lumi Design v1.0 a UI-03e (desktop focus). Cílem je, aby desktopové menu nabízelo stejný srozumitelný vstup **Můj plán** jako iPhone. **Není to propojení cílové Area/ACL vrstvy ani R3 cutover**.

## Chování
- Jen při `NEXT_PUBLIC_LUMI_DESIGN_V1_PREVIEW=1` zobrazí desktop sidebar na prvním místě **Můj plán** s ikonou hvězdy. Původní **Dnes** zůstává samostatnou položkou s odlišnou ikonou; produkční sidebar nepřidává novou položku.
- Můj plán používá existující legacy Today data přes již dodaný `MyPlanPreview` UI režim. Na desktopu je **viditelně označen** jako vývojový náhled; nepředstírá serverové přiřazení ani globální `Vše`. Legacy `all` ani neautorizovaná sdílená data se nezpřístupňují novým filtrem.
- Klik na Můj plán přejde na adresu `?view=MyPlanPreview`; Dnes na `?view=Today`. V záhlaví je správné pojmenování a aktivní je vždy právě jedna položka. Obnovení stránky a Back/Forward obě trasy rozlišují i na desktopu.
- Klik na rozdílnou položku přenese fokus na viditelný nadpis podle UI-03e, a to i při přechodu Dnes ↔ Můj plán, kde se mění jen prezentační režim a nikoli podkladový interní pohled.
- Explicitní `?view=Today` se nikdy nezmění na Můj plán, a produkční default-off režim zůstává beze změny.

## Ověření
- `tests/mobile-navigation-v1.test.mjs` hlídá oddělené cíle a nezměněnou produkční navigaci.
- `e2e/mobile-navigation-v1.spec.ts` v cíleném preview Chromium ověřuje desktop 1280 px, správné aktivní položky, URL, upozornění, fokus nadpisu, reload a browser Back/Forward.
- Standardní PR Checks běží nad přesným integrovaným commitem; kompletní Browser E2E patří až do předprodukční release brány.
