# R3-slice UI-04b — osobní „Kdy: Dnes / Zítra“ v izolovaném Mém plánu

**Stav:** implementovaný interaktivní stagingový řez, **výchozí stav vypnutý**. Nepropojuje produkční Můj plán, neinstaluje data, nezapíná žádný existující endpoint a nemění společný termín `dueOn`.

## Nezávislé serverové brány

Celý náhled `/target-staging/my-plan/preview` zůstává skrytý jako HTTP 404 bez doslovného `true` u `AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED`, `AI_EXECUTIVE_TARGET_STAGING_HTTP_MY_PLAN_DAY_ENABLED`, `AI_EXECUTIVE_TARGET_STAGING_HTTP_MY_PLAN_SLICE_ENABLED` a `AI_EXECUTIVE_TARGET_STAGING_MY_PLAN_CLIENT_PREVIEW_ENABLED`.

Ovládání osobního dne má **vlastní** serverovou bránu `AI_EXECUTIVE_TARGET_STAGING_MY_PLAN_WHEN_UI_ENABLED=true`. Navíc vyžaduje **všechny čtyři** serverové personal-when endpoint brány:

- `AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED=true`
- `AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED=true`
- `AI_EXECUTIVE_TARGET_STAGING_HTTP_PERSONAL_WHEN_ENABLED=true`
- `AI_EXECUTIVE_TARGET_STAGING_HTTP_PERSONAL_WHEN_WRITE_ENABLED=true`

Jedna chybějící hodnota z pěti = žádná tlačítka Dnes/Zítra. Neexistuje veřejný NEXT_PUBLIC přepínač. Zpřístupnění UI není autorizačním tokenem: server znovu ověřuje identitu, session, přiřazení, Area ACL, soukromou epochu, stav úkolu, restore generation a přesné CAS pod pinned transakcí. Ovládání dokončení z UI-03b má **jinou** nezávislou bránu a nikdy se automaticky nezapíná současně.

## Uživatelské chování

- U otevřeného úkolu dostupného v aktuálně autorizovaném dvoudenním Mém plánu jsou dvě čtvercové akce *Kdy: Dnes* a *Kdy: Zítra*, s cílovou plochou minimálně 44 px. Aktuálně nastavený den nedává neúčinné tlačítko. Akce jsou aktivní jen pro automaticky sledovaný **skutečný lokální dnešek**, nikoli ručně připnutý historický den. Zadání se převede na `YYYY-MM-DD` bez sčítání UTC milisekund přes přechod DST. Vizuální termín z `dueOn` zůstává nedotčen.
- Syntéza ze starého nebo cizího řádku neprojde: při každém kliknutí se znovu načte **přesný šestipolový** `personal-when/command` preview, ověří se shodná Oblast a **tři nezávislé CAS** (revize úkolu, soukromá epocha, revize konkrétního osobního plánu). Po jednom `PATCH` s novým UUID se status potvrzuje pouze přes přísnou 200 odpověď či původní receipt. Žádný optimistic toggle, offline cache ani fronta.
- Dokončení a plánování sdílejí synchronní in-memory mutex: stav `pending/checking/uncertain` v jedné větvi zabraňuje všem statusovým i osobním mutacím a skrývá staré řádky. Nový autorizovaný GET Mého plánu proběhne po každém jistém výsledku i konfliktu. Staré úkoly se nevykreslují ani při čekání na re-autorizaci.
- Při výpadku sítě, 503, po-commit 401/403/404, neplatné odpovědi nebo abort po odeslání `PATCH` zůstává výsledek **nejistý**. Příkaz přežije jen ve volatilním `ref`; **nikdy se neopakuje PATCH**. Po úspěšně autorizovaném My Plan GET se může uživatel rozhodnout zkontrolovat **jen původní read-only receipt POST**, se stejným UUID a stejnými osmi CAS poli. `not_recorded` neumožňuje znovu odeslat změnu. Při chybě autorizovaného list GET je zvlášť dostupné „Znovu ověřit osobní přehled (bez zápisu)“ — opakuje jen GET, zachovává původní CAS.
- Potvrzené plánování má samostatné **Vrátit osobní plán (Undo)**. Uloží si původní `whenOn`, poté pod **aktuálním aktérem** read-only ověří receipt původního příkazu a teprve pak načte **nový CAS preview**. Undo se smí poslat jen pokud autoritativní `whenOn` stále odpovídá naposledy potvrzenému příkazu; jinak konflikt, žádné přepsání mezitím změněného osobního plánu. Reverzní `PATCH` má nový UUID. Ověřitelná před-CAS chyba 503 či jisté odmítnutí zápisu neztratí původní potvrzený Undo; dočasná chyba následného list GET také ne.
- Po odeslání reverzního PATCH s nejistým výsledkem se původní Undo již nenabízí; lze zkontrolovat pouze **nový** příkaz. Změna identity/Area/kalendářního kontextu, odhlášení, `visibilitychange`, `pagehide`, offline a nové svědectví oprávnění odstraní předchozí potvrzené Undo; žádná soukromá data se neukládají do IndexedDB, localStorage, sessionStorage či service workeru.

## Omezení a release

Tento řez neobsahuje celý kalendář, projektové plánování, globální `Vše`, změny `dueOn`, pravidla opakování ani produkční cutover. UI vykresluje jen serverem autorizované otevřené úkoly; pozice řádku může být nadále určena dřívějším společným termínem i po přesunu osobního dne (výpočet `attentionOn`).

`tests/target-staging-my-plan-when-ui04b.test.mjs` a existující klientské/statusové testy kontrolují všechny brány, 44px ovládání, vzájemný mutex, klientské CAS a receipt, 503/revokaci, absence PATCH retry, datum/DST, vlastní a cizí Oblast, Undo i možnost návratu po neúspěšném načtení. Cílené testy používají mock HTTP a zdrojové invarianty Reactu, nikoli reálné browserové toky.

**Před produkčním releasem:** exact-SHA browser E2E pro mobil/desktop, offline, synchronní dvojklik, změnu identity, sdílenou Area / odebrání přiřazení, restore generation a případné konflikty osobního plánu; bezpečnostní revize, backup+restore, samostatné schválení aktivace. Bez explicitního schválení se neprovádí produkční deploy, cutover, migrace ani reset.
