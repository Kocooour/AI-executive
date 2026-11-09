# Lumi — rebaseline milníků a orientační časový odhad (9. 11. 2026)

**Stav ověřený proti `main` @ `fb53094` dne 9. 11. 2026 (Europe/Prague).** Tento dokument je **plánovací odhad**, nikoli příslib termínu, souhlas s produkční aktivací nebo potvrzení připravenosti k release. Nenahrazuje [ROADMAP](ROADMAP.md), [AGENTS.md](../AGENTS.md), [bezpečnostní matici](R2D-SECURITY-MATRIX.md) ani [HumanWiki rozhodnutí](decisions/2026-11-08-humanwiki-knowledge-bootstrap.md).

## Základna a otevřená práce

- **R1/R2d:** bezpečnostní a datové stagingové jádro implementováno; bez produkčního přepnutí.
- **R3:** [#341](https://github.com/Kocooour/AI-executive/pull/341), [#344](https://github.com/Kocooour/AI-executive/pull/344), [#352](https://github.com/Kocooour/AI-executive/pull/352) a [#357](https://github.com/Kocooour/AI-executive/pull/357) sloučeny: runtime, Můj plán, globální Vše/Osobní/Sdílené, autorizované detaily a navigace jsou **default-off**. [#361](https://github.com/Kocooour/AI-executive/pull/361) sloučen: serverový owner-private note-create, stále bez zapojení do Quick Capture. [#363](https://github.com/Kocooour/AI-executive/pull/363) (draft: detailní editace poznámky) a [#365](https://github.com/Kocooour/AI-executive/pull/365) (širší editace úkolů/poznámek) jsou **otevřené** a zasahují do šesti shodných souborů (shell, panel, CSS a testy). Zelené jednotlivé PR Checks **neprokazují integrovanou kompatibilitu**.
- **HumanWiki:** po deklarovaném uzavření H1-synthetic v [#355](https://github.com/Kocooour/AI-executive/pull/355) přibylo a bylo sloučeno dalších **pět čistě syntetických PR #358/#359/#360/#362/#364**. Výsledkem je stále fiktivní testovací laboratoř, bez reálných importů, potvrzených tvrzení, autorizovaného zdrojového registru nebo produkční wiki. To je procesní odchylka od [#356](https://github.com/Kocooour/AI-executive/pull/356); **zastavit další H1-synthetic-only iterace** bez explicitního rozhodnutí vlastníka o skutečném blokujícím bezpečnostním nálezu.
- **R4:** dosud nezahájeno; produkční cutover, audit/retence, reálný push host/SSRF/VAPID, archivní záloha + restore, přesné release-SHA Browser E2E a výslovné rozhodnutí vlastníka zůstávají samostatnými branami.

## Výsledkové milníky — pořadí a akceptace

| Priorita | Milník | Stav / další krok | Podmínka dokončení |
| --- | --- | --- | --- |
| P0 | **R3-FE-4: sjednocený autorizovaný detail a zápis** | **Probíhá.** Nejdřív integrovat/přehodnotit překryv #363 × #365 proti aktuálnímu `main`, zachovat unikátní negativní testy a CAS/uncertain/ACL vlastnosti. Neslučovat oba bez společného testu. | Průchod seznam → detail → oprava → zpět pro dohodnuté druhy; viewer, změna identity/Oblasti, konflikt, nejistý výsledek a revokace bez úniku či tichého zápisu. |
| P0 | **R3 integrovaná akceptace** | Po sjednocení editace doložit Quick Capture minimálně pro schválený rozsah (serverový private note-create ≠ hotové UI); rozhodnout, zda create úkolu/projektu patří do tohoto releasu, či bude s výslovným označením odloženo. Prověřit legacy background sync, offline a navigaci na jednom integrovaném headu. | Cílené integrační a negativní UI/HTTP testy v mobile i desktopu, identity/ACL/revocation, offline/retry/Undo tam, kde jsou podporované; zdokumentovaný release scope a žádná nenápadná legacy write cesta. |
| P0 | **R4 release readiness** | Po přijetí R3: inventura dat/zařízení/integrací, archivní záloha + **ověřený restore**, audit/retence, případné push a AI-live guardy dle aktivovaných funkcí, bezpečnostní review, deploy/rollback. | **Plné Browser E2E na přesném SHA**, zelené main regression, ověřené zabezpečení a **samostatný výslovný souhlas vlastníka** s konkrétním cutover/reset rozsahem. Teprve pak produkční release. |
| P1 / bezpečnostní závislosti | **HumanWiki H1-real — první skutečný owner-private bootstrap** | Zastavit další samostatné toy experimenty. Nejprve ověřit autentické formáty exportů **bez soukromých dat v neautorizovaném testu**, navrhnout consent/retention/quarantine/provenance/revokaci a propojit s existujícím Context Graphem. | Teprve po relevantních R3/R4 branách a zdrojově specifickém souhlasu: bezpečný opakovatelný import → návrh tvrzení → explicitní lidské review → soukromý kanonický zápis se zdrojem; skutečné revalidace/výmazy, nikoli toy flags. |
| P1 | **HumanWiki H2 — použitelná wiki** | Navazuje na H1-real. | Autorizované „Více → Kontext“, prohledávání, citace, historie a editace/revokace tvrzení; end-to-end test s reálným owner-private tokem až po souhlasu. |
| Později | **H3 Gmail/iCloud obsah, H4 průběžné učení, R5 spolupráce** | Nejsou součástí prvního R3/R4 releasu ani H1-real pilotu. | Nové oddělené rozhodnutí o mailové privacy policy, consent a retenci; nenazývat metadata-only konektor obsahovým importem. |

### Rozpočet PR podle pravidel #356

Milník „R3-FE-4 + integrované R3 QA“ má schválený výchozí rozpočet **1–3 PR**. #357 a #361 jsou již sloučené; #363 a #365 jsou dvě souběžné otevřené kandidátní větve a společně by znamenaly alespoň čtvrté sloučení před integrovanou QA. **Zastavit automatické rozšiřování série.** Dát přednost jednomu integrovanému výsledku zachovávajícímu testy z obou větví; pokud bude skutečně nutné překročit rozpočet, dokumentovat důvod a získat výslovné rozhodnutí vlastníka **před** dalšími diskrečními PR. Nedělit tutéž akceptaci na formální nové milníky pouze kvůli čítači.

H1-synthetic má přesah za uzavření; **žádná nová série bez rozhodnutí vlastníka**. Nový milník H1-real musí mít samostatnou funkční akceptaci, nejen další `rehearsal`/preview.

## Orientační harmonogram

**Předpoklady pro odhad:** soustředěná 1 efektivní implementační + review/QA kapacita (BE/FE lze paralelizovat jen mimo konfliktní soubory), dostupné testovací prostředí, promptní rozhodnutí vlastníka, žádná nová významná funkce a žádný blokující security nález. Časové intervaly jsou **pracovní dny**, termínová okna jsou **kalendářní odhady od 9. 11. 2026**, včetně víkendů a 17. 11.; intervaly se mohou překrývat, **nesčítají se mechanicky**.

| Etapa | Zbývající odhad | Orientační dokončení | Jistota |
| --- | --- | --- | --- |
| Konsolidace #363/#365, review a integrovaná editace R3-FE-4 | **3–6 pracovních dnů** | **13.–19. 11. 2026** | Střední: překryv šesti souborů a aktuální CI jsou známé, integrace neověřená |
| Dořešení R3 akceptace: Quick Capture scope, offline/revokace, legacy, mobile/desktop cílená QA | **6–12 pracovních dnů** po integraci / částečně souběžně | **25. 11.–8. 12. 2026** | Nízká až střední: neuzavřený create scope a skutečný integrovaný tok |
| R4 připravenost včetně backup/restore, audit/retence, bezpečnostní prověrky, přesného release E2E a souhlasu | **7–12 pracovních dnů** od připraveného R3 kandidáta, příprava dříve | **7.–23. 12. 2026** | Nízká: závisí na provozních branách a rozhodnutí vlastníka |
| **První ucelený release Lumi (cílové R3/R4 jádro)** | Souhrnný kalendářní odhad, nikoli slíbený release | **Základní scénář 14.–23. 12. 2026; optimisticky 7.–11. 12.; při blokerech leden 2027** | Nízká, do release gate pouze forecast |
| H1-real: první bezpečný import/review v owner-private pilotu | **10–20 pracovních dnů** po relevantních R3/R4/consent branách | **leden–únor 2027** | Nízká, formát skutečných exportů a revokační infrastruktura neověřeny |
| H2: první čitelná HumanWiki | **10–20 pracovních dnů** po H1-real pilotu | **únor–březen 2027** | Nízká, závisí na funkčním H1-real |

**Co není v termínech:** H3 obsah e-mailu, automatický import ChatGPT/Claude mimo export, R5 víceuživatelská spolupráce ani povolení produkčního resetu bez archivní zálohy. Tyto cíle se nedají odpovědně datovat bez samostatného scope/consent rozhodnutí.

**Kontrolní body:** po sjednocení #363/#365 přepočítat R3 zbývající práci; při výsledku R3 QA přepočítat R4; po první ověřené skutečné importní fixture (teprve bezpečně se souhlasem) aktualizovat H1-real/H2. Žádná práce neběží v produkci či na reálných exportech na základě samotného tohoto plánu.
