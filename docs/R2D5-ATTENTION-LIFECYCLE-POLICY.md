# R2d.5b.0 — čistá politika životního cyklu Attention podle schématu v22

**Stav:** interní staging-only podřez navazující na R2d.5a (#315) a již sloučené schéma R2d.5b.1 (#319). Nemění databázové schéma, neprovádí zápis, nevystavuje HTTP, scheduler ani push a nezapíná produkční UI. Legacy modul Attention zůstává beze změny.

## Přesná reprezentace v22

Funkce **`planTargetAttentionLifecycle(snapshot, witness, action)`** je čistý plán pro budoucí pinned writer, nikoli oprávnění ani hotový příkaz.

- **`snapshot.row === null` je jediná reprezentace `active`.** V tabulce `personal_attention_states` žádný aktivní řádek neexistuje. Skrytý řádek obsahuje výhradně `state: snoozed|dismissed`, `snoozedUntilMs` a celočíselnou `revision`. Nevymýšlíme persistovaný `changedAtMs` ani `sourceRevision`.
- Snapshot nese identitu aktéra, generaci obnovy, `attentionKey`, klíč úkolu/pravidla/výskytu, aktuální per-user `attentionEpoch` a surový stavový řádek (nebo null). Svědectví nese znovu ověřenou identitu/generaci/epochu a **aktuálního způsobilého kandidáta** včetně jeho `sourceRevision` z úkolu. Obě klíčové vazby musí odpovídat znovu vypočtenému `attentionKey`.
- **Pozor na vypršení odkladu:** autorizovaný čtecí selektor hlásí u *již expirovaného* `snoozed` řádku `lifecycle=active`, ale od R2d.5b.2 vrací jeho skutečnou `lifecycleRevision` (dříve `null`). Pinned writer (R2d.5b.2) přesto čte **surový DB řádek** v transakci a z veřejného `lifecycle` jeho existenci neodvozuje.
- Každá akce nese očekávanou `expectedSourceRevision`, `expectedAttentionEpoch` a nullable `expectedLifecycleRevision`. Planner porovnává i epochu svědectví. **Budoucí writer musí porovnat stejnou CAS trojici znovu uvnitř atomické transakce** společně s aktuální session, Area ACL, osobní epochou, restore generation a identitou výskytu.
- **ABA:** revize nově vloženého řádku začíná znovu na 0. Proto samotná revize řádku není dostatečná; monotónní `personal_attention_epochs.revision` roste při INSERT, UPDATE i DELETE a rozlišuje i smazání a opětovné vložení.

## Přechody

| Akce | Výchozí stav | Plán v22 | Viditelnost a audit |
| --- | --- | --- | --- |
| `snooze` | bez řádku = active | **INSERT**, `revision=0`, `snoozed_until_ms` v budoucnu, max. 30 dní | skryto, `user_snoozed` |
| `dismiss` | bez řádku = active | **INSERT**, `revision=0`, `snoozed_until_ms=NULL` | skryto, `user_dismissed`; úkol se nedokončuje |
| `restore` (Undo) | existující skrytý řádek | **DELETE** s CAS řádku + epochu | znovu aktivní, `user_restored` |
| `recheck` před expirací | stále skrytý řádek | žádná změna | skryto, bez auditu |
| `recheck` po expiraci odkladu | expirovaný `snoozed` řádek + znovu autorizovaný kandidát | **DELETE** s CAS řádku + epochu | znovu aktivní, `snooze_expired` |
| `recheck` po běžné změně názvu | `dismissed` | žádná změna | zůstává skryto |
| `recheck` bez řádku | active | žádná změna | aktivní, bez auditu |

Výstup obsahuje pouze `operation: none|insert|delete`, následující skrytý řádek (nebo null), viditelnost, CAS podmínky a nanejvýš jeden obsahově neutrální auditní plán. Nemůže přenášet název, obsah poznámky, Area ID, token ani cizí data. Starý/stale příkaz nemá auditní ani DB efekt. Jiné identity, generace obnovy a výskyty vracejí nerozlišitelné `unavailable`.

## Bezpečnostní hranice budoucího zapisovače R2d.5b.2

Čistý reducer **neumí autentizovat klienta**, odhalit revokaci, ověřit úplnost kandidátů ani zapisovat receipty či skutečný audit. Volající nesmí převzít aktéra, čas, snapshot ani kandidáta z klientského JSON. Všechny údaje musí získat z důvěryhodného serverového/pinned čtení.

V jedné transakci musí writer znovu ověřit živou relaci, Area a soukromou epochu, restore generation, otevřený oprávněný úkol, současnou způsobilost pravidla/výskytu, revizi zdroje, per-user Attention epochu, existenci a revizi stavového řádku, idempotentní receipt a audit. SQL stav odvozený z `operation` se nesmí aplikovat bez opětovné kontroly. Expirace a restore **mažou** skrytý řádek, nevkládají aktivní záznam. Reconcile resolved/superseded řeší konkrétní zdrojové změny a triggery v22; nepřítomnost kandidáta ve stránkovaném seznamu není důkaz vyřešení.

## Integrační ověření

- `tests/target-attention-lifecycle-policy.test.mjs` — čistá politika, validace struktur, vazba aktéra/generace/výskytu, přesná CAS trojice, 30 dní, restore/expirace, neplatné vstupy, žádné DB/network závislosti.
- `tests/target-attention-lifecycle-v22-integration.test.mjs` — **reálné schéma v22 a skutečný autorizovaný Attention selector** na zcela izolované syntetické databázi; ověřuje aktivní stav bez řádku, skutečný INSERT revize 0, expiraci a DELETE, obnovení, trvání dismiss přes změnu názvu, stale retry/ABA přes epochu a ztrátu aktuální zdrojové revize. Testovací transakční adaptér je pouze důkaz kompatibility CAS se schématem, není produkční writer ani substitut auth.
- `tests/target-attention-lifecycle-schema.test.mjs` (#319) — triggery v22, epochy, revize, ACL a reconcile.

Testy používat na PR včetně `PR Checks`. Produkční databáze, migrace a plná Browser E2E se nemění; E2E patří do předprodukční release brány.
