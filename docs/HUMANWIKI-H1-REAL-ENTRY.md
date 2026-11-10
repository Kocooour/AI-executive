# HumanWiki H1-real.0 — výchozí blokace vstupního importu

**Stav:** implementovaný `default-deny` kontrakt pro *budoucí* vstupní hranici, s **deny-only HTTP trasou**, bez čtení těla požadavku, uploadu, DB, importéru či produkčního zapnutí. Nejde o H1-real bootstrap ani o oprávnění nahrát skutečné exporty.

## Proč tato iterace

[Roadmapa](ROADMAP.md#řízení-iterací-a-exit-h1-synthetic--2026-11-09) uzavírá H1-synthetic a pro H1-real vyžaduje před vlastními daty **nezávislé autorizační, souhlasové, retenční, revokační a R3/R4 brány**. Další implementace nesmí implicitně považovat fiktivní tokeny z laboratoře za reálné autorizace. Připravujeme explicitní `default-deny` vstupní rozhraní, které žádný klientský bool, lokální tajný token ani proměnná prostředí neodemkne.

## Konkrétní výstup a kontrola

- **Serverové napojení:** `POST /api/humanwiki/import` (`app/api/humanwiki/import/route.ts`) je skutečná Next.js serverová trasa, která zavolá pouze blokovací funkci a vrátí obecné `404 Not found` s `Cache-Control: no-store`. Handler před odmítnutím nikdy nečte URL, hlavičky ani tělo, nepoužívá `request.json()`, `formData()`, `text()` či stream. Příznaky prostředí, klientská tvrzení o souhlasu ani podvržená identita žádný import nepovolí. **Nejde o upload API.** Next.js/runtime může přijmout části přenosu před vyvoláním handleru; testy prokazují nečtení v handleru, ne platformově nulové síťové bufferování.
- `lib/humanwiki-h1-real-entry.mjs`: `humanWikiH1RealEntryReadiness()` vrací **šest nesplněných** předpokladů, bez identity či obsahu. `denyHumanWikiH1RealImport(request, claims)` vždy vyhodí `HUMANWIKI_H1_REAL_IMPORT_BLOCKED`, a to **před** čtením jakékoli vlastnosti požadavku, obsahu, přílohy či tvrzení o souhlasu. Žádná `allow` větev neexistuje.
- `node scripts/humanwiki/h1-real-entry-cli.mjs`: **bez argumentů**, deterministicky vypíše jen jejich stav. Pokus předat cestu k exportu je odmítnut **před přístupem k souboru**. Nikam nezapisuje ani neodesílá data.
- `tests/humanwiki-h1-real-route.test.mjs`: čtyři route integrační regrese přímo volají skutečný serverový `POST(Request)`, ověřují `404`, nepoužitý `request.bodyUsed`, nezměněné tělo i při neplatném multipart/JSON, nulový přístup k nepřístupnému Proxy requestu a odmítnutí všech spoofed flagů.
- `tests/humanwiki-h1-real-entry.test.mjs`: přesně šest blokátorů, negativní testy s nepřístupným `Proxy` požadavku a souhlasu, pokus o zapnutí přes environment i klientem poskytnuté údaje, CLI bez argumentů/obsahu, žádné dočasné soubory.

**Reprodukovatelný akceptační krok této dílčí iterace:**

```bash
node --experimental-loader ./tests/ts-loader.mjs --test tests/humanwiki-h1-real-entry.test.mjs tests/humanwiki-h1-real-route.test.mjs
node scripts/humanwiki/h1-real-entry-cli.mjs
node scripts/humanwiki/h1-real-entry-cli.mjs /path/to/private-export.json # musí selhat bez čtení
```

Výsledek vždy `blocked_not_enabled`, `real_data_accepted=false`, `real_data_read=false`, `claims_created=0`, `external_model_egress=false`. Tento krok **není** úplná H1-real akceptace „export → návrh → lidská revize → Context Graph → autorizované citované zobrazení“.

## H1-real.1 — autentizovaný read-only náhled připravenosti (2026-11-10)

Nová serverová trasa `GET /api/humanwiki/readiness` vrací pouze seznam šesti **stále nesplněných** bran. Pro otevření vyžaduje současně:

- **`AI_EXECUTIVE_HUMANWIKI_READINESS_ENABLED=true`**, který je výchozím stavem vypnutý;
- skutečně nakonfigurovanou produkční autentizaci (existující `getAuthState`) a **podepsanou, neexpirovanou owner cookie**. Vývojový bypass `AI_EXECUTIVE_AUTH_ENABLED=false` je odmítnut; integrační token, tvrzení v hlavičkách o identitě ani uživatelem dodané `verified` nejsou autentizací;
- opakovanou kontrolu autentizace těsně před uvolněním výstupu. Nepřihlášeným, neověřeným, po rotaci session secretu a při neplatném nastavení se vrací pouze obecné `404`, nikdy seznam bran.

Povolený dotaz vrací `200` se `Cache-Control: no-store`, bez osobních identifikátorů, uložených souhlasů, hodnot Areas nebo jakéhokoli citlivého obsahu. **Kontrola cookie sama není ověření přístupu ke konkrétní Osobní Oblasti**; `real_actor_or_area_verified=false` a všech šest gate `not_verified_blocked` zůstávají nezměněny. Trasa nečte evidenci souhlasu, neprovádí revokaci, neimportuje a nic neukládá. Nejde o globální rozhodnutí o skutečné připravenosti ani o přepínač do režimu importu.

**Integrační akceptace:** `tests/humanwiki-h1-real-readiness-http.test.mjs` volá skutečný `GET` handler se správně podepsanou owner cookie a ověřuje `200 + šest blokátorů`. Bez flagu či cookie, s padělaným/expirujícím tokenem, po rotaci secretu, při chybějící konfiguraci, s podvrženými hlavičkami nebo se zapnutým dev-bypassem očekává `404`. Další test ukazuje, že ani autentizovaná odpověď `200` a falešný `AI_EXECUTIVE_HUMANWIKI_REAL_IMPORT_ENABLED=true` neodemknou původní deny-only `POST /api/humanwiki/import`: ten stále odpoví `404` bez přečtení těla.

**Další brána:** skutečný, transakčně konzistentní actor + Osobní Area ACL read a nezávislý source-specific consent/witness. Tato iterace tyto brány neplní a neopravňuje zpracovat reálný export.

## H1-real.2 — živá owner-private Area ACL, pouze preflight (2026-11-10)

**Integrační krok:** Nový serverový `GET /api/humanwiki/private-area-preflight` požaduje **skutečnou podepsanou owner cookie** (bez dev bypassu) a explicitně zapnuté `AI_EXECUTIVE_HUMANWIKI_PRIVATE_AREA_PREFLIGHT_ENABLED=true`; jinak vrátí obecné `404` bez soukromých dat. Výchozí stav je **vypnuto**. Identita a volená soukromá Oblast pocházejí **výhradně** z důvěryhodné serverové konfigurace `AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID` a `AI_EXECUTIVE_HUMANWIKI_PRIVATE_AREA_ID`, nikoli z URL, hlaviček či přání klienta.

`verifyHumanWikiOwnerPrivateAreaLive` používá již existující **pinned, read-only transakci nad živým staging SQLite** z `lib/target-staging-durable-session.ts`. Neověřuje hypotetický JSON ani fiktivní seznam: kontroluje skutečný databázový záznam identity, přesnou privátní Oblast v osobním workspace se shodným vlastníkem a `evaluateTargetAreaPolicy(...,permission:"read")`. Sdílí existující kontroly podkladového fd/inode, konfigurace restore generation, schématu, append-only žurnálu a rollback anchor. Při nedostupném či nesprávném úložišti, chybné generaci, jiné identitě, jiné Oblasti či selhaném ACL je odpověď **pouze obecné `404`**. Přístup k živé SQLite je omezován samostatným rate limiterem; před vypuštěním odpovědi se opakuje ověření cookie i konfigurace.

Pouze při úspěšném ověření vrací `200` a bez identifikátorů:
`result=owner_private_area_read_verified_for_preflight_only`, `actual_import_authorized=false`, `real_source_consent_verified=false`, `independent_revocation_witness_verified=false`, `h1_real_ready=false`, `claims_created=0`. **Jednorázový výsledek není autorizací importu ani trvalou zárukou pro následný zápis**; pozdější ingestace musí znovu atomicky ověřit živý actor/Area, souhlas, nezávislý revokační witness a CAS přímo při použití. Existující `POST /api/humanwiki/import` zůstává nedotčený, **vždy `404` před čtením těla**.

**Reprodukovatelná akceptace:**

```bash
node --experimental-loader ./tests/ts-loader.mjs --test tests/humanwiki-h1-real-private-area-preflight-http.test.mjs
```

Testy bootstrapují izolovanou dočasnou **reálnou staging SQLite** se skutečnou privátní Oblastí a validním staging anti-rollback žurnálem. Prověřují úspěch autentizovaného vlastníka, nevydání tajných ID, chybějící/expirující/podvrženou cookie, chybnou Oblast či vlastníka, nedostupný store či chybnou restore generation, dev bypass, falešné klientské claimy, nesprávné feature flagy a stálou blokaci importního POST. Produkční i původní legacy data se neotevírají ani nemění.

**Zbývající bezpečnostní brány:** Tento live preflight ověřuje pouze přístup k jedné konkrétní privátní staging Oblasti v okamžiku čtení. Neřeší reálnou evidence/retenci souhlasů pro ChatGPT a Claude, provázání zdrojových objektů s oblastmi, autorizaci v čase zápisu, monotónní revokaci nezávislou na obnově, citlivost, lidské review, CAS při použití, Context Graph ani R3/R4 release. Původních **šest H1-real gate zůstává `not_verified_blocked`**. Žádné právo importovat reálný obsah ani mail nevzniká.

## Šest bran vyžadovaných před první reálnou ingestací

| Brána | Důkaz, který musí být v budoucím H1-real skutečně ověřen na serveru |
| --- | --- |
| Identita + Osobní Oblast | Živý actor/session, ověřená owner-private Oblast, per-source ACL, session/Area/generation guard i při změně oprávnění v průběhu požadavku |
| Zdrojově specifický souhlas + retence | Explicitní doložené rozhodnutí pro konkrétní ChatGPT nebo Claude export, účel, rozsah, retenci, šifrovanou karanténu, limity velikosti, odmítnutí importu bez souhlasu |
| Speaker/provenance + sensitivity/review | Správná role mluvčího a citátu, nepropagovat výroky asistenta na fakta o uživateli, citlivost fail-closed, lidské schválení zvlášť od návrhu |
| Nezávislá revokace | Durable append-only revokační registry a autentizovaný high-water witness mimo recovery doménu, bezpečné chování při rollbacku, výpadku witness i ztraceném HMAC klíči |
| Atomické zápisy a odvozeniny | CAS při commit, obnovení a souběhu, odstranění nepovolené evidence, transakční invalidace cache/indexu/AI výstupu před autorizovaným vydáním |
| R3/R4 produkční brána | Integrované R3 bezpečnostní toky, samostatné schválení vlastníka, bezpečný release na přesném SHA včetně kompletní Browser E2E sítě |

Podklady: [rozhodnutí HumanWiki 2026-11-08](decisions/2026-11-08-humanwiki-knowledge-bootstrap.md), [technická architektura](ARCHITECTURE.md), [bezpečnostní matice R2d/R4](R2D-SECURITY-MATRIX.md).

## Co zůstává zakázané

- **Žádné upload, otevření, parsování nebo zpracování skutečných exportů ChatGPT/Claude** bez předešlých nezávislých gate a konkrétního souhlasu.
- **Gmail/iCloud obsah v H1-real není**. Metadata-only Gmail v4 neuděluje souhlas s těly ani s uchováním citované evidence. H3 vyžaduje samostatné rozhodnutí a změnu pravidel.
- **Žádné sdílení, Context Graph zápisy, klasifikace nebo volání externího modelu** z této funkce. Žádné tvrzení o úplném profilu, dokončené revokaci či reálném bezpečnostním svědkovi.
- Pozdější rozhraní pro skutečné ověření nesmí přebírat `verified` flagy od klienta jako důkaz; musí spojit vlastní serverovou autorizační kontrolu, evidenci specifického souhlasu, revokační registry a atomickou release bariéru. Teprve po samostatném bezpečnostním review a schválení vznikne případná povolovací větev.

**Další H1-real práce:** existující serverová trasa je záměrně **pouze zamítací**. Jakákoli její budoucí změna na upload/import vyžaduje skutečné serverové ověření identity a Area ACL, odděleně evidovaný zdrojově specifický souhlas, nezávislý revokační witness, transakční release guard a nové bezpečnostní review. Do jejich dokončení všechny reálné importy zůstávají zablokované; tato iterace sama tyto závislosti nesplnila.
