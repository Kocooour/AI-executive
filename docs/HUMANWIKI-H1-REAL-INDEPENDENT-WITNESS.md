# HumanWiki H1-real.5 — samostatná witness služba, monotónní checkpointy (draft)

**Akceptace této iterace:** na oddělené testovací instanci s reálným TLS handshake a skutečnou SQLite evidencí zapsat sekvenci 0 → 1 → 2, podepsat jen aktuální checkpoint pro čerstvou výzvu Lumi a přes restart zachovat posloupnost. Odmítnout nižší, přeskočenou a nekonzistentní sekvenci, záměnu podepisovacího klíče, změnu triggerů, chybějící DB a pokus o tiché opětovné založení. Služba není produkčně nasazená a test lokálně neprokazuje **nezávislost recovery domén**.

## Co je implementováno

- `services/humanwiki-witness/store.mjs`: samostatná soukromá SQLite na witness hostu (ne Lumi VPS), pevné instalační UUID a Ed25519 veřejný otisk v souboru `witness-installation.lock`. Instalace je **pouze jednorázová** pomocí `O_EXCL | O_NOFOLLOW`, soukromých práv a `fsync`. Po ztrátě samotné databáze instalační marker zabrání nové prázdné historii; při ztrátě celé witness recovery domény je potřeba nezávislý antirollback důkaz.
- Databáze obsahuje **jen globální sekvenci a neprůhledný digest** s předchozím digestem, ID registru a vlastním podpisem Ed25519. Každá událost je ověřena od podepsaného genesis záznamu; schéma a append-only UPDATE/DELETE triggery se při otevření přesně kontrolují. Publikace vyžaduje další sekvenci o právě 1 a předchůdce shodného s aktuálním head. SQLite `BEGIN IMMEDIATE`, `synchronous=FULL`, `journal_mode=DELETE`, `COMMIT`; publikace je výhradně **offline operator-only**, ne anonymní HTTP write.
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

Testy vytvoří reálnou dočasnou diskovou SQLite, dva offline checkpointy, aktuální podepsanou odpověď, odmítnou rollback/tamper/key-swap i ztracenou DB; skutečně spustí HTTPS server s lokálně vygenerovaným (nikde necommitovaným) testovacím certifikátem a ověří TLS handshake, signaturu a odmítnutí nepovolených požadavků. Nevyužívají žádná osobní data a nesahají na produkční host.

## Co se **stále nesmí tvrdit ani zapnout**

Tohle není dokončený **nezávislý produkční witness**. Offline `publish` zatím není bezpečně svázán s transakcí lokální HMAC evidence v Lumi; chybí **write-before-ack / ack durable** a transakční ochrana proti současné změně owner-private Area. Witness SQLite může být vrácena do starého stavu, pokud někdo obnoví **celou** witness recovery doménu včetně instalačního markeru — je nutný mimo-backupový monotónní anchor, oddělená úschova klíče a doložené provozní oddělení. Není nasazen produkční TLS endpoint, nezávislý backup/restore test, egress/DNS enforcement, ani automatizované publikování událostí. Tato iterace proto **nikdy nenastavuje `independentWitnessVerified=true`, `withdrawalComplete=true` nebo `importAuthorized=true`**; žádné osobní exporty/claims ani reálný import nesmí být povolen. Následující milník musí řešit skutečný atomický event/witness ack a nezávislý provoz; samotná lokální HTTPS demonstrace není důkaz o splnění H1-real production gate.
