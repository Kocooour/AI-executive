# Lumi

**Lumi** je proaktivní osobní AI Executive / *chief of staff*. Pomáhá uživateli nezapomínat na závazky, soustředit se na to podstatné, sestavit realistický plán a bezpečně provádět schválené kroky.

**Remember → Attention → Plan → Act.** Základní pracovní paměť tvoří **Tasks / Projects / Areas / Notes / Relations**. Lumi je jednotná uživatelská vrstva nad těmito daty; není to jen seznam úkolů s dodatečným chatbotem. PACT (Projects / Agents / Context / Tools) je interní architektura.

## Závazná dokumentace

| Dokument | Co určuje |
|---|---|
| [Produktové zadání](docs/PRODUCT.md) | Vizi, uživatelské přínosy, funkční požadavky, proaktivitu, bezpečné akce, priority a produktovou roadmapu. |
| [Aktuální roadmapa](docs/ROADMAP.md) | Schválené pořadí dalších implementačních milníků R0–R5, clean-start přechod a bezpečnostní brány. |
| [UX/UI specifikace](docs/UX-UI.md) | Cílových 15 obrazovek, desktop/iPhone navigaci, hlavní interakce, přístupnost a akceptační kritéria. |
| [Technická architektura](docs/ARCHITECTURE.md) | Aktuální implementaci i cílové kontrakty: PACT, Context Graph, bezpečnost, integrace, provoz, zálohy a implementační plán. |

**Hierarchie:** produktové chování a priority určuje PRODUCT.md, interakce a obrazovky UX-UI.md, implementační a datové kontrakty ARCHITECTURE.md. Technický stav **není** důkazem dodání cílových funkcí. Pro konflikty či změny požadavků je nutné explicitní produktové rozhodnutí, nikoli tichá úprava implementace.

Další podklady: [postupy vývoje](docs/DEVELOPMENT.md), [vývojová pravidla](AGENTS.md), [bezpečnostní audit](SECURITY_AUDIT.md), [plán přechodu na systémový účet](docs/PRECHOD-SYSTEMOVY-UCET.md), [návrh zjednodušení UI (10/2026)](docs/proposals/2026-10-zjednoduseni-ui.md), [historická úplná specifikace před rozdělením](docs/archive/README-before-split-2026-10-14.md) (archiv, **není** aktuální source of truth).

## Stav produktu

Jde o lokálně orientovanou instalovatelnou PWA nad **Next.js, SQLite a Dexie**. Existuje jádro pro úkoly, projekty, workspaces, Quick Capture, některé části Context Graphu, serverově vyhodnocovanou Attention, plánování podle read-only ICS kalendáře, schvalované změny, audit/Undo a základní push notifikace.

**Zatím nejsou kompletně dodány** všechny cílové obrazovky, plnohodnotný chat přímo v aplikaci, kompletní Graph v2, všechny plánované proaktivní pravidla, pokročilé hlasové ovládání ani nové integrace účtů. Detaily rozlišující aktuální implementaci od cílového stavu jsou v [ARCHITECTURE.md](docs/ARCHITECTURE.md#current-mvp) a [PRODUCT.md](docs/PRODUCT.md#shipped-foundation-and-phased-delivery).

## Spuštění pro vývoj

```bash
pnpm install --frozen-lockfile
pnpm dev
```

Produkční proces běží jako vždy zapnutá Node.js služba. Postup, omezení a bezpečnostní kontrolní kroky viz [technická specifikace](docs/ARCHITECTURE.md#run) a [návod pro vývoj](docs/DEVELOPMENT.md).

## Pojmenování a kompatibilita

Uživatelský název produktu je **Lumi**. Název repozitáře a služby **AI-executive** a některé interní identifikátory či integrační cesty (např. `aifred`) zůstávají kvůli zpětné kompatibilitě stabilní. Změna dokumentace sama o sobě nemění funkčnost aplikace.

## Cílová sémantická paměť

Plánovaná varianta C přidává serverově lokální sémantické vyhledávání nad kanonickými poznámkami a Context Graphem; offline PWA hledá lexikálně v dříve synchronizovaných datech. Vektorový index bude obnovitelný derivát, nikoli druhý zdroj pravdy; SQLite zůstává kanonické úložiště. Nejde o přechod na PostgreSQL ani o paralelní provoz HumanAgentWiki. Podrobné produktové, UX a bezpečnostní hranice jsou v příslušných specifikacích.
