# Rozhodnutí vlastníka Lumi: těla poznámek pro AI, retence žurnálu a drobné produktové otázky R2d

- **Datum:** 2026-11-08
- **Status:** schválené rozhodnutí vlastníka (odpovědi na shrnutí R2d, otázky Q1–Q7); **nejde o souhlas s nasazením ani s produkční aktivací AI**
- **Navazuje na:** [R2D4-CONTEXT-BUNDLE.md](../R2D4-CONTEXT-BUNDLE.md), [R2D-NOTE-JOURNAL-RETENTION.md](../R2D-NOTE-JOURNAL-RETENTION.md), [R2D-SECURITY-MATRIX.md](../R2D-SECURITY-MATRIX.md)
- **Prováděcí plán:** [ROADMAP.md](../ROADMAP.md) (R2d.4j)

## Rozhodnutí

1. **Q6 — „ano“:** AI smí dostat **těla poznámek** (dosud jen názvy). Hledání AI (`find`) **nadále zahrnuje i dokončené úkoly** (dosavadní chování; zde se pouze zaznamenává jako vědomé rozhodnutí, nikoli nedostatek).
2. **Q7 — „OK“:** retence žurnálu poznámek zůstává **výchozích 30 dní, minimum 7 dní**. Retence auditu je odložena na R4.

### Další rozhodnutí (Q1–Q5, docs-only, bez změny kódu v R2d.4j)

- **Q1 — OK:** časové pásmo pro čtení Attention a lifecycle příkazy se bude brát ze **serverového profilu uživatele** (`personal_notification_settings.time_zone`), nikoli od klienta. **Implementováno v R2d.4k** (čtení Attention, lifecycle příkazy, AI balík; klient pásmo neposílá, odpověď ho jen vrací).
- **Q2 — OK:** zamítnutá (dismissed) položka `planned_date_passed` zůstává zamítnutá i po doplnění termínu (současné chování se zachovává).
- **Q3 — OK:** položky, které vzniknou během pozastaveného push, se po obnovení ohlásí, pokud stále platí (současné chování se zachovává).
- **Q4 — OK:** odezva registrace zařízení smí odlišit neznámý endpoint od endpointu patřícího jinému uživateli (přijaté riziko; zneužití vyžaduje znalost přesné adresy endpointu).
- **Q5 — OK:** před skutečným odesíláním web-push (R4) je **povinná allowlist hostů push služeb** (Apple/Google/Mozilla) jako ochrana před SSRF; zapsáno jako brána R4.

## Odůvodnění

- Bez těla poznámky nemůže asistent odpovídat na dotazy typu „co jsem si zapsal k…“; titulek sám nestačí.
- Dokončené úkoly jsou pro dohledání historie („kdy jsem to řešil“) užitečné; úkoly bez dokončených by AI zbytečně zužovaly.
- 30/7 dní je dostatečné okno pro offline klienty; klient pod podlahou stejně dělá úplný bootstrap Oblasti.
- Audit má vlastní požadavky na účel a rozsah uchování, které se řeší společně s produkčním cutoverem (R4).

## Důsledky pro implementaci

- Tělo poznámky se do balíku AI dostane **výhradně přes autorizované čtení poznámky** (`readAuthorizedTargetNote`) uvnitř téhož připnutého snapshotu jako hledání. Chybí-li čtení, nebo se liší Oblast, název či rodičovský projekt oproti řádku hledání, je celý balík `null` (fail-closed, nikdy částečný).
- Tělo cizí či nepřístupné poznámky se nikdy nevydá; viewer sdílené Oblasti dostane těla jen těch poznámek, které smí číst.
- Každé tělo je omezeno na 4096 bajtů UTF-8 (řez na hranici kódového bodu, příznak `bodyTruncated`); stále platí celkový strop 32 KiB.
- `what_matters` a `plan_today` zůstávají jen úkolové; úkoly a projekty tělo nemají.
- Revize balíku pokrývá vydaná těla; cizí aktivita revizi aktéra nemění. Guard data poznámky (id, revize poznámky a rodiče) jsou jen v interním `witness` pro budoucí živý guard a nikdy se nesériují.
- Retence žurnálu poznámek: výchozí 30 / minimum 7 dní potvrzeno; retence auditu je v R4.
- Beze změny HTTP, UI ani schématu; stále bez volání poskytovatele.
