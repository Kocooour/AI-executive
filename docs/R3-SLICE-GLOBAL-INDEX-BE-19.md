# R3 / BE-19 — bezpečná suspend/resume brána globálního indexu

Navazuje na BE-16/17/18, pouze **opt-in in-memory** staging read-session klient. Nezapíná UI-09a, serverové příznaky ani produkční navigaci.

## Proč
Předchozí headless řadič BE-18 správně ruší čtení při změně autentizační generace, ale nemá samostatnou synchronní bránu pro `visibilitychange(hidden)`, `offline`, `pagehide` a BFCache. Pro UI je potřeba zahodit soukromé titulky a rozpracované GET **už při přechodu do neviditelného stavu**, bez záměny za odhlášení nebo přerušení aplikační relace.

## Kontrakt
- `suspend()` okamžitě vyprázdní interní stránkovací řetězec, zvýší request revision, abortuje aktivní GET a přepne snapshot na `{status:"suspended"}`; předchozí tituly a kurzory nejsou přístupné. Nezahájí síťový požadavek.
- `loadFirst()` i `loadMore()` po suspendu vracejí `not-ready` bez HTTP, dokud volající výslovně nezavolá `resume()`. V suspendovaném stavu ani přijatá pozdní odpověď nesmí obnovit předchozí stránku.
- `resume()` **neobnovuje data ani nenabízí staré kurzory**. Po nové kontrole stejné nesekretní auth-generace dovolí další **výslovný** `loadFirst()`, který vždy znovu projde serverovým actor/session/Area ACL a epoch guardem. `loadMore()` před prvním čerstvým GET není povoleno.
- Změna auth-generace je stále **terminální** pro stejnou instanci včetně A→B→A; `resume()` nesmí obživnout již zneplatněnou relaci. `dispose()` je terminální. Opakované suspend/resume nevydává požadavky.
- Volající musí synchronně zneplatnit **své** kopie vykreslených dat; headless řadič nemůže zpětně vymazat externí React state. UI-09a / PR #308 má vlastní lifecycle; tento PR jej nemění ani nenapojuje.

Šest izolovaných regresních testů ověřuje ztrátu titulů, neaktivní síť při suspend/resume, opožděné tělo při abortu před hlavičkami, zrušené pokračování, A→B→A, idempotenci a zneplatněný vstup. Dosavadních 13 scénářů BE-18 a transport BE-16/17 zůstává zachováno.

**Žádná změna backendového ACL, API, DB, serverových flags, produkčního UI, migrace, nasazení ani produkčních dat.** Celá browser E2E patří až před produkční nasazení na přesném SHA.
