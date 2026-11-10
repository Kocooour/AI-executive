# HumanWiki H1-real.3b — čerstvě podepsaný high-water preflight

**Stav:** funkční server-side kryptografický **preflight kontrakt**, nikoli nasazené externí witness úložiště, grant, dokončení odvolání ani přepnutí importu. Navazuje na sloučený H1-real.3a / PR #375.

## Co je skutečně implementováno

- `humanWikiConsentIntentLocalHead(db,key)` ověří lokální SQLite HMAC řetězec z H1-real.3a a vrátí pouze globální `sequence` a neprůhledný `digest`. Neobsahuje identity, zdroje ani obsah. Neumí **sám** odhalit konzistentní rollback.
- `verifyHumanWikiFreshWitnessPreflight({db,ledgerKey,registryId,witnessPublicKey,getFreshReceipt})` vygeneruje **nový kryptograficky náhodný 32B nonce**; žádný nonce z HTTP klienta či rollbackovatelného souboru. Volá předaný server-only callback `getFreshReceipt({registryId,nonce})`, který má vyžádat aktuální high-water stav od samostatného svědka. Předaná data nikdy neobsahují identifikaci uživatele, Oblasti ani obsah zdroje.
- Odpověď má přesně šest polí: `version,registryId,nonce,sequence,digest,signature`. Podpis `Ed25519` chrání kanonické UTF-8 payload `version\\nregistryId\\nnonce\\nsequence\\ndigest\\n`. Veřejný ověřovací klíč je důvěryhodný, již načtený **Node KeyObject s type=public a asymmetricKeyType=ed25519**. Soukromý klíč nebo libovolná ad-hoc hodnota z requestu není přijatelná.
- Podpis, verze protokolu, náhodné `registryId` (oddělení instalací), přesně vrácený nonce, nejnovější sequence/digest a opakované ověření lokálního řetězce **po** callbacku musí souhlasit. Selhání načtení, timeout 2 s, chybějící klíč, úprava obsahu, starší DB, novější lokální nepotvrzený zápis nebo rozdílný digest odpověď odmítnou.
- Úspěch se hlásí výhradně jako `fresh_signed_high_water_matches_local_head_for_preflight_only`, vždy s `importAuthorized=false`, `independentWitnessVerified=false`, `withdrawalComplete=false`. **Žádný výstup funkce není autorizací importu.** `POST /api/humanwiki/import` zůstává vždy deny-only.

## Co ještě chybí, aby šlo o skutečně nezávislého svědka

`getFreshReceipt` je zatím *injektovaný callback*, nikoli produkční HTTP klient. Jeho důvěryhodnost a fyzickou nezávislost nelze ověřit pouhým podpisem v této knihovně. Zprovoznění vyžaduje externě hostovaného svědka **v jiné recovery doméně**, pouze jeho vlastní chráněný Ed25519 soukromý klíč a monotónní neprůhledný high-water checkpoint (sekvence + digest), který nelze snížit ani na něm podepsat historický stav při obnově. Svědek musí podepisovat jen aktuální checkpoint pro čerstvý nonce, nikoli libovolné hodnoty navržené klientem. Nesmí sdílet obnovenou zálohu či klíče s aplikačním serverem. Před release musí být navrženo atomické durable potvrzení události a svědka, časově konzistentní kontrola při čtení a zákaz vydání při nedostupnosti.

Bez těchto vazeb může testovací callback vrátit libovolný konzistentní podepsaný stav a aplikace **nesmí** tvrdit, že ověřila nezávislost. Ani skutečné budoucí pozitivní preflight nestačí pro import: stále chybí autentizovaný consent pro konkrétní bundle, live write-time ACL, provenance/sensitivity/review, transakční invalidace odvozenin a R3/R4 release gate. H1-real.3b nepřidává HTTP endpoint, upload ani práci s exporty.

## Cílené testy

```bash
node --experimental-loader ./tests/ts-loader.mjs --test tests/humanwiki-h1-real-fresh-witness-preflight.test.mjs
```

Pouze syntetická SQLite historie a generované testovací Ed25519 klíče: přijetí čerstvého podpisu, odmítnutí jiného registru/nonce/klíče, vyšší či nižší sequence, jiné digest, neplatného podpisu/extra polí, staré databáze po pozdějším `withdrawal_requested`, změny řetězce během callbacku, chybějícího či porušeného lokálního klíče a nepodporovaného SQLite režimu. Test reálně **nenavazuje** na nezávislé externí úložiště, a tedy neprokazuje H1-real production gate.
