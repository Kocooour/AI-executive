# R2d.5b.0 — čistá politika životního cyklu Attention (staging)

**Status:** samostatný interní podřez R2d.5b navazující na sloučené R2d.5a / PR #315. Nemění schéma v21, neprovádí zápisy, neposkytuje HTTP, scheduler ani push, neaktivuje produkční UI. Stávající legacy modul lib/attention-lifecycle.ts zůstává beze změny.

## Proč nejdřív čistá politika

Snooze/dismiss musí být atomicky svázán s aktérem, generací obnovy úložiště, čerstvě autorizovaným kandidátem a očekávanou revizí. Funkce **planTargetAttentionLifecycle(record, witness, action)** vrací pouze plán, nikoli zápis či oprávnění.

Volající jí **nesmí** předat identitu, aktuální stav kandidáta ani čas z neověřeného HTTP vstupu. Budoucí pinned writer (R2d.5b.2) musí uvnitř atomické transakce znovu ověřit live session, Area ACL, osobní epochu, stav zdroje a CAS/receipt, teprve poté commitnout změnu s auditní událostí. Čistý výsledek se nesmí automaticky serializovat klientovi.

## Přesný kontrakt

- Záznam nese pouze actorUserId, restoreGeneration, attentionKey, taskId, ruleId, relevantOn, sourceRevision, state, snoozeUntilMs a changedAtMs. **Žádný název úkolu, obsah poznámky, Area ID ani token.**
- Svědectví nese aktuálně ověřeného aktéra, restore generation a pět přesných polí kandidáta. attentionKey se vždy znovu vypočítá z pravidla, úkolu a data podle R2d.5a. Jiný aktér, restore generation, pravidlo nebo výskyt vrací nerozlišitelné **unavailable** bez záznamu; neplatné struktury jsou **invalid**.
- **snooze** a **dismiss** jsou povoleny jen ze stavu active, s očekávanou revizí zdroje a changedAtMs (příprava na CAS). Snooze musí končit v budoucnu, nejvýše za 30 dní podle serverového času. Dismiss nikdy nemění stav úkolu. Stale nebo opakovaný příkaz nepřipraví audit.
- **recheck** vyžaduje výslovně nově ověřeného stále způsobilého kandidáta. Před vypršením snooze ponechá položku skrytou; při vypršení ji může obnovit s auditním kódem snooze_expired. Dismiss zůstává skrytý i po běžné revizi stejného výskytu, například přejmenování úkolu.
- Úspěšný výsledek je obsahově neutrální: další stav, příznak viditelnosti, indikace změny a nejvýš jedna beztextová auditní událost. Žádný síťový požadavek ani persistence.

## Výslovná omezení

Tento díl **neimplementuje resolved ani superseded**: nepřítomnost na stránce či ve filtrovaných kandidátech může znamenat revokaci oprávnění, nikoli ukončení podmínky. K tomu bude nutný zdrojově ověřený stav a kompletní autorizovaný snapshot. Přechod deadline_soon na deadline_overdue vytváří nový key, takže dřívější dismiss se automaticky nepřenáší; naléhavost a notifikace vyřeší další podřez.

Navazuje R2d.5b.1 (sloučeno #319): schéma v22 s per-user content-free lifecycle, preflightem a reconcile triggery (resolved/superseded mazáním řádku při konkrétní zdrojové změně, nikoli z pouhé nepřítomnosti kandidáta); R2d.5b.2: interní pinned writer s CAS, receipts a auditem podle této politiky (navíc `restore` pro Undo); R2d.5c: default-off HTTP s live guardem a příkazy. Produkční cutover ani migrace nejsou povolené.

## Testy

Spuštění: **node --experimental-loader ./tests/ts-loader.mjs --test tests/target-attention-lifecycle-policy.test.mjs**.

Prověřuje cizí identity/generace/výskyty, revize a CAS, limity odkladu, expiraci, stale retry, trvání dismiss, odmítání nadbytečných nebo poškozených polí a nepřítomnost síťových/databázových závislostí. Full Browser E2E zůstává preproduction release gate.
