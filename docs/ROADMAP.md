# Lumi — aktuální roadmapa vývoje

**Aktualizováno 2026-10-28 po sloučení PR #141; #142 je ve vývoji.** Schválený směr: [čistý start cílového modelu](decisions/2026-10-26-cisty-start-d3.md) podle [LUMI-FR-013](PRODUCT.md#lumi-fr-013). Bez autorizace resetu stávajících dat. Tato roadmapa eviduje **skutečný stav implementace**, nikoli pouze existence knihoven nebo testovacích komponent.

## Aktuální pozice

**Pracujeme na R2 — identita, serverová autorizace, zápisy a bezpečná synchronizace.** Izolovaný model R1 je připravený pro staging; zatím **není zapojen do běžících API, UI ani produkční databáze**. Připravená D3 logika a navigace nejsou aktivované.

| Milník | Stav k 2026-10-27 | Výsledek / zbývající brána |
|---|---|---|
| **R0 — Změna strategie** | **Dokumentační rozhodnutí hotové** (#126) | Legacy migrace 2a–2c nejsou blokátorem čistého startu. Inventura skutečných dat, zařízení a integrací zůstává povinnou částí **R4 před cutoverem**. |
| **R1 — Izolovaný cílový datový model** | **Staging základ implementován** (#127–130) | Nový SQLite bootstrap, read-only kontrola konzistence, Area policy a `my-plan/personal/shared` task read model. Je to testovací vrstva, nikoli dokončená produkční integrace. |
| **R2 — Identity, ACL, zápisy a sync** | **Probíhá** (#131–141 sloučeny; #142 owner-only staging HTTP read ve vývoji) | Izolované staging čtení, task/policy revize a audit title write jsou v `main`. #142 zavádí jen opt-in owner-cookie GET soukromých úkolů; detail, HTTP zápisy, víceuživatelská identita, durable revokace, sync a user-scoped cache zůstávají otevřené. |
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
| [#139](https://github.com/Kocooour/AI-executive/pull/139) | **Sloučeno** | Autorizované ověření výsledku nejistého příkazu |
| [#140](https://github.com/Kocooour/AI-executive/pull/140) | **Sloučeno** | Monotónní task/policy CAS ve staging schema v2, ochrana proti ABA a opětovnému použití ID |
| [#141](https://github.com/Kocooour/AI-executive/pull/141) | **Sloučeno** | Staging schema v3: obsahově úsporný transakční audit title write a minimální retenční/kapacitní bariéra |
| **#142** | **Ve vývoji** | Opt-in owner-cookie HTTP GET seznamu osobních úkolů z izolovaného stagingu; bez detailu, zápisu, shared obsahu či produkční aktivace |

**Poznámka k receiptům od #139:** idempotence změny názvu je nově vázaná na kombinaci aktéra, úkolu a UUID příkazu. Příkazy pro jiné úkoly jsou nezávislé, zatímco změna payloadu se stejným UUID u stejného úkolu je konflikt. Staré actor-only receipty z #138 nejsou bezpečně převoditelné bez dohledání původního úkolu; jejich přítomnost vede k odmítnutí staging preflightu. Pro izolovaný testovací store je nutný nový bootstrap, nikoli migrace nebo reset produkčních dat.

Uvedená R2 implementace je **staging-only, process-local**. #142 používá skutečnou owner cookie pouze pro svůj explicitně povolený read-only HTTP seznam; interní krátkodobé staging sessions nejsou produkční víceuživatelskou session službou. Zelené CI samo o sobě neznamená aktivaci ani splnění produkčních ACL.

**Nový staging kontrakt (rozpracovaná iterace):** schema v2 přidává `tasks.revision` a `areas.policy_revision`. SQLite triggery zvyšují revize při změnách úkolu, přidání/odebrání člena a změně role, a to i při návratu hodnoty do původního stavu. `snapshotRevision` v interním preview nyní představuje SHA-256 konkrétního úkolu, jeho efektivní Oblasti, policy epochy a `restoreGeneration`; název vlastnosti zůstává pouze kvůli staging kompatibilitě. Nový kontrakt dovoluje nezávislé změny jiných úkolů, ale stále ověřuje aktuální ACL a revizi uvnitř `BEGIN IMMEDIATE`. Stará schema v1 se **automaticky nemigruje**: izolované staging databáze se znovu vytvoří; produkční data nejsou dotčena. Smazání úkolu je v tomto staging schématu dočasně zakázáno, aby se ID nemohlo znovu použít s revizí 0; odstranění tohoto omezení vyžaduje nejprve trvalé tombstony. Stále nejsou implementované trvalé multi-process revokace, dokončený auditní lifecycle ani sync.
 
**Navazující staging audit (schema v3, návrh):** Každá úspěšná změna názvu má ve stejné transakci obsahově úspornou auditní událost (aktér, úkol, efektivní Oblast a policy epoch, původní/nová revize, restore generace, čas a neprůhledný klíč příkazu; žádné texty názvů). Replay a no-op nevytváří další záznam; selhání auditního INSERTu vrací celý zápis. Izolovaný testovací store uplatňuje **prozatímní minimální 90denní ochranu před smazáním** a tvrdý limit 4096 událostí, při nasycení zápis bezpečně odmítne. Neprobíhá automatické mazání starých událostí, není schválena maximální produkční doba retence, archivace, export ani uživatelské čtení auditu. Staré staging schema v2 se nemigruje a vyžaduje nové testovací úložiště. Tato iterace neaudituje zamítnuté pokusy, přímé SQL úpravy ani budoucí Area/member operace.

## Nejbližší vývoj — skutečná kritická cesta

Neprodlužovat R2 sérií dalších samostatných diagnostických helperů bez vazby na fungující bezpečný vertikální tok. Další implementace mají přidávat **ověřitelnou funkční schopnost** a negativní testy, nejdřív na izolovaném stagingu, teprve potom ve skutečném runtime.

| Pořadí | Iterace | Požadovaný výsledek a brána |
|---|---|---|
| **1** | **PR #135 — hotovo** | Review i `PR Checks` dokončeny, sloučeno do `main` (`70558de6`). Předzápisový náhled zůstává staging-only a nezakládá právo provést mutaci. |
| **2** | **R2a — #137–141 sloučeny, staging pokračuje** | Transakční title write, idempotence, task/policy CAS a obsahově úsporný audit schema v3 jsou v `main`. Audit odmítnutých a dalších bezpečnostně významných operací, produkční retenční/exportní lifecycle a nezávislé bezpečnostní review stále chybí. Produkční aktivace není povolena. |
| **3** | **R2b — #142 první runtime read slice** | Owner cookie je svázána pouze s read-only `personal` staging seznamem za explicitním serverovým flagem; actor/Area/scope nelze dodat klientem. Další iterace musí řešit atomické personal-only detail/write ACL, skutečné per-user identity, durable revokaci a bezpečné chování ve více procesech. #142 není produkční multiuser připravenost. |
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

**Nejbližší práce: nezávisle zrevidovat #141 auditní zápis, dokončit auditní lifecycle a rozšířit #142 bezpečný owner-only HTTP tok bez otevření shared dat. Per-user identity, detail/zápis, sync a produkční cutover jsou samostatné brány.**
