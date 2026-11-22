# Rodina — export tří Airtable zdrojů před migrací

**Stav:** připravený read-only exportér, neprovedená produkční záloha a neprovedená migrace. Nová Airtable base `Rodina` již byla odděleně vytvořena se třemi tabulkami; až do úspěšné validace se do ní nekopírují historická osobní data. `Rekonstrukce Světice` se tohoto exportu netýká.

## Předpoklady

- Node.js 24 nebo novější, přístup k Airtable API a dostatek místa na lokálním **šifrovaném soukromém disku** (historický snapshot: 222 záznamů, 246 příloh, ~170,7 MiB; aktuální velikost a počet se mohou změnit).
- Osobní přístupový token Airtable s nejmenším oprávněním `data.records:read` k bázím Auto, Dokumenty a Nákupy. Nezapisujte token do repozitáře, textu PR, logů, Zkratek ani historie shellu.
- ID tří zdrojových bází jsou privátní konfigurace operátora; veřejný GitHub je **neobsahuje**. Nevyžaduje se žádný token pro zápis a nepoužívá se ID cílové base.
- Výstupní adresář musí být **nový**, existující adresář odmítnout; umístěte jej mimo checkout GitHub repozitáře. Výstup obsahuje reálné rodinné dokumenty a citlivé údaje.

## Spuštění

Po bezpečném nastavení proměnných prostředí `AIRTABLE_TOKEN`, `AIRTABLE_FAMILY_AUTO_BASE`, `AIRTABLE_FAMILY_DOCUMENTS_BASE` a `AIRTABLE_FAMILY_PURCHASES_BASE` spusťte:

```bash
node scripts/airtable-family-backup.mjs --output /private/encrypted-disk/rodina-backup-20261122
```

Skript načte všechny stránky tabulek `Auto/Události`, `Dokumenty/Dokumenty`, `Nákupy/Nákupy`, stáhne všechny jejich přílohy, ověří počet bajtů a vypočte SHA-256. Do manifestu nikdy nezapisuje časově omezené podepsané download URL. Přílohy ukládá pod jejich ověřená Airtable attachment ID (nikoli pod potenciálně nebezpečný původní název souboru). Výstupní soubory mají omezená lokální oprávnění.

Úspěch je určen **přítomností souboru `COMPLETE`**, který zaznamenává hash `manifest.json` a kontrolní počty. Při jakékoliv chybě skript končí neúspěchem a nemá `COMPLETE`; **částečná záloha není dovolena jako vstup migrace**. Pro nový pokus použijte nový prázdný adresář; příčinu selhání opravte, starou nekompletní složku pro audit uchovejte nebo bezpečně zlikvidujte až dle schválené retenční politiky.

## Brána před importem

1. Znovu zkontrolovat aktuální počty (snapshot 78/101/43 záznamů, 45/108/93 příloh), hash a binární velikosti všech originálů; při odchylce posoudit, zda vznikla nová data, nebo chybí soubor.
2. Zálohu **zkusmo obnovit** do izolovaného souborového adresáře, zkontrolovat manifest proti všem souborům a vybrané náhodné dokumenty otevřít. Pouhá značka `COMPLETE` bez testované obnovy není dostatečná.
3. Ověřit osobní přístup k nové base `Rodina` a rozsah sdílení historických rodinných dokumentů před rozšířením oprávnění.
4. Otestovat zvlášť přesun **nejméně tří příloh nad 5 MB**, které nejsou podporovány přímým Airtable Upload Attachment API; vyžaduje se alternativní bezpečný přenos a kontrola SHA-256. Nezpřístupňovat přílohy na neomezeně veřejných URL.
5. Před úplnou migrací ověřit aktuální zbývající Airtable Free kvótu **1 000 API volání na workspace/měsíc**, limit 1 000 záznamů a 1 GB příloh na base, a plán na synchronizaci delta změn. Airtable automatizace Free a Run a script nejsou backend pro OCR.
6. Rekonstrukce Světice zůstává nezávislá. Přepnutí Auto/Dokumenty/Nákupy na novou Rodina musí mít idempotentní mapování zdrojových ID, ověřené odkazy a explicitní rollback. Zdrojové báze se nemažou.

## Rozsah nástroje

Nástroj je **výhradně read-only exportér**. Neprovádí nahrání, OCR, změnu schématu, přístupových oprávnění ani přepnutí uživatelů v Airtable. Příloha >5 MB se při **čtení** zálohy nezmenšuje — omezení se týká až některých **cílových upload API**. Každé případné připojení k Lumi musí nadále vynucovat use-time ACL a PACT Context Resolver.

Pro ověření čistě syntetické logiky:

```bash
node --test tests/airtable-family-backup.test.mjs
```
