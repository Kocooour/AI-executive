# R3 / BE-16 — izolovaný klient autorizovaného globálního indexu

**Účel:** první klientský read-only kontrakt pro budoucí globální **Vše / Osobní / Sdílené** v UI-09. Nezaměňuje `all` za `my-plan` ani neaktivuje produkční navigaci.

## Zdroje a hranice
- Používá výhradně existující, default-off endpoint `GET /api/target-staging/global-index`; zapnutí stále vyžaduje `AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED=true` a `AI_EXECUTIVE_TARGET_STAGING_HTTP_GLOBAL_COMBINED_ENABLED=true`. Tento PR žádný flag nenastavuje.
- Server obstarává identitu, aktuální Area ACL, member role včetně viewer, soukromí poznámek, kompletní epochy, per-session HMAC cursor a live pre-release revokační kontrolu. Klient neodesílá aktéra, role, Oblasti, generaci ani vlastní pozice stránkování.
- `scope=all` znamená všechny serverově autorizované soukromé a sdílené projekty, úkoly (i nepřiřazené nebo přiřazené jinému členu) a **názvy** poznámek. Osobní `Můj plán` zůstává odlišným pohledem, nikoli globální čtecí scope.

## Klientská obrana
- Typovaný GET s `same-origin` credentials, `no-store`, `redirect:error`, explicitním `scope` a opcionalitou podepsaného cursoru. Bez retry, prefetch, perzistence, zápisů a UI prolinku.
- Striktní DTO exact-key all-list na rootu i každé položce; jen `project/task/note`, bez bodies poznámek, actor/ACL/epoch metadat či cizích assignee ID. Záznamy `personal/shared` mají správný typ Oblasti; `shared assignedToMe=false` je v globálním Vše správně a nesmí být zamítnuto jako v Mém plánu.
- Ověření stabilního UTF-8 BINARY pořadí s typovým tie-break, duplicit, stránkového limitu a kurzoru. Při skládání stránek se odmítá opakovaný cursor, duplicita nebo porušení pořadí.
- HTTP odpověď: max. 8 MiB skutečně přijatých bajtů, striktní UTF-8, pravý `no-store`, přesné JSON MIME, žádná důvěra v podhodnocené `Content-Length`. Abort funguje i před hlavičkami u ignorujícího adaptéru, po abortu se opožděný stream zruší. Všechny chyby fail closed, žádná cache titulků.

## Testy
Izolované pozitivní a negativní HTTP/DTO testy rozsahů a viewer/nepřiřazených sdílených úkolů, zákaz dodatečných soukromých polí, přísná typová a datumová validace, UTF-8 BINARY stránkování, podpůrné statusy, limit bajtů, pre-header a stalled-body abort. Stávající serverové cross-identity testy globálního endpointu zůstávají samostatnou autorizační branou.

Staging-only, default OFF. Žádné změny produkčního UI, API, databáze, migrace, credential, deployment ani cutoveru. Celá Browser E2E pouze před produkčním releasem na přesném SHA.
