# UI-03b (desktop) — přístupný inspektor a aktuální navigace

## Rozsah

Navazuje na sloučenou první část desktopového shellu UI-03a (#266). Jde o další samostatný řez UI-03, **nikoli o souběžné R3-slice UI-03b pro staging Mého plánu**. Funkce jsou prezentací v existujícím desktopovém/mobilním `DetailPanel`, pod vypnutým `NEXT_PUBLIC_LUMI_DESIGN_V1_PREVIEW=1`. Není to aktivace cílových oprávnění, globálního `Vše` ani produkční změna.

## Chování

- **Escape:** Když je fokus v již otevřeném inspektoru, samotná dosud nezpracovaná klávesa `Escape` uzavře detail přes stávající `closeInspector()` (tedy i s historickým původem/Back a bezpečnou návratovou adresou). Nezasahuje do psaní v input/textarea/select/contenteditable, do IME nebo do již zpracované klávesy, modifikovaných kláves, otevřených modalit, Lumi Chatu, `More` či vnořených menu/listboxů. Není přidán globální listener ani nová cesta zápisu. Legacy mimo v1 zůstává beze změny.
- **Aktuální sekundární položka:** desktopový v1 sidebar používá u přímých cílů `aria-current="page"` a `data-nav-view`, stejně jako primární navigace. Vizualizace vychází z existujících barev aktivního prostoru, ne z barvy priority úkolu.
- **Aktuální projekt:** v plném seznamu aktivních projektů se právě otevřená **projektová stránka** zvýrazní a zpřístupní čtečce pomocí `aria-current="page"`. Rozhodnutí, který projekt je otevřený, vychází ze stávajícího `openProjectId` po kontrole místního workspace; `aria-current` samo o sobě neuděluje žádná oprávnění ani nerelaxuje serverovou validaci. Historické 7položkové legacy menu není změněno.
- **Jedna sdílená komponenta detailu:** `DetailPanel` stále zajišťuje detail úkolu a poznámky i na mobilu; nezavádí se duplicitní desktopová implementace ani druhý zdroj stavu. Inspektor zůstává nemodální vedle obsahu desktopu.

## Akceptace

`tests/desktop-inspector-ui03b.test.mjs` ověřují pozitivní Escape a negativní IME/modality/editor/modified/defaultPrevented scénáře, použití `closeInspector` bez obejití URL/back pravidel, v1-only `aria-current` a projektové stránkové ID, zachování legacy menu i beze změny základní navigace.

Před merge: `PR Checks` na přesném HEAD (typecheck, cílené testy, produkční build) a code review. Skutečná dostupnost fokusu/VoiceOver v prohlížeči na Macu a kompletní Browser E2E se ověřují před produkčním releasem; bez nich nelze deklarovat vizuální akceptaci. Žádný produkční deploy, release cutover ani reset dat.
