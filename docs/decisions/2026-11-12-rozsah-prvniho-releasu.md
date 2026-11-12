# Rozhodnutí vlastníka Lumi: rozsah prvního releasu cílového modelu

- **Datum:** 2026-11-12
- **Status:** schválené zúžení rozsahu a pořadí; **nejde o souhlas s cutoverem, resetem dat ani s produkční aktivací příznaků**
- **Navazuje na:** [čistý start](2026-10-26-cisty-start-d3.md), [Prostory / Oblasti / Můj plán](2026-10-23-prostory-oblasti-muj-plan.md)
- **Prováděcí plán:** [ROADMAP.md](../ROADMAP.md#cesta-k-prvnímu-releasu--2026-11-12)

## Proč

Revize stavu k `main` @ `c1f7862` (2026-11-12): za pět dní bylo sloučeno přibližně 100 PR (#296–#399), všechny výchozím nastavením vypnuté a žádný aktivovaný. Plná Browser E2E naposledy prošla 2026-10-23 na SHA z PR #101. Cílový režim po zapnutí není ucelený produkt (staré pohledy jen pro čtení, chybí vytvoření projektu a úkolu v projektu) a neexistuje produkční cílové úložiště. Všechny cílené browser testy cílové API mockují; žádný neprochází prohlížeč → skutečné route → skutečná SQLite se všemi příznaky najednou.

## Rozhodnutí

Vlastník 2026-11-12 schválil návrh revize („OK, začni“) v těchto bodech:

1. **Rozsah prvního releasu = jeden uživatel (vlastník) a soukromé Oblasti.** Sdílené Oblasti, pozvánky, role a vytváření ve Sdíleném prostoru se přesouvají do R5. Kontrakt [LUMI-FR-013](../PRODUCT.md#lumi-fr-013) se nemění, mění se jen pořadí dodání.
2. **HumanWiki H1-real je pozastaveno** do vyřešení [#400](https://github.com/Kocooour/AI-executive/issues/400) (nezávislý witness host, off-backup antirollback, durable source ACK). Do té doby žádné další HumanWiki PR.
3. **Staré pohledy Domů, Inbox a Dnes se v cílovém režimu v prvním releasu skryjí**, místo aby zůstaly jen pro čtení nad dosavadními daty. Jejich přenesení na cílová data následuje po releasu. Nahrazuje pro první release „možnost 1“ z 2026-11-09 ([R3-FE-04A](../R3-FE-04A-DETAILS.md)).
4. **Release 0:** nasadit `main` s vypnutými cílovými příznaky po úspěšné plné Browser E2E na přesném SHA, aby se ověřil nasazovací postup a odstranil drift nahromaděný od 2026-10-23.

Mimo první release zůstávají vypnuté a tím jej neblokují: web-push (host politika), provider route AI bundle, Attention nad cílovými daty, note-sync a všechny preview příznaky.

## Co se neschvaluje

- Žádné smazání, přepsání ani výměna databáze, lokálních kopií, záloh, přihlašovacích údajů či integrací.
- Žádné zapnutí cílových příznaků v produkci.
- Cutover (R4) vyžaduje **samostatný výslovný souhlas** s přesným rozsahem po inventuře a ověřené záloze s restore.

## K potvrzení

Body 1–4 jsou zapsané podle návrhu, na který vlastník odpověděl souhlasem bez výhrad. Bod 3 je produktová změna oproti rozhodnutí z 2026-11-09; pokud má platit původní varianta „jen pro čtení“, opraví se tento záznam i roadmapa před implementací skrytí (druhý PR milníku A).
