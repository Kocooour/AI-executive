# R2d.3m.1 — kanonické čtení globálních rozsahů úkolů

**Cíl:** připravit samostatný, interní serverový základ pro globální
filtr **Vše / Osobní / Sdílené** z LUMI-FR-013. Nezaměňovat za
osobní úvodní obrazovku **Můj plán**. Iterace zahrnuje **jen úkoly**,
nikoli celou aplikaci (projekty, poznámky, události, vyhledávání).
Implementace používá pouze **izolovaný staging SQLite v21**, nic
nezapíná v produkčních API ani UI a nemění existující data.

## Semantika čtecích rozsahů

`readAuthorizedGlobalTaskPage` má interní hodnotu `scope`:

- `all`: všechny **aktuálně čitelné** úkoly — soukromé úkoly
  aktéra **plus všechny úkoly** ve sdílených Oblastech, do kterých
  má aktér přístup jako `viewer/editor/admin`, bez ohledu na
  přiřazení. Zahrnuje nepřiřazené i jinému člověku přidělené
  sdílené úkoly. To je význam globálního **Vše**.
- `personal`: jen úkoly v aktérových soukromých Oblastech.
- `shared`: všechny úkoly v dostupných sdílených Oblastech,
  i pro `viewer` a i když nejsou přidělené aktérovi.

To se liší od `my-plan`, které sdílenou práci omezuje na
**úkoly přiřazené aktérovi** a vyžaduje `editor/admin`.
Soukromé plánovací datum `whenOn` jiných lidí se do
globálního seznamu nikdy nepřidává. Zatím se čtou otevřené
i dokončené úkoly; filtrovaný Today/Upcoming jsou jiné pohledy.

Každý úkol vrací jen `id,title,projectId,areaId,areaKind,status,dueOn`
a ve sdílené Oblasti `assignedToMe:boolean`. Nevydává
`assigneeUserId`, osobní `whenOn`, jiná členství nebo
soukromé epochy. Projekty předávají Oblast děděním, samostatné
úkoly mají vlastní Oblast. Zápisy se zde neřeší;
`viewer` zůstává pouze pro čtení.

## Bezpečnost a konzistence

`readPreflightedGlobalTaskPage` vyžaduje identitu ověřenou
podpisem interního čtecího credentialu, skutečný aktuální
staging restore generation, kanonický preflight a **jeden
připnutý SQLite read snapshot**. Veškeré ACL predikáty
a globální filtr jsou v jednom SQL dotazu **před** LIMIT/OFFSET
(`limit 1–100`, offset `0–1 000 000`), stabilní řazení
`taskId BINARY, rowid`. Žádný HTTP endpoint se nepřidává.

Čtecí výsledek obsahuje **jen na serveru** `linearization`
a `areaEpochs` s *úplnou* množinou dostupných Oblastí
v příslušném globálním rozsahu, **včetně prázdných**.
Revize stránky má doménově oddělený hash obsahující
aktéra, rozsah, restore generation a monotónní
policy/content/project-content epochy všech Oblastí.
Vložená nebo odebraná Oblast i změna úkolu (včetně
přeřazení, dokončení, změny názvu) revizi zneplatní;
osobní plánování cizího člověka bez změny viditelného
úkolu ji nezneplatňuje.

`verifyTargetStagingReadLive` rozšiřuje **interní**
`homeSummaryGuard.scope="global-all"`: v jedné živé
transakci kontroluje session/identity/Area ACL a kompletní
aktuální množinu soukromých a sdílených Oblastí proti
snapshotu, včetně obsahových epoch. To zachytí také nově
získané členství nebo revokaci v okamžiku mezi snapshotem
a HTTP odpovědí. Je-li rozsah na `personal`/`shared`,
lze užít existující live guard pro daný rozsah.

**Před budoucím HTTP/UI napojením** zůstává povinný
samostatný default-off endpoint, izolovaný child, striktní
allowlist DTO, podepsaný actor/session/scope-bound cursor,
live release guard a negativní testy. Interní výsledek
s `linearization` nebo `areaEpochs` se nesmí poslat klientu.
Tato iterace není schválením celkového globálního agregátoru
obsahujícího projekty či poznámky.

## Ověření

`tests/target-global-task-read.test.mjs` pokrývá vlastní a
cizí soukromá data, editor/viewer/admin, nepřiřazené a cizí
sdílené úkoly, dědění Oblasti, dokončené položky, BINARY
listování, striktní vstupy, actor-bound preflight,
změnu obsahu/členství, nově udělenou prázdnou Oblast a
revokaci trvalé session. Test je součástí cíleného R2d CI.

**Navazuje R2d.3m.2:** default-off HTTP globálního *task-only*
čtení s přísným DTO, live epoch guardem a podepsaným
kurzorem. Pak globální agregace dalších typů a bezpečné
zapojení jednoho přepínače v UI-09/R3. Browser E2E zůstává
release gate před produkčním nasazením, ne povinností pro
každý PR.
