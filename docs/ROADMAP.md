# Lumi — aktuální roadmapa vývoje

**Aktualizováno 2026-10-27 po sloučení PR #137–138.** Schválený směr: [čistý start cílového modelu](decisions/2026-10-26-cisty-start-d3.md) podle [LUMI-FR-013](PRODUCT.md#lumi-fr-013). Bez autorizace resetu stávajících dat. Tato roadmapa eviduje **skutečný stav implementace**, nikoli pouze existence knihoven nebo testovacích komponent.

## Aktuální pozice

**Pracujeme na R2 — identita, serverová autorizace, zápisy a bezpečná synchronizace.** Izolovaný model R1 je připravený pro staging; zatím **není zapojen do běžících API, UI ani produkční databáze**. Připravená D3 logika a navigace nejsou aktivované.

| Milník | Stav k 2026-10-27 | Výsledek / zbývající brána |
|---|---|---|
| **R0 — Změna strategie** | **Dokumentační rozhodnutí hotové** (#126) | Legacy migrace 2a–2c nejsou blokátorem čistého startu. Inventura skutečných dat, zařízení a integrací zůstává povinnou částí **R4 před cutoverem**. |
| **R1 — Izolovaný cílový datový model** | **Staging základ implementován** (#127–130) | Nový SQLite bootstrap, read-only kontrola konzistence, Area policy a `my-plan/personal/shared` task read model. Je to testovací vrstva, nikoli dokončená produkční integrace. |
| **R2 — Identity, ACL, zápisy a sync** | **Probíhá** (#131–138 sloučeny; další staging iterace v přípravě) | Autentizované izolované čtení, krátkodobé sessions/revokace, konzistentní stránkování, transakční změna názvu (#137) a trvalá potvrzení příkazů (#138) jsou v `main`, ale pouze pro staging. Chybí plnohodnotný audit, per-item revize, produkční identita, trvalá revokace, HTTP a sync protokol, user-scoped cache a širší read model. |
| **R3 — Aktivace D3** | **Připraveno, neaktivováno** | Čtecí selektor #103 a přepínač #108 existují, nejsou bezpečně propojené se serverovou aplikací. |
| **R4 — Cutover a release** | **Nespouštěno** | Vyžaduje dokončené bezpečnostní brány, inventuru, ověřenou archivní zálohu/restore a **samostatný výslovný souhlas** s přesným rozsahem případného resetu. |
| **R5 — Rozšířená spolupráce a asistence** | **Navazující vývoj** | Pozvánky, víceuživatelské sdílení a rozšířené integrace až po úplném identity/ACL/sync/revokačním kontraktu. |

### Ověřený postup na PR

| PR | Sloučeno / otevřeno | Co přineslo |
|---|---|---|
| [#126](https://github.com/Kocooour/AI-executive/pull/126) | Sloučeno | Rozhodnutí o čistém startu a první roadmapa |
| [#127](https://github.com/Kocooour/AI-executive/pull/127) – [#130](https://github.com/Kocooour/AI-executive/pull/130) | Sloučeno | Izolované SQLite schéma, bezpečnostní preflight, Area role a filtrování úkolů |
| [#131](https://github.com/Kocooour/AI-executive/pull/131) | Sloučeno | Ověřování aktéra při staging čtení |
| [#132](https://github.com/Kocooour/AI-executive/pull/132) | Sloučeno | Autorizované čtení nad validovaným privátním read-only SQLite snapshotem |
| [#133](https://github.com/Kocooour/AI-executive/pull/133) | Sloučeno | Dočasné staging sessions a okamžité lokální odvolání |
| [#134](https://github.com/Kocooour/AI-executive/pull/134) | Sloučeno | Session-bound stránkovací kurzory a detekce změn mezi stránkami |
| [#135](https://github.com/Kocooour/AI-executive/pull/135) | **Sloučeno** | Staging-only **read-only preflight** oprávnění a revize; nepovoluje ani neprovádí zápis |
| [#137](https://github.com/Kocooour/AI-executive/pull/137) | **Sloučeno** | První staging-only transakční změna názvu úkolu s aktuální ACL a revizí celého SQLite snapshotu |
| [#138](https://github.com/Kocooour/AI-executive/pull/138) | **Sloučeno** | Atomická, trvalá a podle aktéra oddělená potvrzení úspěšných příkazů, bezpečné replay/konflikty; limit 4096 na staging store |

**Poznámka k receiptům od #139:** idempotence změny názvu je nově vázaná na kombinaci aktéra, úkolu a UUID příkazu. Příkazy pro jiné úkoly jsou nezávislé, zatímco změna payloadu se stejným UUID u stejného úkolu je konflikt. Staré actor-only receipty z #138 nejsou bezpečně převoditelné bez dohledání původního úkolu; jejich přítomnost vede k odmítnutí staging preflightu. Pro izolovaný testovací store je nutný nový bootstrap, nikoli migrace nebo reset produkčních dat.\n\nUvedená R2 implementace je **staging-only, process-local**. Testovací vydávání session není napojeno na skutečné přihlášení, passkeys, produkční cookies ani víceprocesovou správu. Zelené CI samo o sobě neznamená aktivaci nebo splnění produkčních ACL.

## Nejbližší vývoj — skutečná kritická cesta

Neprodlužovat R2 sérií dalších samostatných diagnostických helperů bez vazby na fungující bezpečný vertikální tok. Další implementace mají přidávat **ověřitelnou funkční schopnost** a negativní testy, nejdřív na izolovaném stagingu, teprve potom ve skutečném runtime.

| Pořadí | Iterace | Požadovaný výsledek a brána |
|---|---|---|
| **1** | **PR #135 — hotovo** | Review i `PR Checks` dokončeny, sloučeno do `main` (`70558de6`). Předzápisový náhled zůstává staging-only a nezakládá právo provést mutaci. |
| **2** | **R2a — #137 a #138 sloučeny, staging pokračuje** | Staging transakční zápis (#137) a durable idempotence (#138) jsou sloučené. Následuje pouze interní, ACL-gated kontrola výsledku nejistého zápisu; pro úplné R2a zbývá skutečná per-item/policy revize a audit s retenčním kontraktem. CAS je zatím vůči SHA-256 **celého SQLite snapshotu**, nikoli úkolu. Preflight #135 není zapisovací capability. |
| **3** | **R2b — Runtime identita a serverové API** | Propojit skutečné serverem autentizované `userId` se čtením i příkazy. Žádný klientem dodaný aktér/Area jako důkaz oprávnění; role a členství vždy z autoritativního store. Navrhnout **durable revokaci a bezpečné chování ve více procesech** před produkčním použitím (dočasné session #133 nestačí). Testy přímého detailu, neoprávněného čtení a zápisu. |
| **4** | **R2c — Sync bariéra a cache** | Verzované per-item zápisy/tombstony místo legacy global `PUT`; staré full-snapshot klienty zablokovat **před mutací**. Oddělit IndexedDB/cache a osobní stav podle identity; řešit offline fronty, konflikty, revokaci, `restoreGeneration`, obnovu, index, attention a push. Starý obsah nesmí být znovu nahrán ani potichu zahozen. |
| **5** | **R2d — Kompletní autorizované čtení** | Rozšířit autorizaci na projekty, poznámky a vztahy i agregace **Home/Inbox/Today/Upcoming/Projects/Search/counts/attention/AI**; zakázat únik přes metadata, počty, notifikace, export a cache. Přesné aktivní projektové membership/assignee pravidlo pro Můj plán. |
| **6** | **R3 — Propojit D3 s UI** | Zapojit existující #103/#108 do desktopu a mobilu; Home zůstane úvodní obrazovkou a Můj plán výchozím **čtecím rozsahem**. Zápisy mají vždy jednu viditelnou cílovou Oblast; `Nezařazeno` je soukromé; sdílení vyžaduje souhlas. Ověřit 2–3 identity, mobil, klávesnici/VoiceOver a offline/revokační případy. |
| **7** | **R4 — Produkční připravenost a cutover** | Nejdřív inventura, recoverable archivní záloha a **otestovaný restore**, plán pro stávající klienty/integrační tajemství; teprve po **samostatném souhlasu vlastníka** přepnutí do nového úložiště. Produkční nasazení až po povinné plné Browser E2E release gate na **přesném SHA**. |

Iterace 2–5 lze rozdělit do menších reviewovatelných PR, ale jejich výsledek se má posuzovat podle konkrétních akceptačních scénářů, **ne podle počtu PR**. Staging helper není prod-ready endpoint; přepnutí `enabled` v UI není serverové oprávnění.

## Kritéria dokončení R2 před D3

- **Read/write bezpečnost:** neautorizovaný aktér nemůže číst ani upravit osobní či cizí sdílenou Oblast; viewer nezapisuje, editor/admin jen dle aktuálního členství, projektové děti vždy dědí Oblast.
- **Transakční konzistence:** souběžná změna oprávnění/revize/generace během zápisu vede k bezpečnému zamítnutí; opakování příkazu nezpůsobí dvojí změnu, audit a Undo neobejdou ACL.
- **Synchronizace a revokace:** starý snapshot/pozdní offline fronta nemění novou generaci, po revokaci nevytéká obsah ani přes cache či odvozené kanály; uživatelské profily oddělené. Offline ztracená práva nelze zpětně odebrat již zkopírovanému obsahu, ale server musí po připojení přístup odmítnout.
- **Funkční úplnost:** autorizované task/project/detail a Home/Today/Inbox/Upcoming/search výsledky jsou vzájemně konzistentní. `Můj plán` obsahuje soukromé a mně přidělené sdílené úkoly, `Sdílené` také nepřidělené oprávněné položky.
- **Testování:** syntetické 2–3 identity, pozitivní i negativní scénáře pro čtení/zápis/souběh/offline/revokaci, pravidelné `PR Checks`, nezávislé review. Celá Browser E2E sada **jen před nasazením** dle [AGENTS.md](../AGENTS.md).

## Co se nemění

- **D2a–D2c legacy migrace a historické backfilly nejsou na kritické cestě.** Dosavadní implementace/testy se nemažou; pokud se později objeví hodnotná data, rozhodne se o jejich konkrétním převodu samostatně.
- Připravovaný čistý model lze vytvářet a testovat pouze v **odděleném úložišti**. Žádná změna roadmapy ani merge PR nedává souhlas ke smazání/nahrazení aktuální produkční DB, účtů, mailu, kalendáře, tokenů či offline cache.
- Před případným resetem: explicitně schválený rozsah, ověřená archivní záloha, test obnovy, inventura zařízení a konektorů. Nespouštět pozvánky ani skutečné sdílení před bezpečnostními branami.
- Product contract: jen dva uživatelské prostory **Osobní / Sdílený**; tři čtecí rozsahy **Můj plán / Osobní / Sdílené**. Oblast je jediný organizační štítek a zdroj viditelnosti projektů a samostatných úkolů; žádný implicitní přechod do sdílení.

**Nejbližší práce: interní ověřování výsledku nejistého příkazu (staging-only), skutečná per-item/policy revize a auditovatelná historie; teprve potom R2b serverová identita/API. PR #137 a #138 jsou sloučené.**
