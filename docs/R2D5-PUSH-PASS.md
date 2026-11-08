# R2d.5d.2 — zapisovače nastavení/zařízení a identitně vázaný push průchod

**Rozsah:** pouze izolované staging SQLite (schéma v25, bez migrace starších staging úložišť) a knihovny
`lib/target-notification-writer.ts` a `lib/target-attention-push-pass.ts`.
**Bez skutečného web-push, bez sítě, bez časovače/plánovače, bez HTTP, UI,
migrace a produkční aktivace.** Odesílač (`sender`) je vždy injektovaný.

## Zapisovače (jediná veřejná zápisová cesta)

Stejná struktura jako zapisovač Attention lifecycle: pinned write transakce
(`BEGIN IMMEDIATE`), ověřený aktér ze serverem vydaného WRITE credentialu,
volitelně živá durable session, kontrola `restoreGeneration`, idempotentní
receipt v `metadata`, obsahu prostý záznam v append-only journalu (druh
`personal_notification`). Příkaz nikdy nevybírá aktéra.

- **`changeNotificationSettings`** — příkaz `{commandId, timeZone, attentionPush,
  quietStart, quietEnd, dailyLimit 0–10, paused, expectedSettingsRevision,
  expectedNotificationEpoch, restoreGeneration}`. Mění jen řádek aktéra, CAS na
  revizi řádku i epochu, `unchanged` při shodných hodnotách, replay vrací
  `replayed`, stejné UUID s jiným obsahem `idempotency_conflict`. Receipt
  `r2:personal-notification-settings-receipt-v1:`. Zapnutí push **nic neodešle**;
  jen umožní průchodu zapsat baseline. **Vypnutí** (1→0) smaže baseline značku
  uživatele (jako legacy), takže nové zapnutí začne čistým baseline; pauza ji
  zachová.
- **`changePushTarget`** — `register {commandId, action, endpointHash (64 hex),
  expectedNotificationEpoch, restoreGeneration}` a `revoke {…, targetId}`. Server
  generuje neprůhledné `pt_` + 32 hex. Endpoint se nikdy neukládá ani nepřijímá,
  jen jeho SHA-256 spočtený volajícím. Endpoint, který patří jiné identitě
  (i revokovaný), vrací `unavailable` a nic nezapíše; vlastní živý cíl vrací
  `unchanged` s jeho ID; vlastní revokovaný endpoint znovu registrovat nelze
  (schéma: jeden řádek na endpoint). Revokace jen vlastního živého cíle. Receipt
  `r2:personal-push-target-receipt-v1:`. Replay registrace vrací ID jen z vlastních
  řádků.
- **`readNotificationSettings(actor)`** — vlastní nastavení, epoch a ID vlastních
  živých cílů (nikdy hashe).
- Journal: `{receiptHash, epoch, op}` (op 0 nastavení, 1 registrace, 2 revokace);
  průchod zapisuje `{epoch, op, n}` (op 3 baseline/claim, 4 výsledek zařízení,
  5 dokončení doručení). Žádný uživatel, úkol, klíč, cíl, čas ani titulek.
- Preflight přijímá jen oba nové prefixy receiptů (limit 4096 každý) a
  značku `r2:push-baseline:<sha256(user)>`; ta musí patřit existující identitě a
  mít pevnou hodnotu `sha256(["push-baseline-v1", user])` (max. jedna na
  identitu).

## Algoritmus průchodu

`TargetStagingSessionAuthority.runAttentionPushPass(nowMs, sender)` →
`runTargetAttentionPushPass`. Identity se berou jen z ověřeného úložiště (řádky
`personal_notification_settings` s `attention_push=1` a `paused=0`, deterministické
pořadí, max. 256 za průchod); credential pro čtení vydává autorita svým
neexportovaným klíčem. Jeden průchod najednou na proces (druhý vrací
`busy:true`).

1. **Čtení** aktivních kandidátů aktéra preflightovaným selektorem v **uloženém
   pásmu** uživatele (`areaFilter=all`, `view=active`, stránkování po 100, max.
   500; změna epochy/revize mezi stránkami uživatele pro tento průchod vynechá).
