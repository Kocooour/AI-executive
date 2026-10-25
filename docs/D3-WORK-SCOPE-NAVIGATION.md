# D3 — příprava přepínače Můj plán / Osobní / Sdílené

**Stav: pouze připravená UI komponenta, záměrně neaktivní.** Tato iterace nemění současný přepínač interních workspaces, domovský Home, dotazy do serveru, cache ani zápisy. Nejde o dokončení fáze D3 a tento krok nikoho nepřipojuje ke sdíleným datům.

## Dodáno

- `lib/work-scope-navigation.ts`: tři schválené čtecí rozsahy a klíče jejich popisků; interní `all` ani ID workspaces se nikdy nepovažují za rozsah UI.
- Popisky (CZ/EN) jsou v běžných textech aplikace `app/ui/copy.ts` (`workScopeGroup`, `workScopeMyPlan`, `workScopePersonal`, `workScopeShared`); komponenta dostává funkci `tr` aplikace, takže jazyk i přepínání jdou stejnou cestou jako zbytek UI.
- `app/ui/views/work-scope-switcher.tsx`: vstupní bod připraveného přepínače s `aria-pressed` a minimální výškou cíle 44 px. Při `enabled=false` nic nezobrazuje; **`enabled` je jen prezentační přepínač a nikdy autorizace**. Dosud není napojen do `Sidebar` ani `Topbar`.
- `app/ui/views/work-scope-switcher-controls.ts`: funkční React implementace HTML a kliknutí, umožňující přímé unit/component testy bez spuštění celé aplikace.
- Styly `.workScopeSwitcher` / `.workScopeOption` jsou podle konvence repozitáře v `app/lumi-navigation.css` (žádné CSS moduly); proměnná `--workspace-soft` je definovaná na `.appShell`, kam bude přepínač vložen.
- `tests/work-scope-navigation.test.mjs`: kontrola pořadí, výchozího rozsahu, odmítnutí legacy ID a popisků v obou jazycích v `copy.ts`.
- `tests/work-scope-switcher.test.mjs`: reálné server-side React vykreslení ovládacích prvků, jejich `aria-pressed` stavu, změn po kliknutí a no-op aktivní volby, `enabled=false`, nativních klávesnicových button sémantik a responsive/focus pravidel v `lumi-navigation.css`.
- **Regresní aktivační pojistka:** unit test prohledává soubory `app/` a `lib/` a odmítne import (i s příponou, side-effect, re-export a dynamický) či užití nového přepínače mimo jeho vlastní dva soubory. Až budou splněny brány 2a–2c a serverový read-scope authorization gate, tento test se musí vědomě nahradit integračními testy. Nejde o serverovou bezpečnostní hranici.

## Brány před aktivací

1. Sloučit **2a, část 4** (#109): zápisy klienta i serveru zachovávají normalizaci Oblastí. Bez ní by se normalizovaný stav po spuštění 2a postupně rozpadl.
2. Bezpečně dokončit a ověřit **2a normalizaci** na produkčních datech (`docs/D2A-AREA-APPLY.md`), ne pouze existenci CLI; předem mít ověřenou zálohu.
3. Dokončit **2b rozdělení legacy sdílených Oblastí** do interních workspace 1:1 včetně integrity vztahů a rollbacku.
4. Dokončit **2c atribut `assigneeUserId` a backfill** otevřených legacy sdílených úkolů jediného vlastníka. Porovnat Home/Today/Inbox před a po; nesmí zmizet žádný dosavadní úkol.
5. Zavést autoritativní **server-side** filtrované čtení a aktéra; klientský `selectScopedWork` v `lib/work-read-scope.ts` je jen pomocný read-model, ne ACL. Revokované položky nesmějí uniknout přes cache, vyhledávání, attention, notifikace ani počty.
6. Bezpečně oddělit `readScope` od `writeAreaId`. Z agregátu nevzniká právo zápisu; nové samostatné položky standardně do soukromého Nezařazeno.
7. Teprve potom napojit komponentu do desktopové a mobilní navigace, zachovat Home jako výchozí obrazovku, upravit Home/Inbox/Today/Upcoming/Projects/Search a při otevření detailu sdíleného projektu číst všechna oprávněná data.
8. Otestovat na reálném UI **320px iPhone, dynamické písmo/zoom a VoiceOver**, klávesnici, offline a URL navigaci, prázdné stavy, zachování ID a revizí, rušení oprávnění a více uživatelů. Současný PR ověřuje jen native button semantiku a responsive CSS kontrakt bez browseru. **Plná browser E2E** až těsně před nasazením jako release gate dle AGENTS.md.

Tyto brány jsou závazně popsané v `docs/ARCHITECTURE.md`, `docs/PRODUCT.md` a `docs/UX-UI.md`. Přidání přepínače bez nich by především mohlo zneviditelnit starší sdílené úkoly vlastníka a vyvolat nepravdivý pocit izolace dat.

## Prostředí

Větev: `codex/d3-work-scope-switcher-prep-20261024`, výchozí `main` `5b20e7e72cc4a95bfea9b547aa455ed39d45e9ce`. Není zapotřebí server, preview, další pracovní kopie, port ani databáze; změna není zapojena do runtime. Případnou integrační větev připravit teprve společně s následnou aktivací po branách 2a–2c.
