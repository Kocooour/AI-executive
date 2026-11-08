# R2d.5d.1 — základ identitně vázaného push (schéma v23 + čistý plánovač)

**Rozsah:** pouze nové, ručně vytvořené izolované staging SQLite (schéma v23)
a čistá knihovna `lib/target-attention-push-planner.ts`. **Bez odesílání, bez
web-push volání, bez plánovače, bez HTTP, UI, migrace a produkční aktivace.**
Starší staging úložiště (v22 a nižší) se odmítají, nemigrují.

## Co se ukládá

- **`personal_notification_settings`** — jeden řádek na identitu (vytváří ho
  trigger `AFTER INSERT ON identities`): `time_zone` (výchozí `UTC`),
  `attention_push` (výchozí **vypnuto**), `quiet_start`/`quiet_end`
  (`22:00`/`08:00`, formát `HH:MM`), `daily_limit` (3, rozsah 0–10), `paused`,
  `revision`. Bez delete a replace, `user_id` neměnné, revize roste o 1 a každá
  změna zvýší per-user `personal_notification_epochs` (zrcadlo attention
  epoch). Platnost IANA názvu pásma ověřuje zapisovač a preflight přes `Intl`,
  SQL hlídá jen délku.
- **`personal_push_targets`** — zařízení: `target_id` (`pt_` + 32 hex, generuje
  server), **pouze SHA-256 hash endpointu** (`endpoint_hash`). Surová
  subscription ani klíče se ve stagingu **neukládají**. `UNIQUE(endpoint_hash)`
  zaručuje, že endpoint patří právě jedné identitě (druhému uživateli se stejný
  endpoint odmítne i po revokaci). Kapacita 64 na uživatele, 4096 celkem
  (revokované řádky se počítají). Bez delete; revokace nastaví `revoked_at_ms`
  jednou. Insert i revokace zvyšují epoch uživatele.
- **`personal_attention_deliveries`** — ledger oznámení per uživatel:
  `delivery_key = 'tad1:' + sha256([ruleId, taskId, occurrenceOn])`,
  pravidla `deadline_overdue`/`deadline_soon`, stav
  `baseline|pending|sent|partial|failed|undelivered`, `attempts` 0–3.
  Řádek smí vzniknout jen pro **otevřený úkol, na který uživatel právě smí
  jednat** (soukromá Oblast vlastníka, nebo sdílená Oblast jako řešitel a
  editor/admin) a jen pro aktuální termín. Kapacita 8192.
- **`personal_attention_device_deliveries`** — výsledek per zařízení
  (`sent|failed|gone`), jen pro vlastní delivery a vlastní target (kompozitní FK
  i guard). Kapacita 32768.

**Reconcile („bez upozornění odebraným členům“):** odebrání řešitele,
změna přiřazení, odebrání/snížení člena, přesun projektu, dokončení úkolu nebo
nový termín smaže delivery řádky **jen dotčeného uživatele** (device řádky
mizí s nimi). Řádky ostatních uživatelů se nemění.

**Preflight `personal_notification_invalid`:** řádek nastavení a epoch pro
každou identitu, platné pásmo a okno, tvar a unikátnost targetů, kapacity,
delivery jen na existující identitu a dosud přístupný úkol, klíč je
přepočítatelný z vlastního pravidla/úkolu/výskytu, device řádky odkazují na
vlastní targety.

## Neměnná historie doručení (review)

- `baseline` vzniká jen při prvním zapnutí; `pending` se na něj vrátit nesmí
  (tichým potlačením by zmizel splatný push).
- `partial` smí přejít jen na `partial`/`sent`; `sent_at_ms` je po prvním
  zápisu neměnný — zařízení, které zprávu dostalo, se nikdy „neodešle zpět“
  a opakování neduplikuje push.
- Řádek doručení na zařízení vyžaduje **vlastní a neodvolaný** cíl;
  `target_id` je globálně unikátní, takže žádný zápis nemůže adresovat cizí
  zařízení jen podle ID.
- Samotné navýšení `revision` nastavení bez změny hodnoty raw SQL nezablokuje
  (stejně jako u `personal_task_plans` a lifecycle stavů — právě tak revizi
  navyšuje vnitřní AFTER trigger); veřejný zápis přijde jen přes příkaz
  R2d.5d.2. Smazání řádků zařízení zůstává možné kvůli reconcile kaskádě.
- Padělaný `delivery_key` SQL nepozná (SQLite nemá sha256); odhalí jej
  preflight a jedinou zápisovou cestou bude writer R2d.5d.2.

## Čistý plánovač

`planTargetAttentionPushes({candidates, settings, handled, sentInLast24h, nowMs})`
zrcadlí legacy `planAttentionPushes` pro jednoho uživatele: vstupem jsou jen
**aktivní** kandidáti aktéra z `readAuthorizedAttentionCandidatePage` (snooze/
dismiss se navíc defenzivně ignorují), posílá se jen `deadline_overdue`/
`deadline_soon` u úkolů (nikdy `planned_date_passed`), nic při vypnutí nebo
pauze, nic v tichém okně **v uloženém pásmu uživatele**, limit za klouzavých
24 h, pořadí závažnost → `relevantAt` → klíč. Výstup:
`{send:[{deliveryKey, taskId, ruleId, occurrenceOn}], held:"quiet_hours"|"daily_limit"|"disabled"|null}`.
Neplatná nastavení selžou zavřeně (`disabled`). Opakování neúspěšné delivery
vyjadřuje volající tím, že klíč nezařadí do `handled` (legacy: `failed` a
`attempts < 3`). **Baseline** při prvním zapnutí (aktuální kandidáti se uloží
jako `baseline`, žádný backlog) provádí volající transakce v R2d.5d.2.

Payload (`targetAttentionPushPayload`) vzniká výhradně z jednoho kandidáta
příjemce (titulek ≤ 80 bodů Unicode, česky „Termín D. M. uplynul.“ / „… je do
48 hodin.“, `/?task=<id>`, tag). Podle rozhodnutí vlastníka z 2026-10-07 se
titulek může objevit na zamčené obrazovce; je to přípustné jen proto, že
kandidát prošel ACL čtením aktéra a míří jen na jeho vlastní zařízení.

## Zdroj časového pásma pro push

Odpověď na otázku vlastníka: pásmo pro tiché hodiny a pro vyhodnocení termínů
je **uložené per-user pásmo v `personal_notification_settings`**, ne pásmo
serveru ani prohlížeče při odesílání. Dva uživatelé ve stejném okamžiku tak
mohou být jeden v tichém okně a druhý ne. Klíč oznámení na pásmu nezávisí.

## Co přidá R2d.5d.2

Živě ACL-ověřený claim (transakce se čtením aktuálních kandidátů, baseline,
claim `pending`, počítání limitu), odeslání přes **injektovaný sender**,
zápis výsledku per zařízení a HTTP pro správu nastavení a targetů — dál ve
výchozím stavu vypnuté. Skutečné web-push napojení a import subscription
přijde až při R4 cutoveru.
