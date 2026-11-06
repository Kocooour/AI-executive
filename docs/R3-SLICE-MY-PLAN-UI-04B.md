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


## Oprava P1 — synchronní ochrana toolbaru

`Den`, `Moje práce` i `Aktuální den` používají společnou funkci `myPlanToolbarChangeBlocked`. Kontrola probíhá **přímo v obsluze události před `resetFeedback()`**, nejen přes `disabled`: zahrnuje poslední React stav `anyPending` a zároveň aktuální, synchronně nastavované `statusOperation.current` i `whenOperation.current`. Rychlá druhá událost ještě před překreslením proto nemůže vymazat původní osmipolový CAS/UUID, změnit filtr či den nebo zahájit jiný tok, zatímco mohl být odeslán PATCH.

`tests/target-staging-my-plan-toolbar-lock-ui04b.test.mjs` ověřuje všechny tři propojené handlery a vykonává závod `whenOn PATCH in-flight → queued Area/Today event before React render → network response lost/receipt 503 → original receipt committed`. Očekává jediný PATCH, nulové resetování příkazu a možnost původní read-only receipt kontroly.


## Oprava P1 — potvrzené Undo při neúspěšném zápisu v jiné větvi

Potvrzené Undo dokončení nebo osobního dne **nesmí zmizet pouhým zahájením jiné operace**. Rozpracovaný status/when příkaz synchronně zablokuje obě rodiny akcí a skryje staré řádky i tlačítka Undo. Při 503/offline/409/chybné odpovědi na **čtecí** CAS preflight nebo při definitivním odmítnutí 400/409 z PATCH se původní potvrzení jiné rodiny zachová ve volatilní paměti; po dalším serverově autorizovaném GET je Undo opět dostupné.

Původní Undo druhé rodiny se zneplatní **pouze po skutečně potvrzeném nebo potenciálně potvrzeném** novém zápisu (výsledek `committed` nebo `uncertain`). U nejistého příkazu se zachová jen přesný aktuální CAS/UUID pro manuální read-only receipt, nikoli možnost zopakovat PATCH. Při signed-out, revokaci ACL při načítání, skrytí stránky, offline nebo změně kontextu se obě dřívější potvrzení zneplatní.

`tests/target-staging-my-plan-cross-family-undo-ui04b.test.mjs` vykonává `status A committed → when B GET 503 → fresh actor list GET → original status Undo receipt/CAS` i `when A committed → status B GET 503 → fresh list GET → original when Undo receipt/CAS`, bez nového PATCH. Ověřuje 400/409 oproti committed/uncertain pro obě transportní rodiny a současně kontroluje, že při rozpracované druhé operaci nejsou tlačítka Undo vykreslená. Tyto testy nenahrazují browser E2E nad release SHA.
