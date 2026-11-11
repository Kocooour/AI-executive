# HumanWiki H1-real.6 — obnovitelné potvrzení publikace na witness hostu

**Milník:** v oddělené, výchozím nastavením neaktivní witness službě skutečně provést durable `publish`, ztratit odpověď operátorského procesu a opakováním **téhož nejnovějšího checkpointu** získat platný podepsaný stav **bez druhého zápisu**. Zároveň musí změněná data, starší sekvence nebo poškozená historie selhat. Akceptační test navíc propojuje fyzicky oddělené dočasné HMAC a Ed25519 SQLite databáze přes skutečný TLS server a stávající Lumi verifier.

## Stavový kontrakt

Witness `publishWitnessCheckpoint(directory,registryId,privateKey,{sequence,previousDigest,digest})` začíná `BEGIN IMMEDIATE`. Pod stejným zámkem **celou historii** znovu audituje pomocí SHA-256 chain a Ed25519 terminální signatury. Následně připouští právě dvě varianty:

- **Nový commit:** `sequence === current.sequence + 1` a `previousDigest === current.digest`. V jedné SQLite transakci v režimu DELETE/FULL podepíše a uloží další řádek. Vrátí `{ok:true,replayed:false,sequence,digest,importAuthorized:false,independentWitnessVerified:false,withdrawalComplete:false}`.
- **Ztracená odpověď po commitu:** `sequence === current.sequence`, `sequence > 0`, `digest === current.digest` a `previousDigest === current.previous_digest`. **Žádný nový řádek ani podpis události** se neukládá. Vrátí `{ok:true,replayed:true,...}`.

Všechny ostatní situace se odmítají: starší událost, přeskočená sekvence, konfliktní digest, jiný předchůdce, neplatný podpis, odstraněný trigger, chybějící DB či rollback. Včetně opakování se výsledek nikdy neuznává bez úplného auditu historie pod zámkem. Nejde o autorizační souhlas, dokončené odvolání ani oprávnění k importu.

Po dokončeném commitu **nebo přesné nejnovější replice** vydá `operator.mjs publish` JSON `schema=humanwiki_witness_operator_handoff_v1` s `replayed`, čerstvým podepsaným `receipt` `{version,registryId,nonce,sequence,digest,signature}` a čtyřmi explicitními `false` oprávněními. Podpis Ed25519 pokrývá přesně `version,registryId,nonce,sequence,digest` podle H1-real.3b; **samotný příznak `replayed` není podepsaný** a nesmí se používat jako auditní důkaz či rozhodnutí o souhlasu. Operátor musí ověřit připnutý veřejný klíč svědka a shodu `sequence,digest`. Pokud jiný proces mezi commitem a čerstvým podepsáním posune head, nástroj raději selže než vydá potvrzení pro špatný checkpoint. Pokud se při této fázi ztratí stdout, přísně identické opakování nejnovějšího příkazu je bezpečné.

Witness privátní klíč se nesmí sdílet s Lumi nebo s jejími zálohami, operátorský příkaz nikdy neacceptuje obsah exportu. Soubor `receipt` je důkazem konzistence uložení **na witness hostu**, nikoli atomickým potvrzením zdrojové události a nezávislosti provozu. Pro udržení CRASH bezpečnosti se nesmí obcházet SQLite transakce ani změnit `synchronous=FULL`.

## Reprodukce

```bash
node --experimental-loader ./tests/ts-loader.mjs --test \
  tests/humanwiki-h1-real-witness-operator-handoff.test.mjs
```

Testy vytvářejí izolovaná dočasná privátní úložiště, generovaný testovací Ed25519 privátní klíč, skutečný operator Node child proces a reálný TLS loopback s generovaným certifikátem. Pokrývají restart procesu a ztrátu stdout po COMMIT, opakovaný příkaz bez duplicity, konflikty, starší sekvenci, historický tamper a integraci Lumi HMAC `withdrawal_requested` přes skutečné TLS a čerstvý nonce. Použita jsou výhradně syntetická metadata. Žádný produkční host, osobní export nebo Gmail není zapojený.

## Nesplněné bezpečnostní brány

Tento krok pouze umožní obnovu **witness-side** nejednoznačného potvrzení. Zdaleka neřeší distribuovaný problém source event → externí witness: chybí bezpečný write-before-ack protokol z aktuálního owner-private HMAC registru, verifikovaná provenience konkrétního zdrojového commitu, nezávislá antirestore kotva mimo oba hosty a atomická invalidace souhlasů/claims při revokaci. `POST /api/humanwiki/import` zůstává deny-only. I pozitivní `verifyHumanWikiFreshWitnessPreflight` je **pouze kontrola konzistence**, vždy `importAuthorized=false`, `withdrawalComplete=false`, `independentWitnessVerified=false`.

**Provozní aktivace** samostatného hostu, oddělená úschova Ed25519 klíče, host-level egress a R3/R4 release vyžadují další výslovné rozhodnutí. Tento PR nenahrazuje bezpečnostní akceptaci externí infrastrukturní nezávislosti a nic nenasazuje.
