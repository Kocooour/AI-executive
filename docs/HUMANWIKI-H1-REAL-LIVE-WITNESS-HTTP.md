# HumanWiki H1-real.4b — live HTTPS witness preflight (default OFF)

**Rozsah:** první skutečná HTTP/HTTPS integrace existujícího kryptografického high-water verifieru z H1-real.3b s **živou owner-only** cestou. Stále pouze *read-only* kontrola konzistence HMAC evidence proti čerstvě podepsanému vzdálenému checkpointu, nikoli důkaz, že byl witness skutečně nezávisle nasazen, ani dokončená revokace / souhlas / import.

## Akceptační staging tok

Po ručním operator-only bootstrapu soukromého intent registru (H1-real.4a, #378) a s bezpečným staging owner-cookie + Area ACL smí při default-off návratu `404` produkční Node server, pouze při explicitním přepnutí flagu a správných trust pins, zavolat přes HTTPS externě nakonfigurovaný checkpoint endpoint. Callback přenese jen `registryId` a kryptografický 32B nonce vygenerovaný uvnitř verifieru, zkontroluje čerstvý Ed25519 podpis proti **serverem připnutému** klíči a globální sekvenci/digest lokální HMAC historie **před i po I/O**. Matched výsledek se zobrazuje pouze jako `remote_signed_high_water_matches_for_preflight_only`; všechny autorizační/revokační brány jsou `false`, žádné podrobnosti o soukromé historii nejsou v HTTP odpovědi.

**Reprodukce bez skutečných osobních dat:**

```bash
node --experimental-loader ./tests/ts-loader.mjs --test \
  tests/humanwiki-h1-real-live-witness-http.test.mjs
```

Integrační testy používají skutečný GET handler, platné owner session, živou soukromou staging SQLite a fyzický diskový HMAC ledger; volání remote HTTPS je v testech nahrazeno deterministickým `fetch` adapterem a syntetickým Ed25519 podpisem. To ověřuje klientský kontrakt a celou cestu uvnitř Lumi, **nikoli** skutečné oddělení externího recovery domu ani správnost implementace remote serveru.

## Default-off konfigurace

- `AI_EXECUTIVE_HUMANWIKI_WITNESS_HTTP_PREFLIGHT_ENABLED=true`: explicitní flag, jinak GET vrací `404`.
- Platný skutečný podepsaný owner cookie, `AI_EXECUTIVE_PASSWORD_HASH` a `AI_EXECUTIVE_SESSION_SECRET`; vývojový auth bypass selhává.
- Konfigurace `AI_EXECUTIVE_TARGET_STAGING_DIRECTORY`, `AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION`, `AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID`, `AI_EXECUTIVE_HUMANWIKI_PRIVATE_AREA_ID`, a živé owner-private Area ACL, vždy ze serverových hodnot, nikdy z query/header.
- Existující operator-only založený registry adresář `AI_EXECUTIVE_HUMANWIKI_CONSENT_LEDGER_DIRECTORY` + dedikovaný HMAC klíč `AI_EXECUTIVE_HUMANWIKI_CONSENT_LEDGER_HMAC_KEY`. Žádné vytváření/migrace schématu ani zápisy při GET.
- `AI_EXECUTIVE_HUMANWIKI_WITNESS_REGISTRY_ID`: náhodné UUIDv4 oddělující registry, identické s *připnutou* konfigurací externího svědka. Nevybírat podle HTTP klienta.
- `AI_EXECUTIVE_HUMANWIKI_WITNESS_HTTPS_ORIGIN`: kanonická podoba **`https://witness.example.org`** (příklad, ne skutečný server). Pouze externí validní DNS hostname přes standardní port 443; **bez** přihlašovacích údajů, portu, cesty, query, fragmentu nebo IP/localhost/.local/.internal. Endpoint má neměnnou cestu `/v1/humanwiki/high-water/challenge`. Není možné určit URL requestem, DNS ale i tak vyžaduje host-level egress ochranu a samostatnou správu.
- `AI_EXECUTIVE_HUMANWIKI_WITNESS_PUBLIC_KEY_SPKI_B64URL`: důvěryhodně, mimo HTTP request připnutý Ed25519 veřejný klíč v DER/SPKI (44 B, kanonický Base64URL). Privátní klíč **nikdy** není na aplikačním VPS a nesmí sdílet jeho obnovitelnou zálohu.

## Wire protokol

Client odešle `POST https://<pinned-host>/v1/humanwiki/high-water/challenge`, `Content-Type: application/json`, `Accept: application/json` s přesně dvěma poli:

```json
{"registryId":"v4-uuid","nonce":"base64url-32-random-bytes"}
```

V odpovědi musí být HTTP 200, JSON v `application/json` do **1024 B** a přesně `version,registryId,nonce,sequence,digest,signature`; signature je Ed25519/Base64URL nad protokolem definovaným v [H1-real.3b](HUMANWIKI-H1-REAL-WITNESS-PREFLIGHT.md), tedy `version\nregistryId\nnonce\nsequence\ndigest\n`. Není dovoleno přesměrování, cookies, bearer token, výpis lokálních eventů, uživatelská identita, Area ani zdrojový obsah. Native HTTPS důvěřuje systémové CA a ověřuje hostname; tento krok **neprokazuje** fyzickou nezávislost serveru.

Verifier si sám vytváří dvousekundový timeout, předává `AbortSignal` síťovému `fetch` a chyby, neočekávané hlavičky, nadlimitní odpověď, odlišná sequence/digest nebo změna lokální historie vždy znamenají generic `404` se `no-store`. `GET /api/humanwiki/witness-preflight` vyžaduje reálnou owner session a živou privátní Area ACL před i po vzdáleném požadavku, bez query parametrů, s rate-limitem 12 požadavků / 10 min na klienta (s globálním limitem). Pozitivní odpověď nemá identity, otisky HMAC, signature, žádné bytes konverzací, a vždy `importAuthorized=false`, `consentVerified=false`, `independentWitnessVerified=false`, `withdrawalComplete=false`, `realImportEnabled=false`, `claimsCreated=0`.

## Nesplněné production gate

**V této iteraci není žádný produkčně nasazený externí witness.** Implementujeme skutečný HTTP adapter a endpoint v Lumi, nikoli remote server nebo spolehlivé monotónní připnutí jeho checkpointu. Pro H1-real je stále potřeba samostatně provozovat witness v jiné recovery doméně s vlastními zálohami a privátním podpisovým klíčem, monotónní durable **append/ack** protokol mezi eventem a witness high-water, zákaz rollbacku/re-sign historických checkpointů, provozní attestation oddělení, host-level egress/DNS restrikce, per-source consent na konkrétní bundle, live write-time ACL, retence/revokační invalidace a R3/R4 release schválení. Dokud nejsou všechny kroky splněny, **`POST /api/humanwiki/import` je deny-only** a poskytnutý report zůstává pouze kontrolou konzistence, ne faktickým oprávněním ke zpracování dat.
