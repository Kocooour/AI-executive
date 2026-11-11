# R3-FE — soukromý Quick Capture úkolu (opt-in)

**Navazuje:** #390 (SQLite writer), #393 (HTTP CREATE a read-only exact-command status).
Tento krok propojuje existující globální plovoucí Quick Capture s jediným
samostatným úkolem v explicitně zvolené soukromé Oblasti. **Žádná produkční aktivace.**

## Zapnutí a rozsah

Vyžaduje všechny existující default-off brány pro cílový Lumi v1 shell,
soukromý Notes Area catalogue a Notes create-preview, plus
`AI_EXECUTIVE_TARGET_STAGING_HTTP_TASKS_CREATE_ENABLED=true` a novou
`AI_EXECUTIVE_TARGET_UI_PRIVATE_TASK_CREATE_ENABLED=true`. Používá totiž stávající
ověřený seznam soukromých Oblastí a read-only preflight
`POST /api/target-staging/notes/create-preview`; odtud přijímá aktuální
restore generation. Není to autorizace k zápisu: task INSERT provádí vlastní
nezávislou transakční Area/session kontrolu. **Toto spojení s Notes flagy je
dočasná závislost UI**, nikoli koncepce sdíleného oprávnění.

Globální + na mobilu a desktopu otevírá soukromý úkol, má přepnutí na
soukromou poznámku a opačně. Tlačítko na Notes seznamu otevírá poznámku.
Výběr Oblasti je vždy explicitní, bez implicitního sdílení a bez možnosti
projektu či assignee. Po potvrzení úkolu lze přejít do serverového Mého plánu
(pokud je jeho target verze zapnutá); aktivní filtr Sdílené se změní na
Osobní, aby byl soukromý úkol vidět. Starý legacy Capture při zapnutém
cílovém režimu nikdy nezapisuje.

## Bezpečnost pending/uncertain

- Každé vytvoření má nové jednorázové `taskId` a `commandId`. POST je
  odeslaný právě jednou. Přerušení sítě nebo opožděná odpověď nejsou důkaz
  neúspěchu; nikdy automaticky nevytvářet náhradní UUID.
- Ještě před POST se do `sessionStorage` záložky uloží **pouze** neprůhledné
  `commandId` a nesekretní autentizační generation. Název, Area, taskId a
  restore-generation nejsou v browser storage. Živá runtime session drží přesný
  původní příkaz jen v RAM, aby bylo možné bezpečně volat
  `POST /api/target-staging/tasks/create-status` (read-only). Status
  `not_recorded` ponechá zábranu. Ani úspěšné HTTP `201`, ani read-only
  `committed` ji neodstraní před doručením: teprve ověřená viditelná session,
  která skutečně přebírá potvrzení v UI, atomicky odstraní neprůhledný marker
  pro přesné původní `commandId`. Při chybě storage zůstane vše zablokované.
- Po úplném reloadu nebo změně identity, i po kladné odpovědi serveru
  dosud nedoručené do UI, zmizí originální title z paměti, ale neprůhledný
  marker zůstává zachovaný a blokuje jakýkoli nový POST.
  Serverový status bez přesného původního příkazu **nelze bezpečně ověřit**.
  Zábrana proto zůstává záměrně uzamčená a UI tuto skutečnost vysvětluje.
  To je release blocker pro běžné bezobslužné používání, ne příležitost
  zavést únik privátního textu do storage. Další iterace vyžaduje bezpečnou
  obnovu bez původního plaintextu nebo explicitní operátorské vyřešení.
- Skrývání, offline, BFCache a unmount zneplatní soukromé Area a odstraní
  neodeslaný text z modalu. Odeslaný příkaz vlastní runtime, ne modal;
  zatímco nejasný výsledek blokuje další úkol, nedochází k legacy fallbacku.
  Zavření modalu před odesláním je bezpečné zrušení; odeslaný příkaz nelze
  považovat za zrušený samotným zavřením.

## Ověření a zbývající práce

```bash
node --experimental-loader ./tests/ts-loader.mjs --test tests/target-private-task-create-client.test.mjs
```

Testy validují přesný HTTP DTO a command body, odmítnutí dalšího POST po
uncertain, read-only status s původním obsahem, privacy tab markeru a default-off
gate. CI navíc Typecheck, produkční build a regresní testy.

**Neuzavřené akceptační body:** UX Undo po potvrzeném CREATE, skutečné
browser E2E mobil/desktop na release SHA a bezpečný postup obnovy po reloadu
bez původního plaintextu. **PR zůstává Draft**, dokud tyto brány nebo
výslovně schválené oddělení další iterace nejsou vyřešené. R4 cutover,
reálná data a produkční nasazení nejsou součástí.
