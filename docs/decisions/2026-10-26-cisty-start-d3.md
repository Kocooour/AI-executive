# Rozhodnutí vlastníka Lumi: čistý start cílového modelu

- **Datum:** 2026-10-26
- **Status:** schválená změna implementační priority a strategie přechodu; **nejde o souhlas se smazáním dat ani nasazením**
- **Navazuje na:** [schválený model Prostory / Oblasti / Můj plán](2026-10-23-prostory-oblasti-muj-plan.md)
- **Prováděcí plán:** [ROADMAP.md](../ROADMAP.md)

## Rozhodnutí

Stávající obsah Lumi tvoří převážně testovací data bez podstatné hodnoty. Zachování všech legacy entit, historie, interních workspace ID a offline změn **není samo o sobě podmínkou dodání nové architektury**. Preferovaná cesta je **nové čisté úložiště s cílovým datovým modelem**, nikoli komplikovaná produkční migrace 2a–2c se zpětným přiřazením starých úkolů.

- Dosavadní implementace a testy 2a–2c zůstávají v repozitáři jako opakovaně využitelné diagnostické a bezpečnostní nástroje; další čistě legacy migrační PR nejsou na kritické cestě.
- Nezbytná je **validita nových zápisů**, oddělení dvou uživatelských prostorů, jedné Oblasti na projekt/samostatný úkol, dědění Oblasti projektovým úkolem, bezpečný soukromý výchozí stav, serverová ACL a správné řešitelství.
- Připravená D3 logika a přepínač (`#103`, `#108`) se mají využít, nikoli vytvářet znovu.
- Nový datový start **neruší** požadavky na revokaci práv, synchronizaci, ochranu lokálních kopií, audit, zálohy ani testy.

## Dvě oddělená schválení

1. **Toto rozhodnutí schvaluje změnu plánu a přípravu nedestruktivní implementace.**
2. **Neschvaluje vymazání, přepsání ani výměnu stávající databáze, lokálních zařízení, účetních/poštovních/kalendářových zdrojů, přihlašovacích údajů ani konfigurace.** Před jakýmkoli produkčním resetem je nutná inventura dat a integrací, konzistentní ověřená archivní záloha, ověřený postup obnovy, izolace starých klientů a **samostatný výslovný souhlas vlastníka s konkrétním rozsahem odstranění**.

Pokud se při inventuře ukáže důležitý obsah nebo závislost, nesmí být tiše zahozen: buď se cíleně převede po schválení, nebo se změní strategie. Mimo schválený rozsah zůstávají všechny ostatní provozní údaje a tajemství.

## Co se nemění

Produktový kontrakt [LUMI-FR-013](../PRODUCT.md#lumi-fr-013) zůstává: dva prostory **Osobní / Sdílený**, **Můj plán** je výchozí čtecí agregace (Home zůstává vstupní obrazovka), a **Oblast** je zároveň organizace i hranice oprávnění. Víceuživatelské pozvánky a sdílení se nespouštějí před ověřením identity, serverových oprávnění, per-item zápisů, revokace, individuálních stavů a obnovy.

Dřívější detailní plán zachování legacy dat 2a–2c v [ARCHITECTURE.md](../ARCHITECTURE.md) platí **jen při samostatně schválené cestě zachování dat**; není blokujícím předpokladem čistého startu.
