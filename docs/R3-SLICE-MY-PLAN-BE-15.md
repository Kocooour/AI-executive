# R3-slice / BE-15 — okamžitý abort před HTTP hlavičkami Mého plánu

**Stav:** samostatná default-off stagingová iterace klientského transportu Mého plánu. Navazuje na BE-14 (8 MiB stream a fatal UTF-8). Není aktivace UI, produkční změna ani nová serverová autorita.

## Implementace
Klient `fetchMyPlanSlice()` nyní přeruší **čekání na hlavičky** podle `AbortSignal`, i pokud testovaný nebo vlastní fetch adaptér signál ignoruje a jeho Promise nikdy neskončí. Jediný uživatelem vyvolaný GET se spustí synchronně, takže rychlé přechody Dnes/Zítra nebo nové vyhledání nemění pořadí výzev.

Po abortu klient vrací `{ok:false,reason:"aborted"}` bez opakování či přednačítání. Přijde-li odpověď později, její `ReadableStream` se zruší, nikoli parsuje do nového aktérova stavu. Listener se v každé větvi odstraní. Nadále běží původní ochrana BE-14 na zablokované tělo, přísný allowlist, čtení pouze `same-origin/no-store`, serverová session, Area ACL a revizní bariéra.

## Testy
Tři izolované regresní scénáře: zablokovaný fetch ignorující abort a pozdější body cancel; abort vyvolaný přímo adaptérem před odpovědí; pre-abort bez GET a překrývající se rychlé explicitní požadavky se zachovaným synchronním spuštěním a bez obnovení starého výsledku.

Žádná změna API, zápisu, staging flagů, databáze, migrace, cutoveru ani nasazení. Plná Browser E2E zůstává až před produkčním nasazením na přesném SHA.
