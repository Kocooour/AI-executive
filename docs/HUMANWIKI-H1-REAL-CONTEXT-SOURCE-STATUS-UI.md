# HumanWiki H1-real.9 — read-only status zdrojů v Kontextu

**Milník:** první skutečně uživatelem vyvolaný frontendový konzument H1-real.8. V existujícím **Více → Kontext** na iPhone i desktopu je výchozím nastavením skrytý oddělený panel „HumanWiki — stav zdrojů“ s tlačítkem **Ověřit stav zdrojů**. Po kliknutí používá **pouze** owner-authenticated `GET /api/humanwiki/source-witness-status`; nikdy nespouští import, nevydává source IDs, witness sekvenci či digest a nenahrazuje skutečnou HumanWiki wiki/ingest/review.

## Bezpečnostní hranice

- **Dva nezávislé, server-only opt-in flagy současně:** `AI_EXECUTIVE_HUMANWIKI_SOURCE_WITNESS_UI_ENABLED=true` **a** `AI_EXECUTIVE_HUMANWIKI_SOURCE_WITNESS_STATUS_ENABLED=true`. Chybí-li libovolný, komponenta není připojena do Context View ani nevydá HTTP požadavek; aplikace je beze změny. Backendová `GET` trasa zůstává výchozím nastavením 404 i při pokusu klienta obejít UI. Po přihlášení každou odpověď stále nezávisle ověřuje backend (owner cookie, soukromá Area, antirestore, podepsaný witness).
- Panel **nikdy nesbírá export**, neobsahuje souhlasové zaškrtávátko, tlačítko importovat, revokovat ani odeslat data. Zobrazuje jen dvě obecné kategorie zdrojů, jejich poslední **žádost** (žádná/odvolání/souhlas), revizi a jednu větu o tom, zda podepsaný witness prefix pokrývá **vlastní** události. Jména, adresa, emaily, obsah, interní IDs, globální witness backlog ani soukromé sekvence se v HTML nezobrazují.
- HTML jasně označuje: `withdrawal_requested` **není dokončené odvolání**, `grant_requested` **není platný souhlas** a pokrytí prefixem **není source-specific durable ACK, nezávislý witness recovery domain ani oprávnění importu**. Při chybě, 404, nevalidním/privilegovaném JSON či offline se nevydá „bezpečno“ ani předchozí citlivý stav, ale obecná nedostupnost.
- Žádné automatické volání při otevření Kontextu. Stahuje se až výslovným kliknutím; `credentials=same-origin`, `cache=no-store`, přijímají se pouze validní JSON s `cache-control: no-store` a všemi čtyřmi bezpečnostními booleany `false`. Pole navíc, cizí zdroj či statusy se odmítnou.
- Údaje žijí **jen v React memory**: žádný local/session storage, IndexedDB, konzolové logy či URL parametry. Při skrytí okna, `pagehide`, `offline`, `blur`, změně aktivního workspace, odchodu z Kontextu či unmountu se požadavek abortuje a UI status zahodí. Staré odpovědi se nepoužijí díky monotónnímu request epoch checku. Po opětovném návratu uživatel klikne znovu.
- Žádné nové mobilní menu ani pátá záložka; panel je v sekundárním **Kontextu** a zachovává schválenou navigaci. Česky i anglicky, běžné ovládání tlačítkem, stav `role=status/alert`.

## Reprodukovatelná akceptace

```sh
node --experimental-loader ./tests/ts-loader.mjs --test \
  tests/humanwiki-h1-real-context-status-ui.test.mjs
```

Testy: striktní parser přijme jen platný owner-only neautorizující výsledek; zamítá alternativní zdroje, privileged flagy, neznámé statusy, změněné revize, extra IDs/claims a podobné payloady. React SSR vykreslí **jen** tlačítko a vysvětlení, nikdy původní owner data. Integrační invariant přes source inspection vynucuje dvojitý server opt-in, připojení pouze na `view=Context`, workspace-key remount, abort/visibility/pagehide/offline a přenos bez cachování.

**Cílená skutečná browser akceptace v PR:** [Playwright scénáře](../e2e/humanwiki-context-source-status.spec.ts) montují skutečný React/Next UI na izolovaném syntetickém serveru, oba server-only opt-in příznaky jsou zapnuté **pouze** pro tento profil (`LUMI_HUMANWIKI_SOURCE_STATUS_E2E=true`). Odpovědi API jsou mockovány pomocí `page.route`, bez reálných osobních dat či witness hostu. Desktop: explicitní kliknutí → jediný GET + skutečný výsledek; 404 a privilegovaný/malformed JSON → obecná nedostupnost. Mobil (390 px): Více → Kontext → změna pohledu a návrat → stav smazán, žádné automatické znovunačtení. Pozdní odpověď po `blur`/abort, opuštění obrazovky i po odebrání přihlašovací cookie a reloadu nesmí obnovit údaje. Samostatný [workflow](../.github/workflows/humanwiki-context-source-status-browser.yml) spouští jen tento Playwright soubor, nikoli full Browser E2E.

```sh
LUMI_HUMANWIKI_SOURCE_STATUS_E2E=true NEXT_PUBLIC_LUMI_DESIGN_V1_PREVIEW=1 E2E_PORT=3124 pnpm exec playwright test e2e/humanwiki-context-source-status.spec.ts --project=desktop
```

**Zbývá před releasem:** příslušný **úspěšný** focused browser běh na přesném HEAD (dokud neběží / neprošel, PR není merge-ready), kompletní logout/login identity-switch v live stagingu, BFCache a VoiceOver; plný Browser E2E nad přesným SHA je až předprodukční release gate podle `AGENTS.md`. CI nepoužívá reálné exporty ani produkční witness.

## Co se tím nedokončuje

Tento PR nepovoluje reálnou ingestaci a neřeší konkrétní consent event → externí witness durable write-before-ack, obnovu po rollbacku, oddělení witness klíčů a backup domén ani retenci/odvolání odvozených claims. Status je pouze informativní preflight, nikoli HumanWiki workflow nebo dokončení H1-real. Produkční host, emailový obsah a osobní data zůstávají mimo rozsah.
