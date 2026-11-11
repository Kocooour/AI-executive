# HumanWiki H1-real.5 — samostatná witness služba, monotónní checkpointy (draft)

**Akceptace této iterace:** na oddělené testovací instanci s reálným TLS handshake a skutečnou SQLite evidencí zapsat sekvenci 0 → 1 → 2, podepsat jen aktuální checkpoint pro čerstvou výzvu Lumi a přes restart zachovat posloupnost. Odmítnout nižší, přeskočenou a nekonzistentní sekvenci, záměnu podepisovacího klíče, změnu triggerů, chybějící DB a pokus o tiché opětovné založení. Služba není produkčně nasazená a test lokálně neprokazuje **nezávislost recovery domén**.

## Co je implementováno

- `services/humanwiki-witness/store.mjs`: samostatná soukromá SQLite na witness hostu (ne Lumi VPS), pevné instalační UUID a Ed25519 veřejný otisk v souboru `witness-installation.lock`. Instalace je **pouze jednorázová** pomocí `O_EXCL | O_NOFOLLOW`, soukromých práv a `fsync`. Po ztrátě samotné databáze instalační marker zabrání nové prázdné historii; při ztrátě celé witness recovery domény je potřeba nezávislý antirollback důkaz.
- Databáze obsahuje **jen globální sekvenci a neprůhledný digest** s předchozím digestem, ID registru, průběžným SHA-256 `chain_hash` a podpisem Ed25519. **Podepsaný aktuální `chain_hash` kryptograficky zahrnuje všechny předchozí události včetně podpisů**. Celý řetězec se při HTTP challenge streamuje po řádcích (paměť O(1), výpočet O(n) levných SHA-256 a jeden Ed25519 podpis); jakákoli záměna historického digestu nebo podpisu změní očekávaný finální hash. Offline publikace **nejprve ověřuje úplný SHA-256 řetězec od genesis až po podepsaný poslední řádek** uvnitř stejné SQLite `BEGIN IMMEDIATE` transakce a teprve poté přidává navazující podepsaný hash. Toto je záměrně O(n) práce na každý append (O(1) paměti, jeden Ed25519 verify) — bez nezávisle ukotveného auditního checkpointu nelze bezpečně potvrdit podpis po změně starší události jen z posledních dvou řádků. Výsledný nově podepsaný head se ještě ověřuje před `COMMIT`. **Pevný konec po 9 999 záznamech neexistuje**: bezpečná číselná hranice vychází z JS/SQLite integer, nikoliv z umělého limitu 10 000. Schema, všechny neinterní SQLite objekty a append-only UPDATE/DELETE triggery se kontrolují při otevření; interní prefix `sqlite_` se rozpoznává doslova, nikoli vzorem LIKE s wildcard `_`. Publikace vyžaduje další sekvenci právě o 1 a správný předchůdce. SQLite `BEGIN IMMEDIATE`, `synchronous=FULL`, `journal_mode=DELETE`, `COMMIT`; publikace je výhradně **offline operator-only**, ne anonymní HTTP write.
- `services/humanwiki-witness/server.mjs`: oddělený skutečný Node HTTPS server s pouze `POST /v1/humanwiki/high-water/challenge`, pevnou dvoupoložkovou žádostí `registryId,nonce`, max. 256 B request, globální 60/min rate limit a soukromým podpisovým klíčem. Odmítá query, obsah, cookies, Authorization, přesměrování i neznámé cesty. Při podpisu drží čtecí snapshot, aby nemohl vydat nekonzistentní mezistav. Vrací přesně šest polí stávajícího Lumi H1-real.4b protokolu a nevydává consent ani potvrzení revokace.
- `services/humanwiki-witness/operator.mjs`: offline administrátorský `bootstrap` nebo `publish SEQUENCE PREVIOUS_DIGEST DIGEST`, žádný HTTP zápis.

## Příprava **pouze nezávislého hostu**, nepouštět na Lumi VPS

Ve vlastnictví samostatné operační identity a **jiných záloh/recovery oblasti** musí správce vytvořit soukromý 0700 adresář, v odděleném bezpečném úložišti soukromý Ed25519 klíč (PEM) a privátní TLS key + cert, každý soubor v 0600 a vlastnictví stejného UID. **Žádný privátní klíč nikdy neukládat do GitHubu či aplikační konfigurace Lumi.** Witness server se připojí jen na `127.0.0.1`, k TLS portu na witness hostu přistupuje pouze nezávisle spravovaná reverzní proxy s platným DNS certifikátem a egress povolením pouze z Lumi. Úložiště nemá být žádným procesem Lumi zapisovatelné.

