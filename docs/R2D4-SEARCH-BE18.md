# R2d.4f / BE-18 — bounded response pro stagingové titulkové hledání

**Stav:** neaktivní, pouze bezpečnostní limit nad existujícím BE-16/BE-17 klientem a default-off HTTP BE-15. Beze změn API, SQLite, oprávnění či produkčního UI.

## Ochrana a kontrakt

`loadStagingTitleSearchPage` nyní čte úspěšnou JSON odpověď ze standardního `Response.body` po částech. **Limit 2 MiB se kontroluje na skutečně přijatých bajtech ještě před `JSON.parse`**, nikoliv až nad výsledným objektem. Při překročení toku zruší další čtení a vrátí `{ok:false,reason:"invalid-response"}`; nespouští retry. Limit je záměrně vyšší než legitimní stránka 50 názvů do 4 096 UTF-8 bajtů, a to i při přenosu escape sekvencí JSON.

- Pokud je přítomná hlavička `Content-Length`, musí obsahovat jedno kanonické nezáporné celé číslo v bezpečném rozsahu a nejvýše 2 MiB; jinak se odpověď odmítne a stream se zruší **před čtením těla**. Hlavička není autoritou skutečné délky: i menší deklarovaná velikost má druhou nezávislou kontrolu skutečně přijatých bajtů. Komprimované odpovědi nejsou automaticky považovány za platné na základě komprimované velikosti.
- Dekódování probíhá inkrementálně jako **striktní UTF-8** (`TextDecoder(fatal:true)`); neplatné sekvence se nesmějí nahradit znakem U+FFFD a zobrazit jako zdánlivě platný název. Výsledek dál prochází beze změn BE-16 allowlistem, scope/query kontrolou, binárním řazením a kontrolou cursoru.
- Chyba streamu, neúplné JSON, chybějící body, nadlimitní objem či neplatná délka = `invalid-response`; abort se dál vrací jako `aborted`. Na odmítnuté stránce BE-17 vyprázdní předchozí výsledky (fail closed), bez sdílené cache a bez automatického obnovování.
- Neplatí pro chybové HTTP odpovědi: status 401/403/409/429/503 se dál mapuje bez parsování jejich těla. Stávající `no-store` a `application/json` kontrola předchází čtení.

## Testy

`tests/target-staging-title-search-client.test.mjs` rozšiřuje BE-16 testy o JSON stream rozdělený přes vícebajtové znaky, legitimní velkou stránku s escapovaným textem, přetečení neomezeného streamu a jeho zrušení, podvržené `Content-Length`, neplatné UTF-8 a abort během čtení. BE-17 session regrese nad stejným transportem běží v PR Checks.

Bez deploye, nové flag aktivace, indexace obsahu poznámek, AI, UI, změny identity, data cutoveru či resetu dat. Browser E2E patří před produkční release na exact-SHA.
