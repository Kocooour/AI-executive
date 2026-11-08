# R2d.5d.3 — výchozí vypnuté HTTP pro nastavení notifikací a push zařízení

**Pouze izolovaný staging SQLite v23.** Zpřístupňuje writery
`changeNotificationSettings` / `changePushTarget` a čtení `readNotificationSettings`
([R2D5-PUSH-PASS.md](R2D5-PUSH-PASS.md)) pro právě přihlášeného aktéra třemi metodami.
Bez skutečného web-push, plánovače, UI, produkčního nasazení, migrace nebo resetu.
Vzor: [R2D5-ATTENTION-COMMAND-HTTP.md](R2D5-ATTENTION-COMMAND-HTTP.md).

## Vypínací bariéry

| Metoda | Požadované flagy (každý přesně `"true"`, jinak 404) |
| --- | --- |
| `GET …/notifications/settings` | `AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED`, `..._HTTP_NOTIFICATIONS_ENABLED` |
| `PATCH …/notifications/settings`, `POST …/notifications/targets` | navíc `..._HTTP_WRITE_ENABLED` a `..._HTTP_NOTIFICATIONS_WRITE_ENABLED` |

Nové flagy jsou v allowlistech prostředí izolovaných dětí (`target-staging-read-process.ts`,
`target-staging-title-http-process.ts`) a po práci dítěte se znovu ověřují (jinak 503).

## `GET /api/target-staging/notifications/settings`

Žádný query string (jinak 400). Odpověď z **jednoho** připnutého snapshotu v bounded dítěti,
jen vlastní data aktéra:

`timeZone, attentionPush, quietStart, quietEnd, dailyLimit, paused,
expectedSettingsRevision, expectedNotificationEpoch, restoreGeneration, targets:[targetId…]`

`targets` jsou jen ID vlastních živých zařízení (`pt_…`), nikdy hashe endpointů, aktér ani
jiní uživatelé. Před vydáním proběhne živá release bariéra: session + nový
`personalNotificationGuard {notificationEpoch}` (parametr `verifyStagingReadBeforeRelease` /
`verifyTargetStagingReadLive`, zrcadlí `personalAttentionGuard`, čte
`personal_notification_epochs` ve stejné živé transakci). Posunutá epocha (zápis nastavení
nebo zařízení po snapshotu) = **409 `read_stale_reload`**; mrtvá session 401.

## `PATCH /api/target-staging/notifications/settings`

Tělo je přesně příkaz writeru (10 klíčů). Kontroly stejné jako u šablony: Origin shodný s URL,
hlavička protokolu, žádný query string, limit 8 KiB, rate limit 30 / 600 s, identita,
konfigurace. Hash durable relace předá rodič dítěti a ověří se znovu v `BEGIN IMMEDIATE`.
Odpověď `{ok:true}`, `{ok:true,replayed:true}` nebo `{error}`.

| výsledek writeru | HTTP |
| --- | --- |
| `unavailable` | 404 |
| `invalid_request` | 400 |
| `resync_required` | společná odpověď (`resyncRequiredResponse`) |
| `stale_revision`, `idempotency_conflict`, `unchanged` | 409 `Revision conflict` |
| `session_revoked` | 401 |
| `write_failed`, `unauthorized`, nedostupné dítě | 503 |

Zapnutí push nic neodešle (jen umožní průchodu zapsat baseline); vypnutí smaže baseline
značku aktéra, pauza ji zachová (chování writeru).

## `POST /api/target-staging/notifications/targets`

Dvě varianty těla (přesné klíče, jinak 400):

- `{commandId, action:"register", endpoint, expectedNotificationEpoch, restoreGeneration}`
- `{commandId, action:"revoke", targetId, expectedNotificationEpoch, restoreGeneration}`

`endpoint` je endpoint prohlížečové `PushSubscription`: řetězec ≤ 2048 znaků, přísný
`new URL`, **jen `https:`**, bez přihlašovacích údajů, bez fragmentu, bez mezer/řídicích
znaků a **v kanonickém tvaru** (`url.href === endpoint`, aby jeden endpoint nemohl mít dva
zápisy). **Route sama spočítá `endpointHash = sha256(endpoint)`** a writeru i dítěti předá
jen hash; surový endpoint se neukládá, neloguje, nejde do childu, journalu ani odpovědi
(testy prohledávají celý staging adresář a zachycené logy).

| situace | odpověď |
| --- | --- |
| nový endpoint | 200 `{ok:true,targetId}` |
| replay stejného `commandId` | 200 `{ok:true,replayed:true,targetId}` |
| vlastní živý endpoint znovu (nový `commandId`) | 200 `{ok:true,unchanged:true,targetId}` — stejné vlastní ID, bez zápisu a bez posunu epochy |
| endpoint cizí identity (i revokovaný), vlastní revokovaný, neznámé/cizí/již revokované `targetId` | nerozlišitelné 404 |
| revoke vlastního | 200 `{ok:true}` (replay `{ok:true,replayed:true}`) |
| stale epocha / konflikt idempotence | 409 `Revision conflict` |

Ostatní kontroly a mapování stavů jako u `PATCH`.

## Odchylky a rozhodnutí

- **Žádný samostatný receipt endpoint.** Idempotentní replay podle `commandId` pokrývá retry;
  na rozdíl od Attention command HTTP tu není `POST …/receipt` ani atomický snapshot receiptu.
- GET vyžaduje jen dva flagy (generický + čtecí notifikační); šablona Attention vyžaduje u
  preview všechny čtyři. Mutace vyžadují všechny čtyři.
- Hash endpointu se počítá z kanonického řetězce; nekanonický zápis je 400.
- Staging dokazuje jen **identitní vazbu** zařízení (hash endpointu → vlastník). Skutečný
  odesílatel web-push potřebuje celé předplatné včetně klíčů (`p256dh`, `auth`); jejich
  uložení (šifrování, rotace, retence) je **odloženo na návrh cutoveru R4** a v tomto slice
  se nepřijímá ani neukládá.
- Child `GET` vrací `actorUserId` jen rodiči pro živou guard; route jej nikdy nevydá.
- Testy: `tests/target-staging-notifications-http.test.mjs`; restore-fence inventář obsahuje
  obě mutující routy.