2. **Jedna pinned write transakce na uživatele:** znovu ověří, že se nastavení
   (pásmo, okno, limit, revize, epoch) ani attention epoch od čtení nezměnily;
   obnoví osiřelé `pending` starší než 15 min podle trvalých výsledků zařízení: již odeslané označí `sent` nebo `partial` s původním časem odeslání; potvrzeně neúspěšné výsledky zachovají retry do 3 pokusů jako `failed`. Pouze cíle se zapsaným začátkem odesílání (`inflight`), jejichž výsledek pád přerušil, přejdou do `unknown`; dosud neoslovené `reserved` cíle zůstávají bezpečně opakovatelné. Bez potvrzeného výsledku a bez opakovatelného cíle je doručení `undelivered`; pak
   - **baseline** (chybí značka): všichni aktuální oznámitelní kandidáti se zapíšou
     jako `baseline`, zapíše se značka, nic se neodešle;
   - jinak `handled` (vše kromě `failed` s alespoň jedním původním živým `reserved` cílem nebo `failed` cílem s méně než 3 skutečnými pokusy), `sentInLast24h`
     (sent/partial s `sent_at` mladším než 24 h + pending mladší než 24 h), `planTargetAttentionPushes`
     a **claim** každého naplánovaného jako `pending` (parent `attempts=0`) s atomickou rezervací právě aktuálních živých cílů (`reserved`, attempts=0; bez nové registrace při retry), nebo `failed→pending`
     **bez změny počtu pokusů**. Před claimem se v transakci znovu ověří ACL, otevřený stav,
     aktuální termín a pravidlo, snooze/dismiss; kandidát, který přístup ztratil
     mezi čtením a claimem, se prostě nezabere (insert guard je druhá pojistka).
3. **Mimo transakci** pro každý claim a každý živý cíl uživatele (přeskočí se
   `sent`/`gone` a `failed` s 3 pokusy): payload z kandidáta
   (`targetAttentionPushPayload`, jen vlastní titulek). **Bezprostředně před
   každým odesláním** krátké čtení: řádek doručení stále existuje ve
   očekávaném stavu (`pending`/`partial`), nastavení je stále zapnuté a
   nepozastavené, **revize nastavení se od plánu nezměnila** (jinak se dosud
   neodeslaný claim uvolní a musí se naplánovat podle nového denního limitu),
   **aktuálně mimo tiché hodiny** ve stále platném pásmu uživatele a cíl je živý. Čas se znovu zjišťuje před každým zařízením (testy používají injektovaný clock). Reconcile smaže řádek při ztrátě přístupu,
   dokončení úkolu nebo změně termínu → nic se neodešle („bez upozornění
   odebraným členům“).
4. **Před** předáním zařízení odesílači se commitne jeho stav `inflight` a
   parent `attempts` se zvýší pouze podle skutečně zahájeného pokusu zařízení
   (nejvýše 3); opakované `reserved → failed → pending` při pádech před
   odesláním žádný pokus nespotřebuje.
   Výsledek se pak **hned** commitne jako `sent` / `failed` / `gone`;
   `gone` revokuje právě tento cíl guardovaným UPDATE. Pád před `inflight`
   ponechá `reserved` a dovolí pozdější doručení; pád během `inflight`
   může znamenat skutečně odeslanou zprávu, proto se stav uzavře jako
   `unknown` bez opakování (prevence duplicit). Při zápisu `inflight` se
   také obnoví čas poslední aktivity parent doručení, takže délka průchodu přes
   mnoho zařízení sama nezpůsobí falešné zotavení jako po pádu.
5. **Dokončení** nikdy neuzavře výskyt, který má ještě zařízení `inflight`
   (může jít o současně běžící jiný proces). Jinak jako legacy: doručeno a zbývá opakovatelné zařízení → `partial`,
   doručeno → `sent` (`sent_at` se zapíše jednou), žádné zařízení → `undelivered`
   (zařízení přidané později nedostane backlog), nikdo nedostal → `failed`
   (limity jsou po jednotlivých zařízeních, nikoli podle počtu obnovených
   parent claimů). Respektují se v23 guardy
   (partial jen na partial/sent, `sent_at` write-once).
6. **Opakování partial:** jen původně rezervované a potvrzeně neúspěšné cíle; zařízení `sent`/`gone`/`unknown` nikdy znovu. `reserved` po bezpečně dokončeném quiet-hour přerušení lze odeslat později, zatímco `reserved` přeživší **pád** bez zahájeného odesílání zůstává opakovatelné. Pouze `inflight` bez zapsaného výsledku přejde do `unknown` a nebude duplicitně odesláno. Nově zaregistrované zařízení nemá rezervaci, proto nedostane zpětně staré oznámení. Opakování je mimo tiché hodiny a bez dalšího započtení do denního limitu.
7. **Snooze před prvním odesláním:** `pending` se samými nedotčenými rezervacemi `reserved` se transakčně uvolní, takže po vypršení snooze může být stejný výskyt znovu naplánován. `dismissed` zůstává potlačeno.

