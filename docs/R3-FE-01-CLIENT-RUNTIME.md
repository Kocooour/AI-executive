# R3-FE-1 — základ klientského běhu cílových dat

**Stav:** default-off, bez viditelné změny. Součást UI-09/R3 ([ROADMAP](ROADMAP.md)); žádná obrazovka se zatím nepřepíná na cílová data (to je R3-FE-2). Nejde o produkční aktivaci ani o změnu žádných dat.

## Účel

Existující klientské relace (`createAttentionSession`, `createGlobalIndexReadSession`, hledání, Můj plán) berou funkci `contextVersion`, ale dosud neexistoval jediný zdroj této hodnoty. R3-FE-1 dodává:

1. server: `GET /api/target-staging/session` vrací neprůhlednou generaci autentizace,
2. klient: `lib/target-client-runtime.ts` drží generaci pro celé načtení stránky, ruší relace při její změně a předává životní cyklus stránky (pozastavit / obnovit),
3. `lib/target-client-errors.ts`: jedna česká taxonomie chyb pro všechny existující klienty,
4. React: `TargetDataProvider`, hooky `useTargetRuntime`, `useTargetGeneration`, `useTargetSession` a komponenta `TargetDataStatus`.

## Příznak

`AI_EXECUTIVE_TARGET_UI_ENABLED="true"` **a zároveň** `AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED="true"`. Výchozí je vypnuto:

- route vrací `404` a nic nečte,
- `app/page.tsx` (serverová komponenta, `force-dynamic`, příznak se čte při každém požadavku) nepřipojí `TargetDataProvider`; aplikace se vykreslí stejně jako dříve a neodešle žádný nový požadavek. Původní klientská komponenta je beze změny v `app/ui/lumi-app-root.tsx`.

Provider vytváří runtime až v `useEffect`, takže SSR a hydratace nikdy nic nenačítají.

## Sémantika generace

`generation` = `base64url(HMAC-SHA256(AI_EXECUTIVE_SESSION_SECRET, "lumi:r3:auth-generation:v1\0" + vazba + "\0" + epocha))`.

- vazba vlastníka: `owner:` + `authenticationBinding(request)` (hash cookie `ai_executive_session`); vazba trvalé relace: `session:` + hash tokenu,
- epocha: aktuální `revocation_epoch` identity, čtená **živě** ze stagingového úložiště (vlastník: konfigurovaný vlastník; relace: uživatel živé relace),
- hodnota se změní při přihlášení (nová cookie), odhlášení, přepnutí účtu, odvolání relace i „odhlásit všude“; neobsahuje ID aktéra, token ani cookie,
- route používá stejné brány jako ostatní stagingová čtení: kotva a obnova (`stagingAnchorRefusal`), admission, limit 120 / 600 s, živé ověření identity před uvolněním, `cache-control: no-store`. `401` (se stávajícími kódy `session_*`) při nepřihlášení či odvolání, `503` při nedostupném stagingu.

Klientská hodnota `generation()` je `""`, dokud není známa. Po jakémkoli odmítnutí (401/403, 404, odeslání `signed-out`, `reportRefusal`) se změní na náhodnou hodnotu `unknown-…`, takže existující relace skončí v terminálním stavu (A → B → A se neoživí). Přechodná chyba (5xx, síť, neplatný DTO) hodnotu nemění; `refresh()` vrátí `"unavailable"`.

## Životní cyklus

| Událost | Chování |
| --- | --- |
| start | okamžité `refresh()` |
| `visibilitychange` → viditelné, `focus` | `resume()` + `refresh()` (shluk událostí v rámci 1 s se spojí) |
| `pageshow` (i `persisted`, BFCache), `online` | `resume()` + `refresh()` |
| `hidden`, `pagehide`, `offline` | `suspend()` všech zaregistrovaných relací |
| zpráva `signed-out` na `BroadcastChannel("ai-executive-session")` | okamžitě neznámá generace a `dispose()` všech |
| změna generace | `dispose()` **všech** zaregistrovaných; funkce musí relace vytvořit znovu |
| `reportRefusal(kind)` | neznámá generace + `refresh()` |
| `dispose()` | odebere všechny listenery, zavře kanál, zruší rozpracovaný požadavek |

`resume()` nikdy sám nenačítá data (kontrakt relací). Souběžná volání `refresh()` se spojují. Odpověď staršího požadavku nepřebije odhlášení pozorované mezitím. Nepoužívá se `localStorage`, `sessionStorage` ani IndexedDB; obsah odpovědí se neloguje; DTO musí být přesně `{generation}` (43 znaků base64url), `application/json`, `no-store`, tělo do 1 KiB.

## Taxonomie chyb

`mapTargetClientFailure(vstup)` → `{kind, action, message}`. Vstupem je stav/důvod stávajících klientů (attention, global index, title search, Můj plán, projekty, poznámky), HTTP stav nebo `{status, error}`.

| kind | action | typické vstupy |
| --- | --- | --- |
| `signed_out` | `sign_in` | `unauthorized`, `signed-out`, 401, `session_*` |
| `forbidden_or_missing` | `none` | 403, 404, `not_found`, `not-found` |
| `stale` | `reload` | `stale`, 409 `read_stale_reload`, `Cursor stale`, `aborted` |
| `conflict` | `reload` | `conflict`, 409 `Revision conflict` |
| `invalid` | `none` | 400, 413, `invalid*` |
| `rate_limited` | `retry_later` | 429, `rate-limited` |
| `unavailable` | `retry_later` | 503, 5xx, `unavailable`, `disabled`, neznámé |
| `offline` | `retry_later` | `offline`, síť |
| `uncertain` | `verify` | `uncertain` (výsledek se ověřuje; nikdy netvrdí úspěch ani selhání) |

Zprávy jsou krátké, klidné, česky, bez technických ID, stavových kódů a stack trace. `TargetDataStatus` vykreslí `role="status"` pro `uncertain` a `role="alert"` pro ostatní; akční tlačítko je nativní `<button>` (klávesnice funguje beze změny).

## Jak se funkce připojují

```tsx
const session = useTargetSession(
  contextVersion => createAttentionSession({areaFilter:"all",view:"active",limit:50,contextVersion}),
  []);
// session je null, dokud server nepotvrdil generaci; po změně generace
// se stará relace zruší a vytvoří se nová.
```

Při `401` / `session_revoked` z jakéhokoli cílového požadavku volejte `useTargetRuntime()?.reportRefusal("session_revoked")`. Chyby zobrazujte přes `TargetDataStatus`.

## Co zatím NENÍ přepnuto

- žádná obrazovka ani existující náhled (`target-staging-*-preview.tsx` zůstávají beze změny, mají vlastní životní cyklus),
- žádné cílové zápisy, offline fronta ani cache,
- žádná produkční aktivace; bezpečnost nadále zajišťuje server (generace je jen klientská pojistka životního cyklu odpovědí).

## Testy

`tests/target-client-runtime.test.mjs`, `tests/target-staging-session-generation-http.test.mjs`, `tests/target-client-errors.test.mjs`, `tests/target-client-runtime-wiring.test.mjs` (chybějící příznak = žádný provider ani požadavek). Jsou součástí cíleného workflow `r2d-project-reads.yml`.
