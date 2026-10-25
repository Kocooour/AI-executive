# D2b, část 3 — soukromý souborový formát pro offline záchranu

**Stav: čistá knihovna a regresní testy, nikoli funkční export v UI ani migrace databáze.**
Navazuje na [kontrakt offline rekonsiliace](D2B-OFFLINE-RECOVERY.md) z PR #111; změna je záměrně izolovaná a musí být integrována až po bezpečném uzavření jeho review.

## Kontrakt

- `encodeOfflineRecoveryFile(bundle)` převezme již připravený balíček verze 1, znovu ověří jeho strukturu, SHA-256 a limity knihovny a vrátí **pouze** `Uint8Array` UTF-8 JSON. Nevytvoří soubor ani nestahuje data bez uživatele. Výchozí název `lumi-offline-recovery.json` neobsahuje názvy entit ani identitu.
- `decodeOfflineRecoveryFile(bytes, currentServer)` vyžaduje **aktuální serverový snapshot** včetně `restoreGeneration`; před dekódováním odmítne prázdný nebo nadlimitní soubor a neplatné bajty UTF-8. Import provede pouze `assessOfflineRecovery` (klasifikaci rizik a konfliktů); nikdy neprovádí replay/zápis.
- Limit `maxUtf8Bytes = 12 MiB` je skutečný limit **bajtů UTF-8**, navíc k limitům znaků/uzlů původního kontraktu. Příliš velký balíček se **nezkracuje**, odmítne se celý. Před destruktivní adopcí musí být lokální data zachována a uživateli musí být nabídnuta bezpečná náprava.
- SHA-256 je kontrolní součet proti náhodné změně, **není autentizace zdroje**. I správně přepočítaný hash musí projít validací struktury a přezkumem oprávnění k cílové Oblasti.
- Soubor obsahuje soukromé texty, poznámky i lokální metadata. Nesmí do logů, analytiky, AI, serverového úložiště, URL ani veřejného cache. UI nesmí zahájit stažení bez explicitního kroku vlastníka a musí upozornit na ochranu souboru.

## Blokátory skutečného D2b

1. **Pre-adoption freeze a export UI:** v `use-sync.ts` se nyní při restore stále volá destruktivní `adoptServerCopy()`. Před zavedením partition/restore-generation bump musí vzniknout fail-closed brána, která bezpečně zastaví všechny destruktivní cesty, zajistí stabilní snapshot napříč panely a umožní zkontrolovat a vědomě uložit soubor. Je nutné řešit poruchy úložiště, obnovení panelu i pozdní zápisy; existence tohoto kodeku sama nic nechrání.
2. **Rekonsiliace a ACL:** vlastník musí ručně přezkoumat položky, kolize ID, smazání a návrhy, a cílový workspace/Oblast musí autorizovat samostatná serverová vrstva. Žádný automatický replay ani tiché kopírování do Sdíleného prostoru.
3. **Serverová migrace:** transakční 2b runner, zálohování, rollback, schema mapping, restore-generation bump a následné autorizované načítání se tímto PR nezavádějí.

## Ověření

`tests/d2b-offline-recovery-file.test.mjs` pokrývá round-trip s multibajtovým UTF-8, byte/encoding limity, poškozený hash, rehashovaný strukturálně neplatný import, změněnou generaci, determinismus, neměnnost vstupů a zákaz automatického replaye.

Po push musí proběhnout PR Checks (**typecheck, jednotkové testy, build**). Celé browserové E2E se spouští až jako release gate před nasazením přesně určeného SHA `main`, nikdy pro tuto izolovanou PR iteraci.
