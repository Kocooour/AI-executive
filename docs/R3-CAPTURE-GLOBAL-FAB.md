# R3-CAPTURE-3 — globální soukromý Quick Capture

**Milník:** [R3-CAPTURE](R3-CAPTURE-PRIVATE-AREAS.md), třetí a poslední plánovaný PR. **Základ:** otevřený [PR #380](https://github.com/Kocooour/AI-executive/pull/380) (R3-CAPTURE-2). Je to navazující feature větev a **není určena ke sloučení před #380**. Zůstává default-off.

## Akceptační krok

V opt-in Lumi v1 UI na telefonu (390 px) i desktopu (1280 px) vyvolá plovoucí **+** z kterékoliv hlavní obrazovky jediné vytvoření soukromé poznámky. Desktopová zkratka ⌘⇧. / Ctrl+Shift+. a tlačítko přímo uvnitř otevřeného cílového inspektoru používají stejný cíl. Inspektor se nejprve uzavře podle adresy/historie, teprve potom se otevře editor nové poznámky. Uživatel nejprve čerstvě načte serverem autorizované soukromé zapisovatelné Oblasti, jednu **výslovně** vybere, zadá název/text a odešle jediný idempotentní příkaz přes R3-CAPTURE-2. Po potvrzeném úspěchu se zobrazí autentizovaný Notes seznam načtený ze serveru. Pokud byl globální filtr čtení „Sdílené“, automaticky se viditelně přepne na „Osobní“, aby nová soukromá poznámka neležela mimo aktivní filtr; write Area a oprávnění to nemění. Žádná volba Oblasti není předvybraná.

- Cílový FAB se objeví jen při zapnutých všech stávajících Area read, Notes target scope, write/create/UI bránách a Lumi v1 shellu. Zvláštní produktový switch nenahrazuje ACL. **Vše**, **Osobní** a **Sdílené** jsou filtry čtení, nikoliv klientské právo k zápisu; skutečná volba cílové Oblasti zůstává privátní.
- Pokud zápis nemá důkaz dokončení, modal zobrazuje nejistý stav a existující runtime/barrier může pouze read-only ověřit receipt. Žádný nový command UUID, resend, legacy fallback, lokální insert ani automatické odblokování. Staging target mode nikdy neotevírá původní formulář pro legacy úkoly/poznámky.
- Escape / Zavřít / klik mimo vrátí fokus na původní tlačítko, nebo dostupný náhradní FAB. Klávesová zkratka je v textovém poli či při otevřeném modálu ignorována. Cílový inspektor má akci uvnitř vlastního fokusového dialogu, protože jeho modální past znemožňuje ovládat sidebar; globální FAB při otevřeném detailu zůstává skrytý. Při přechodu se nejprve uzavře detail, potom otevře editor; zrušení editoru vrací fokus na dostupný FAB.
- Offline, pagehide, visibilitychange a BFCache zneplatňují Area a mažou **neodeslaný privátní text** v paměti modal. Návrat vyžaduje nový autorizovaný read. Již odeslaný nepotvrzený příkaz zůstává zablokovaný přes reload a identitní generace až do pozitivního serverového potvrzení.
- Read-only Notes chooser se zapíná nezávisle i bez možnosti vytvořit, původní legacy Quick Capture se v režimu mimo cílové UI nemění. Žádná produkční aktivace ani reset.

## Ověření

Cílené `e2e/target-global-private-capture.spec.ts` na skutečném Lumi shellu a syntetickém HTTP pokrývá otevření z Kalendáře, fokus, jediný POST a serverový Notes refresh na 390/1280 px, klávesovou zkratku, klávesnicí ovládanou akci v otevřeném detailu, návrat s filtrem Sdílené, skutečný návrat mezi dokumenty (BFCache při dostupnosti, jinak čisté načtení), deterministické události BFCache `pagehide/pageshow.persisted`, ztrátu rozpracovaného textu při offline a nejistý POST + reload bez duplicit. Oddělený GitHub workflow `r3-global-private-capture-browser.yml` používá dočasnou instanci na portu 3123, syntetická data a žádné produkční připojení. Test není náhradou plné Browser E2E na **přesném release SHA** ani bezpečnostního review.

**Mimo rozsah:** úkoly, projekty, sdílený create, hlasové zadání, reálný import, R4 cutover a nasazení. Milník lze označit za dokončený až po review/integraci #380 + tohoto PR, cílené testovací akceptaci, vyřešených review nálezech a navazujícím rozhodnutí R3/R4.
