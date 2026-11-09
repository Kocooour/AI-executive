# R3-BE-4b — soukromé poznámky přes cílové create HTTP

**Rozsah:** reálný (stagingový) serverový zápis, bez aktivace v UI, bez migrace nebo změn produkčního úložiště. Navazuje na [R3-FE-4a](R3-FE-04A-DETAILS.md) a existující transakční note lifecycle writer z R2d.

## Integrované akceptační kritérium

Z autorizovaného klienta POST na `/api/target-staging/notes` vytvoří jedinou **samostatnou poznámku v konkrétní soukromé Oblasti** aktuální identity. Následný již existující GET `/api/target-staging/notes/:noteId` ji vidí pouze pod serverově ověřenými Area právy. Opakovaný stejný příkaz nic neduplikuje; odlišný obsah se stejným `commandId` vrací konflikt. Odmítnuté pokusy nezanechají žádná data, receipt ani audit. Sdílená Oblast ani poznámka v projektu touto trasou vytvořit nejde.

HTTP je aktivní **jen** při všech pěti přesných hodnotách `"true"`:
- `AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED`
- `AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED`
- `AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_ENABLED`
- `AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_WRITE_ENABLED`
- nový `AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_CREATE_ENABLED`

Vše je default-off. Bez hodnoty `"true"` endpoint vrací 404. Žádný klient jej zatím nevolá a Quick Capture zůstává v cílovém režimu vypnutý, dokud R3-FE-4b nenaváže UI a další typy záznamů.

## Příkaz

`POST /api/target-staging/notes`; `Origin` přesně stejný jako URL, `x-lumi-target-protocol: 1`, autentizační cookie owner nebo trvalé staging session. JSON má **přesně** tato pole:

```json
{
  "noteId": "1dbe798b-8ae4-46a8-98ae-51ac73dd31b8",
  "commandId": "f3d18d63-9073-48f7-8d25-6c81f23b9a01",
  "restoreGeneration": "b7ab0e6e-d01f-44ed-babe-e9b69e84dbaa",
  "areaId": "PRIVATE_AREA_ID",
  "title": "Moje poznámka",
  "body": "Obsah poznámky"
}
```

`noteId` a `commandId` jsou klientem jednou vytvořená UUID (retry je musí zachovat); `restoreGeneration` je aktuální synchronizovaná generace cílového store. `areaId` je explicitní cíl, **nikoli důkaz oprávnění**. Server nedovoluje přenést `projectId`, `scope`, `actor`, `workspaceId` ani synchronizační snapshot. Maximální parsované tělo požadavku 160 KiB, obsah `body` do 128 KiB UTF-8, `title` do 4 KiB. Úspěch 201 `{ok:true,noteId}`, přesný retry 200 `{ok:true,noteId,replayed:true}`.

Odmítnutí: neautentizované 401; nedůvěryhodná konfigurace 503; jiná origin 403; chybný protokol/JSON 400; neviditelná, cizí či sdílená Oblast 404; jiná generace 409 `resync_required`; konflikt idempotence 409. Odpověď nikde nevrací text, existenci cizích záznamů, policy epoch, digest ani seznam členů. Vše `Cache-Control: no-store`.

## Bezpečnostní hranice

Route ověří živou identitu a protokol před odesláním do izolovaného subprocessu. Ten kontroluje příznaky znovu, získá write-only session credential a předá příkaz do **pinned BEGIN IMMEDIATE** transakce. V ní se znovu ověří identity/session, restore generation, zápisová práva ke konkrétní Oblasti a její druh `private`, absence rodičovského projektu, ID/tombstone, idempotency receipt a kapacitní limity. Existující note lifecycle writer zapíše note, obsahově prázdný receipt, audit a anchor journal v jednom commit boundary. Nová větev přidává do writeru interní `privateCreateOnly`, nikoli pravomoc klienta.

Nedošlo k nastavení souhlasu se sdílením, změně ACL, migraci, produkční aktivaci ani k zavedení bezpodmínečného POST. Vznik projektu, úkolu nebo sdílené poznámky není dodán. Časový timeout po zápisu může vytvořit nejistý klientský výsledek: při stále platném oprávnění se použije stejné `noteId/commandId` pro opakování a potvrzení receipt; klient nesmí vygenerovat novou identitu příkazu.

## Testy

`tests/target-staging-note-create-http.test.mjs`: skutečný izolovaný SQLite store, HTTP POST → uložený note, idempotentní retry, konflikt, Alice/Bob privátní Area, shared i cross-owner deny, neautentizovaný uživatel, deaktivace flagu, CSRF/protokol, odmítnutí snapshotu a cizích polí, restore generation a přísný child output. `PR Checks` provádí typovou kontrolu, vybrané testy a build; plný Browser E2E až před produkčním nasazením na konkrétním SHA.
