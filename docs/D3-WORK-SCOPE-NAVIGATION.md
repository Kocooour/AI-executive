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
- **Regresní aktivační pojistka:** unit test prohledává soubory `app/` a `lib/` a odmítne import (i s příponou, side-effect, re-export a dynamický) či užití nového přepínače mimo jeho vlastní dva soubory. Až budou splněny brány aktuální clean-start roadmapy a serverový read-scope authorization gate, tento test se musí vědomě nahradit integračními testy. Nejde o serverovou bezpečnostní hranici.

## Brány před aktivací — aktuální clean-start varianta

Aktuální [roadmapa](ROADMAP.md) a [rozhodnutí 2026-10-26](decisions/2026-10-26-cisty-start-d3.md) **nahrazují původní povinnou sekvenci legacy migrací 2a–2c** při zvolení čistého úložiště. Funkční kontrakt komponenty se nemění.

1. Cílové Oblasti, dědění, soukromé Nezařazeno a nový assignee model musí být vytvořeny a prověřeny v izolovaném novém store. Bez přesouvání starých dat není podmínkou spuštění 2a aplikátoru, 2b legacy partition ani 2c owner backfillu.
2. Zavést autoritativní **server-side** identity a filtrované čtení i pro Home/Inbox/Today/Upcoming/Projects/Search/counts/attention/AI/notifikace. Žádný klientský `enabled` ani `readScope` není serverová autorizace. **Po otevření detailu sdíleného projektu se zobrazí všechny jeho oprávněné úkoly**, i když přehled Můj plán vybírá jen projekty s vlastním aktivním úkolem a ve výpisu filtruje pouze přidělenou práci.
3. Zápisy musí směřovat do explicitního `writeAreaId` a respektovat revize/role; staré `GET/PUT /api/store` snapshots a offline fronty nesmějí přepsat ani přenést obsah nového store. Revokace práv musí okamžitě blokovat serverový výdej **včetně attention, vyhledávání, indexu, počtů a nových notifikací/push doručení**, zneplatnit čekající doručení/subscriptions a při dalším spojení odstranit klientské cache. Dříve zobrazená oznámení na odpojených zařízeních nelze zpětně vymazat; payloady musí být proto minimalizované.
4. Teprve potom komponentu zapojit do desktopové i mobilní navigace. Home zůstane první obrazovka, Můj plán výchozí datový rozsah, Sdílené obsahuje i nepřidělené oprávněné úkoly. Reálné víceuživatelské pozvánky zatím zůstanou vypnuté do dokončení samostatných bezpečnostních podmínek.
5. Cílené scénáře: **320px iPhone, VoiceOver, zoom, klávesnice, URL, offline, více identit, konflikty a rušení oprávnění**; navíc plný obsah oprávněného sdíleného projektu v detailu i při rozsahu Můj plán a absence úniku přes attention/notifikace po revokaci. Plné Browser E2E pouze při release gate před produkčním deployem, nikoli při každém PR.
6. Žádné přepsání/smazání stávajícího provozního store bez **samostatného výslovného schválení**, inventury a ověřené archivní zálohy s plánem obnovy. Pouhá úprava roadmapy neschvaluje odstranění dat.

Při dodatečně schváleném **převodu starých dat** zůstává původní konzervativní postup 2a–2c relevantní; pro čistý start není podmínkou D3. Tato dokumentační změna **nespouští migraci, nezapíná komponentu ani sdílení**.

## Prostředí

Větev: `codex/d3-work-scope-switcher-prep-20261024`, výchozí `main` `5b20e7e72cc4a95bfea9b547aa455ed39d45e9ce`. Není zapotřebí server, preview, další pracovní kopie, port ani databáze; změna není zapojena do runtime. Případnou integrační větev připravit teprve společně s následnou aktivací po splnění aktuálních clean-start bran R1–R2 a všech relevantních bezpečnostních požadavků [roadmapy](ROADMAP.md); migrace 2a–2c je podmínkou pouze při zvlášť schváleném převodu legacy dat.
