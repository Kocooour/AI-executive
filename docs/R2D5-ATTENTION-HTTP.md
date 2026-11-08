# R2d.5c.1 — výchozí vypnuté HTTP čtení kandidátů Attention

**Pouze izolovaný staging SQLite v22.** `GET /api/target-staging/attention`
zpřístupňuje selektor `readAttentionCandidatePage`
([R2D5-ATTENTION-READ.md](R2D5-ATTENTION-READ.md)) pro právě přihlášeného
aktéra. Bez zápisu, UI, push, produkčního nasazení, migrace nebo resetu.
HTTP příkaz životního cyklu (preview / PATCH / receipt) je až **R2d.5c.2**.

## Vypínací bariéry a parametry

Výchozí stav je **404**; endpoint vyžaduje současně
`AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED=true` a
`AI_EXECUTIVE_TARGET_STAGING_HTTP_ATTENTION_ENABLED=true`. Totéž platí pro
izolované čtecí dítě. Oba flagy se znovu ověřují po čtení dítětem (jinak 503).

`GET` přijímá pouze, každý nejvýše jednou:

- `areaFilter=all|personal|shared` (výchozí `all`),
- `view=active|hidden` (výchozí `active`),
- **žádné `timeZone`** (R2d.4k, rozhodnutí vlastníka 2026-11-08 Q1): pásmo se čte ze serverového profilu `personal_notification_settings.time_zone` ve stejném pinned snapshotu jako výběr, validuje se `attentionEvaluationWindow` a chybějící/neplatné pásmo je fail-closed (503). Klíč `timeZone` v dotazu je neznámý, tedy 400,
- `limit=1..100` (výchozí 50) a opaque `cursor` (max. 4096 znaků).

Neznámé či duplicitní klíče (včetně `evaluatedAtMs`, `now`, `offset`, `actor`)
jsou 400. Rate limit `target-staging-attention`, 120 požadavků / 600 s.

## Okamžik vyhodnocení = hodiny serveru

Klient okamžik **nikdy nezadává**. První stránka použije `Date.now()` serveru.
Další stránky musí použít *stejný* okamžik, jinak by se hranice
overdue/soon/snooze mezi stránkami posunula. Existující podpisový helper kurzoru
nese pouze offset a revizi, proto byl rozšířen o **volitelný podepsaný nárok
`at`** (celé číslo, ms): `signStagingProjectHttpCursor(..., instantMs)` a
`verifyStagingProjectHttpCursor(..., expectInstant=true)`. Nárok je součástí
HMAC podepsaného payloadu, takže jej nelze změnit bez zneplatnění kurzoru;
verifikace s `expectInstant` vyžaduje přesnou sadu klíčů včetně `at`, kdežto
ostatní endpointy (bez `expectInstant`) kurzor s `at` odmítnou a jejich chování
se nemění. Vazba kurzoru (hash v `authenticationBinding`) navíc pokrývá
auth/session, `areaFilter`, `view` a `limit` (pásmo kurzor nevážou, jeho změnu pokrývá revize stránky a vede k 409 `Cursor stale`); použití s jinou
hodnotou, jiným aktérem či cookie je 400. Kurzor stále platí max. 15 minut a
expirace se při pokračování nepodlužuje. Revize stránky (v2 hash selektoru)
zahrnuje okamžik, epochy i Area epochy; změna mezi stránkami je
**409 `Cursor stale`**.

## Soukromí a live release bariéra

Dítě `scripts/target-staging-attention-child.mjs` dostane jen hash durable
relace a čte přes preflightovaný snapshot výhradně pro aktéra identity. Rodič
`parseStagingAttentionPage` přesně validuje každé pole položky (včetně
`lifecycle`, `snoozedUntilMs`, `lifecycleRevision`, odvozeného `attentionKey`,
pravidla vůči datům a okamžiku, řazení) i vnitřky stránky (`privateEpoch`,
`attentionEpoch`, `linearization`, `areaEpochs`). Neplatné DTO: log
`attention/invalid_child_dto` a 503.

Před odpovědí se v **jedné živé transakci** ověří session/actor, Area
policy/content epochy (`scope:"my-plan"`), soukromá epocha plánu
(`personalPlanGuard`) a nově `personalAttentionGuard {attentionEpoch}` vůči
`personal_attention_epochs.revision` aktéra. Stale je 409
`read_stale_reload`; revokovaná session je odmítnuta jako u ostatních
staging čtení.

## Odpověď (`Cache-Control: no-store`)

`{items,hasMore,nextCursor,areaFilter,view,timeZone,evaluationDate,soonThroughDate,evaluatedAtMs,attentionEpoch}`; `timeZone` je profilové pásmo (jen k zobrazení). Živá release bariéra navíc ověřuje `personalNotificationGuard` (epocha notifikací): změna pásma (nebo jiného nastavení/cíle) mezi čtením a uvolněním je 409 `read_stale_reload`.
Položky přesně odpovídají `AttentionCandidate`.

`attentionEpoch` se **záměrně vydává**: je to CAS vstup příkazu životního
cyklu (R2d.5c.2). Je to čítač vlastního stavu aktéra (počet změn jeho
soukromých řádků), neobsahuje žádná cizí data a klient ho nemůže použít k
čemukoli, co by už neviděl ze svých položek. **Nikdy** se nevydává
`privateEpoch`, `linearization`, `areaEpochs`, revize stránky ani ID aktéra.

## Testy

`tests/target-staging-attention-http.test.mjs`: oba flagy, neautentizované
volání, přísný dotaz, izolace aktérů a diváka, `view=hidden` po vzniku řádku,
stránkování s neměnným `evaluatedAtMs`, podvržený kurzor, vazba kurzoru na
filtr/view/limit/aktéra, odmítnutí klientského `timeZone` a změnu profilového pásma, 409 při změně epochy mezi stránkami i mezi
čtením a uvolněním, revokace session, vypnutí flagu za běhu a negativní DTO.
Zařazeno do R2d cíleného CI. Browser E2E až před produkčním nasazením.

## Hranice R2d.4k zjištěné nezávislým testem

- Parser odpovědi child procesu neověřuje `linearization.actorUserId` proti očekávanému
  aktérovi (rodič ho nezná). Podvržený aktér z kompromitovaného lokálního child procesu by však
  neprošel živou release bariérou: `verifyTargetStagingReadLive` odmítne linearizaci, jejíž
  aktér se liší od aktéra relace. Zóna, kterou child konzistentně odvodí, se dál bere jako
  důvěryhodný výstup lokálního procesu.
- Změna domény receiptů na `personal-attention-v2` znamená, že potvrzení příkazů zapsaná dříve
  (v1, staging, výchozí vypnuto) receipt endpoint nerozpozná (`not_recorded`); opakovaný příkaz
  se znovu neprovede (`stale_revision`), integrita zůstává. Staré v1 receipty dál zabírají
  kapacitu.
- Neplatná zóna v profilu (jen přímou manipulací s DB; zápis ji validuje) shodí preflight
  celého staging úložiště — fail-closed pro všechny, nikoli jen pro jednoho uživatele.
- Změna zóny může u téže položky přepnout pravidlo („termín se blíží“ → „po termínu“) a vyvolat
  novou push notifikaci; jde o dvě různá upozornění stejně jako dosud.
