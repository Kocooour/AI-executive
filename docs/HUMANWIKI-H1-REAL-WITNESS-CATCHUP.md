# HumanWiki H1-real.7 — read-only witness catch-up návrh

**Akceptace:** spojit skutečnou append-only SQLite HMAC evidenci Lumi s čerstvým kryptograficky podepsaným checkpointem witness služby a **pouze připravit nejbližší navazující operátorský publish tuple**. Bez čtení exportu, zdrojových ID, claimů nebo souhlasu; bez write API, automatického odesílání checkpointu, dokončené revokace či importu. Výchozí stav je vypnuto.

## Kontrakt

`planHumanWikiWitnessCatchup` používá stávající HMAC `humanWikiConsentIntentLocalHead`, striktní podepsaný Ed25519 challenge formát H1-real.3b, nový 32B nonce a limit 2 sekundy. Vyžaduje serverově/operátorem připnutý witness `registryId` a Ed25519 public key; odmítá padělaný podpis, replay jiného nonce, cizí registr, extra pole, nedostupnou službu a neplatnou historii.

1. Lokální SQLite ověří **celý HMAC řetězec a append-only schema**, ne pouze poslední řádek.
2. Witness je dotázán na **současný** checkpoint s čerstvým nonce. Odpověď musí odpovídat přesně **prefixu lokálního HMAC řetězce** včetně genesis (sequence 0 / 64 nul); witness před lokální historií nebo se změněným historickým digestem neprojde.
3. Je-li witness pozadu, návrh obsahuje právě **jeden následující** `{sequence,previousDigest,digest}`. I když registry zaostává o více položek, nesmí přeskočit sekvenci. Je-li v synchronu, `checkpoint=null`.
4. Před návratem se znovu kontroluje lokální HMAC hlava. Souběžný append během vzdálené výzvy vede k fail-closed výsledku. Návrh nemá trvalou platnost, ani nepotvrzuje witness write; witness `publish` sám atomicky ověřuje přímé navázání, historii i retry.
5. Všechna úspěšná i odmítnutá rozhodnutí obsahují `importAuthorized=false`, `consentVerified=false`, `independentWitnessVerified=false`, `withdrawalComplete=false`.

Tento příkaz není HTTP endpoint ani součást uživatelského import flow. Na Lumi jej lze spustit jen operátorem s lokálním právem číst soukromý HMAC ledger a s **výslovným** `AI_EXECUTIVE_HUMANWIKI_WITNESS_CATCHUP_OPERATOR_ENABLED=true`. CLI **nepřijímá argumenty** (zejména žádnou cestu k exportu); spojuje se jen se striktně připnutým HTTPS originem H1-real.4b. Loguje nanejvýš neprůhlednou sekvenci a HMAC digest; výstup smí být zpracován **jen v soukromém operátorském kanálu**, ne v UI, logu či GitHub komentáři.

## Operátorský postup (dosud nikoli schválení produkčního nasazení)

Pro čtecí CLI je nutné nakonfigurovat existující:

- `AI_EXECUTIVE_HUMANWIKI_CONSENT_LEDGER_DIRECTORY` a `AI_EXECUTIVE_HUMANWIKI_CONSENT_LEDGER_HMAC_KEY` na Lumi straně;
- `AI_EXECUTIVE_HUMANWIKI_WITNESS_REGISTRY_ID`, `AI_EXECUTIVE_HUMANWIKI_WITNESS_HTTPS_ORIGIN`, `AI_EXECUTIVE_HUMANWIKI_WITNESS_PUBLIC_KEY_SPKI_B64URL` důvěryhodným operátorem, nikoli z HTTP požadavku;
- `AI_EXECUTIVE_HUMANWIKI_WITNESS_CATCHUP_OPERATOR_ENABLED=true` pouze pro konkrétní operátorský běh.

```bash
node scripts/humanwiki/witness-catchup-operator.mjs
# result: "next_offline_witness_checkpoint_proposed_not_acknowledged"
# checkpoint: { "sequence": 1, "previousDigest": "...", "digest": "..." }
```

Opakovaným *samostatným* privilegovaným operátorským příkazem na skutečně odděleném witness hostu se může zveřejnit **pouze ověřený** kandidát:

```bash
node services/humanwiki-witness/operator.mjs publish SEQUENCE PREVIOUS_DIGEST DIGEST
```

Případná ztráta odpovědi witness operátora používá exact latest-tuple retry z H1-real.6. Nikdy se neposílá signing private key do Lumi ani lokální HMAC key svědkovi. **Pouhá shoda checkpointu nevytváří zdrojově specifické potvrzení**; k dokončení source revokace, následné autorizované ingestaci či obnovení po restore je stále potřeba vlastní write-before-ack / durable ack, antirollback kotva mimo obě backup domény, per-source provenance a transakční invalidace odvozenin. Provozní nezávislost, ACL, souhlasy a R3/R4 bezpečnostní brány nadále nejsou splněny.

## Automatická akceptace (syntetická metadata, reálné SQLite/Ed25519)

```bash
node --experimental-loader ./tests/ts-loader.mjs --test \
  tests/humanwiki-h1-real-witness-catchup.test.mjs
```

Regrese provádějí lokální HMAC append, skutečnou witness SQLite publikaci, signed challenge a postupný catch-up 0 → 1 → 2; kontrolují, že read-only plán nic nezapisuje. Dále zkouší witness ahead, podepsaný nesprávný prefix, cizí podpis, jiný nonce, nepřípustná pole, změnu lokálního ledgeru během I/O, chybějící witness a neplatný HMAC klíč. Nezahrnují reálnou produkční TLS síť, oddělení hostů ani import osobních dat; skutečný TLS listener je testován nezávisle v H1-real.5/.6.

**H1-real zůstává default-deny:** `POST /api/humanwiki/import` nesmí zpracovat tělo ani se aktivovat; žádná produkční data, reálný souhlas, mailové tělo, schválený Context Graph claim nebo release nebyly vytvořeny.