Pouze operator-only proces na witness hostu:

```bash
export HUMANWIKI_WITNESS_STORAGE_DIRECTORY=/srv/witness/private-ledger
export HUMANWIKI_WITNESS_REGISTRY_ID='<náhodné-uuid-v4>'
export HUMANWIKI_WITNESS_SIGNING_KEY_FILE=/srv/witness/private-ed25519.pem

# Pouze první instalace (při předchozí instalaci ani po ztrátě DB nevolat).
node services/humanwiki-witness/operator.mjs bootstrap

# Výlučně operátorem ověřená a již perzistentní další událost.
node services/humanwiki-witness/operator.mjs publish 1 \
  '<previous-64-hex-digest>' '<new-64-hex-digest>'

export HUMANWIKI_WITNESS_LISTEN_IP=127.0.0.1
export HUMANWIKI_WITNESS_LISTEN_PORT=9443
export HUMANWIKI_WITNESS_TLS_KEY_FILE=/srv/witness/private-tls-key.pem
export HUMANWIKI_WITNESS_TLS_CERT_FILE=/srv/witness/private-tls-cert.pem
node services/humanwiki-witness/server.mjs
```

`AI_EXECUTIVE_HUMANWIKI_WITNESS_PUBLIC_KEY_SPKI_B64URL` na Lumi musí být veřejný Ed25519/SPKI klíč tohoto svědka připnutý důvěryhodným operátorem (ne z HTTP, DNS, response). UUID a `https://` origin musí odpovídat konfiguraci H1-real.4b a vést přes důvěryhodnou TLS proxy.

## Testovací důkaz

```bash
node --experimental-loader ./tests/ts-loader.mjs --test \
  tests/humanwiki-h1-real-standalone-witness.test.mjs
```

Testy vytvoří reálnou dočasnou diskovou SQLite, **10 000 kryptograficky platných Ed25519 checkpointů připravených v testovací SQLite jednou transakcí a následný skutečný operator-only zápis checkpointu 10 001** (překročení bývalého limitu), ověří kontinuitu a zamítnutí změny historického řádku i při opětovném vytvoření původního triggeru. Další test ověřuje falešný `sqliteX_` trigger, který dříve prošel nesprávným SQL LIKE filtrem. Ověřují rollback/tamper/key-swap i ztracenou DB; skutečně spustí HTTPS server s lokálně vygenerovaným (nikde necommitovaným) testovacím certifikátem a ověří TLS handshake, signaturu a odmítnutí nepovolených požadavků. Nevyužívají žádná osobní data a nesahají na produkční host.

**Provozní škálování:** plná průběžná kontrola historie při HTTP výzvě **i před každým podpisem při offline publikaci** je O(n) SHA-256 operací (paměť O(1), jeden ověřovaný Ed25519 podpis). Není používána pouhá kontrola posledního podepsaného záznamu bez prokázání integrity celé historie. Provozovatel musí sledovat p95/p99 latenci `/challenge`, timeouty a rostoucí velikost registru a **před** dosažením dvousekundového klientského limitu navrhnout odděleně posouzené kryptograficky navazující epochy / archivaci (nikoli pouze přeskočit staré řádky). V této přípravné iteraci není nasazena automatická rotace, škálování pro miliardy záznamů ani migrační procedura; neodpovídá to dokončené produkční službě. Předchozí testovací verze schématu v1 se nemigruje automaticky — nekompatibilní DB je odmítnuta a musí být bezpečně posouzena.

## Co se **stále nesmí tvrdit ani zapnout**

Tohle není dokončený **nezávislý produkční witness**. Offline `publish` zatím není bezpečně svázán s transakcí lokální HMAC evidence v Lumi; chybí **write-before-ack / ack durable** a transakční ochrana proti současné změně owner-private Area. Witness SQLite může být vrácena do starého stavu, pokud někdo obnoví **celou** witness recovery doménu včetně instalačního markeru — je nutný mimo-backupový monotónní anchor, oddělená úschova klíče a doložené provozní oddělení. Není nasazen produkční TLS endpoint, nezávislý backup/restore test, egress/DNS enforcement, ani automatizované publikování událostí. Tato iterace proto **nikdy nenastavuje `independentWitnessVerified=true`, `withdrawalComplete=true` nebo `importAuthorized=true`**; žádné osobní exporty/claims ani reálný import nesmí být povolen. Následující milník musí řešit skutečný atomický event/witness ack a nezávislý provoz; samotná lokální HTTPS demonstrace není důkaz o splnění H1-real production gate.
