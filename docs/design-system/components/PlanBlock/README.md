# PlanBlock

Řádek plánu dne nebo kalendáře, který odliší událost, přijatý blok a návrh (LUMI-UX-001, 004, 012, 013).

**Co dodává volající:** čas, druh `event | confirmed | proposed`, název, trvání; u návrhu `onAccept` a v detailu Jiný čas / Zítra / Neplánovat.

**Pravidla**
- Událost: výplň `surface-subtle`. Přijatý blok: plný okraj `accent`. Návrh: přerušovaný okraj `proposal` + štítek „Návrh“ (`caption`, výplň `accent-soft`).
- Jeden řádek: čas, název a jediný údaj vpravo (trvání). Důvod („Proč právě teď“) a zdroj dostupnosti v detailu.
- Kapacita jedním údajem v nadpisu („3 h volno“); bez čerstvého kalendáře se nezobrazí a návrhy nemají čas.
- Přijetí jde přes stejné schválení jako ProposalCard.