Souhrn: `{users, sent, held:{quiet_hours, daily_limit, disabled}}` (a `busy`),
bez titulků a ID.

## Záruky

- Žádný vstup klienta nevybírá uživatele ani cíl; sender dostane jen
  `(userId, targetId, payload)` vlastníka cíle.
- Tiché hodiny a vyhodnocení termínu se řídí uloženým pásmem každého uživatele;
  dva uživatelé ve stejném okamžiku se mohou lišit.
- Push nikdy nejde viewerovi, nepřiřazenému, jinému řešiteli ani odebranému
  členovi; snooze/dismiss nikdy nepošle.
- Restart: osiřelý `pending` (>15 min) se zapsaným `sent` přejde na `sent`/`partial` se skutečným časem odeslání (24h limit). Potvrzené `failed` cíle zůstávají opakovatelné (max. 3 skutečně zahájené pokusy na zařízení); `inflight` cíle bez zapsaného výsledku přejdou do `unknown` a neopakují se; `reserved` cíle se mohou po restartu dokončit **i po více než třech pádech před prvním odesláním**. Parent `attempts` sleduje nejvyšší počet skutečně zahájených pokusů zařízení, nikoli počet claimů. Parent je `undelivered` jen bez doručení a bez opakovatelného cíle. Čerstvý `pending` zůstává rozpracovaný.
- Výjimka jednoho uživatele ani sender, který vyhodí chybu (= `failed`),
  neukončí průchod ostatních.

## Známá omezení / rozhodnutí

- Mezi pre-send kontrolou a skutečným odesláním je neodstranitelné okno
  (odeslání je síťová operace mimo transakci); kontrola ho zužuje na jedno
  zařízení.
- Změna revize nastavení (včetně snížení denního limitu) ruší dosud
  neodeslané nové claimy před dalším odesláním; při novém průchodu se
  vyhodnotí aktuální limit. Doručení, které již dosáhlo některého zařízení,
  se dokončuje podle trvale zapsaných výsledků.
- Pokud uživatel mezi claimem a odesláním push vypne nebo pozastaví, již
  částečně doručený výskyt se dokončí podle zapsaných výsledků; dosud
  nedoručený claim může být uvolněn nebo uzavřen dle stavu zařízení.
- Staré `failed` řádky s attempts < 3 přežijí vypnutí/zapnutí (guard nedovolí
  přepsat je na `baseline`) a mohou se po opětovném zapnutí zopakovat.
- Zápis průchodu používá journal (anchor), proto každá změna stavu zapisuje
  krátký obsahu prostý záznam; pro staging je to přijatelné.

### Doplněno po nezávislém testu (review)

- Kontrola těsně před **každým** odesláním nově čte i lifecycle stav aktéra:
  `dismissed` nebo platný `snoozed` výskyt zastaví další zařízení téže zprávy.
- Odeslání, které se nevyřídí do `TARGET_PUSH_SEND_TIMEOUT_MS` (30 s), se počítá
  jako `failed` (později max. 3 pokusy) a neblokuje jednovláknový průchod.
  Pokud služba zprávu po timeoutu přece doručí, může opakovaný pokus vést k
  duplicitě na tomtéž zařízení — přijatá hranice místo trvalého zablokování.
- Strop 256 identit na průchod má rotující začátek (krok za minutu), takže
  identity nad strop přijdou na řadu v dalších průchodech; souhrn vrací
  `deferred`.
- Poškozený baseline marker nebo pásmo v DB (obejití CHECK) způsobí selhání
  preflightu celého staging úložiště — průchod nic nepošle nikomu
  (fail-closed celého úložiště, nikoli jen jednoho uživatele).
- Odezva registrace zařízení odliší „nový“ od „patří jinému“ (`unavailable`);
  zneužití vyžaduje znalost přesné adresy endpointu cizího zařízení (přijaté riziko, [rozhodnutí 2026-11-08](decisions/2026-11-08-ai-telo-poznamek-a-retence.md), Q4).
- Položka vzniklá během pauzy se po jejím zrušení ohlásí, pokud stále platí
  (pauza potlačuje odesílání, nikoli vyhodnocení) — **potvrzeno vlastníkem 2026-11-08** ([rozhodnutí 2026-11-08](decisions/2026-11-08-ai-telo-poznamek-a-retence.md), Q3).
- Jediné zařízení se stavem `gone` uzavře doručení jako `failed` (3 pokusy),
  nikoli `undelivered`; znovu se neodesílá.

## Co zbývá

- **R2d.5d.3:** HTTP pro nastavení a cíle (ve výchozím stavu vypnuté).
- Skutečný web-push klient, import subscription a plánovač až při R4 cutoveru.
