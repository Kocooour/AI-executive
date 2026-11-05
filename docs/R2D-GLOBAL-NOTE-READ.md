# R2d.3m.5 — interní globální index názvů poznámek

Navazuje na R2d.3m.1–R2d.3m.4 (úkoly a projekty).
Nový `readAuthorizedGlobalNotePage` zpřístupňuje jen
**autorizované metadatové řádky poznámek** pro globální
`Vše / Osobní / Sdílené`. Pojem Vše se zde vztahuje
na všechny poznámky, které aktér smí **číst**, ne jen
na úkoly přiřazené aktérovi jako v Mém plánu.

**Pouze izolovaný staging model, bez HTTP a produkční aktivace.**

## Výběr a data

- `all`: vlastní soukromé poznámky + všechny poznámky
  v dostupných sdílených Oblastech pro
  `viewer/editor/admin`, i bez přiřazených úkolů.
- `personal`: pouze vlastní soukromé poznámky.
- `shared`: pouze sdílené poznámky s aktuálním
  oprávněním čtení.
- Samostatná poznámka má vlastní Oblast; poznámka
  uvnitř projektu ji dědí **výhradně od přímého
  rodičovského projektu**. Odkaz/zmínka není rodičovství.
- SQL uplatní členství, děděnou Oblast, pravidla
  platných ID a limity **před stránkováním**
  (BINARY `noteId`, limit 1–100, offset 0–1 000 000).
  Neautorizované řádky nemohou posunout stránku.
- Řádek `{id,title,projectId,areaId,areaKind,revision}`.
  **Obsah poznámky (`body`), cizí členové, vlastník
  jiného prostoru ani soukromý `whenOn` se nevydávají.**

## Serverové svědectví a bezpečnost

`readPreflightedGlobalNotePage` a
`TargetStagingSessionAuthority.readGlobalNotePage`
požadují serverově podepsaného aktéra a kanonický
preflight v **jediném připnutém read snapshotu**.
Pouhý dotaz s libovolným `actor` není důvěryhodnou
bránou.

Vnitřní výsledek obsahuje úplnou množinu aktuálně
čitelných Oblastí včetně prázdných
(`linearization`, `areaEpochs`) a zvláštní
`noteAreaEpochs` s `areas.note_sync_revision`.
Na rozdíl od task/project epoch tato revize reaguje
na změnu názvu/těla poznámky, vkládání, odstranění
a změny dědění. Proto je nezbytná pro případné
budoucí HTTP čtení. Doménově oddělený SHA-256
`revision` zahrnuje aktéra, rozsah, restore
generation, role/policy/content/project-content epochy
**a note_sync_revision všech čitelných Oblastí**.

Živá `verifyTargetStagingReadLive` byla
rozšířena o volitelný serverový `noteAreaEpochs`
witness v `homeSummaryGuard`. Ověří současnou
identitu/relaci, úplné členství v Oblastech,
všechny uvedené epochy včetně note-specific a
aktuální stav obnovy **atomicky v jedné transakci**.
Chybějící, neshodný, zkrácený nebo podvržený
witness se odmítne.

Budoucí HTTP gateway **musí** ještě ověřit
autentizaci, podpis a obsah vlastního child DTO,
vázané stránkovací kurzory a provést atomickou
živou kontrolu s oběma epoch witnesses těsně
před uvolněním názvů. Stávající interní index
nesmí být sám publikován do API.

## Regrese a další iterace

`tests/target-global-note-read.test.mjs` ověřuje
více aktérů a `viewer`, cizí soukromí, vynechání
těla poznámky, zděděnou Oblast, stabilní stránkování,
oddělené revize soukromých/sdílených poznámek,
ABA úpravy, změnu rodiče, aktuální identitu,
revokaci členství, nově přidělenou prázdnou
Oblast, revokaci durable session a podvržené
note epoch witnesses. Soubor patří do cíleného
R2d CI.

Následující **R2d.3m.6**: samostatně default-off
staging HTTP s izolovaným child, přesným DTO
allowlistem, podepsaným actor/session/scope cursor
a oběma live Area epochs. Až potom je možné
bezpečně připravovat jediný kombinovaný přepínač
Vše v UI-09/R3. Produkční zapnutí, cutover,
reset či migrace nejsou součástí tohoto PR.
