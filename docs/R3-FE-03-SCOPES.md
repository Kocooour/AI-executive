# R3-FE-3 — globální přepínač Vše / Osobní / Sdílené v hlavní aplikaci

**Stav:** default-off, bez produkční aktivace, jen čtení. První řez UI-09/R3 ([ROADMAP](ROADMAP.md)); navazuje na [R3-FE-1](R3-FE-01-CLIENT-RUNTIME.md) a [R3-FE-2](R3-FE-02-MY-PLAN.md), staví na stagingovém globálním indexu ([R2D-GLOBAL-COMBINED-HTTP](R2D-GLOBAL-COMBINED-HTTP.md), [UI-09a](R3-SLICE-GLOBAL-INDEX-UI-09A.md)). Kanonická sémantika: [PRODUCT.md](PRODUCT.md) (LUMI-FR-013, „Jediný globální přepínač čtecího rozsahu“) a [UX-UI.md](UX-UI.md).

## Příznaky

Přepínač se zapne **jen když jsou všechny tři proměnné přesně `"true"`** (čte `targetUiConfig` v `lib/target-ui-config.ts` při každém požadavku). Každý seznam má navíc **vlastní příznak dedikované serverové trasy**; pohled bez svého příznaku zůstává dosavadní (legacy).

| Příznak | Význam |
| --- | --- |
| `AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED` | stagingové HTTP |
| `AI_EXECUTIVE_TARGET_UI_ENABLED` | klientský běh R3-FE-1 (provider) |
| `AI_EXECUTIVE_TARGET_UI_SCOPES_ENABLED` | **nový:** přepínač rozsahu |
| `AI_EXECUTIVE_TARGET_STAGING_HTTP_GLOBAL_PROJECTS_ENABLED` | pohled Projekty ze serverového indexu (`project-index/global`, [R2D-GLOBAL-PROJECT-HTTP](R2D-GLOBAL-PROJECT-HTTP.md)) |
| `AI_EXECUTIVE_TARGET_STAGING_HTTP_GLOBAL_NOTES_ENABLED` | pohled Poznámky ze serverového indexu (`note-index/global`, [R2D-GLOBAL-NOTE-HTTP](R2D-GLOBAL-NOTE-HTTP.md)) |

Konfigurace má nově tvar `{myPlan:{…},scopes:{enabled,projects,notes}}`; příznaky seznamů bez příznaku přepínače nic nezapnou. Provider (a ověření `/api/target-staging/session`) se připojí, pokud je zapnutý Můj plán **nebo** přepínač. Příznaky Mého plánu a rozsahů jsou na sobě nezávislé. Při vypnutých příznacích je strom identický s dosavadním: žádný přepínač, žádný nový požadavek, moduly přepínače a seznamů se nenačtou (`next/dynamic`, `ssr:false`). Kombinovaný index (`global-index`) tato část nepoužívá.

## Sémantika

- **Vše** = úplná množina serverově autorizovaných položek ze soukromých i sdílených Oblastí (včetně projektů bez mých úkolů). **Osobní** = moje soukromé Oblasti. **Sdílené** = autorizované sdílené Oblasti.
- Hodnota přepínače **jen vybírá serverový dotaz** (`scope=` u `GET /api/target-staging/project-index/global` resp. `note-index/global`, resp. `areaFilter` u plátku Mého plánu). Nikdy není autorizačním tvrzením, klient nic nefiltruje ani nepočítá; server vynucuje identitu a Area ACL.
- **Můj plán není hodnota přepínače.** Vložený plán dál zobrazuje jen moji práci: *Vše* = všechna **moje** práce, *Osobní* / *Sdílené* ji zužují. Vlastní filtr „Moje práce“ se v tomto režimu skryje; samostatná stagingová stránka Mého plánu jej zachovává.
- Barvy rozsahů dle UX-UI: Vše `#8B5CF6`, Osobní `#16A34A`, Sdílené `#2563EB`. Barva nese jen rozsah (kroužek + obrys), text zůstává tmavý pro kontrast.

## Stav v adrese

`?scope=all|personal|shared`, výchozí `all` se vynechává; neznámá, prázdná nebo opakovaná hodnota se čte jako `all`. Je to jediný zdroj pravdy (`lib/view-url.ts`: `scopeFromSearch`, `searchWithScope`, `searchWithoutScope`; hook `app/ui/target-scope-state.ts`). Volba přepínače vytvoří nový záznam historie, takže znovunačtení, Zpět/Vpřed a přímý odkaz rozsah obnoví. Změna pohledu klíč `scope` zachová (`addressUpdate`, `viewExitFromProject`); `targetFromSearch` a rozpoznání náhledu Mého plánu klíč ignorují, takže neovlivní cíl pohledu ani záznamu. Nic se neukládá do localStorage / sessionStorage / IndexedDB.

## Kde se přepínač zobrazuje a co přepíná

- Přepínač (`role="radiogroup"`, tlačítka `role="radio"` s `aria-checked`, šipky/Home/End, viditelné zaostření, cíle ≥ 44 px, cs/en z `lib/target-scopes-copy.ts`) je v obsahové části pod nadpisem pohledu — na desktopu i mobilu — v pohledech **Projekty**, **Poznámky** a **Můj plán** (v1 shell, cílový režim).
- **Projekty** (cílový režim): názvy projektů z `project-index/global` pro zvolený rozsah, seskupené do klidných bloků podle Oblasti (osobní světle zelená, sdílená světle modrá) **bez viditelných nadpisů Oblastí**, bez počtů a průběhu, typografie jako u úkolů. Skupina má pro čtečku popisek „Osobní / Sdílená Oblast“. Stránkování serverovým kurzorem („Načíst další“).
- **Poznámky** (cílový režim): jen názvy poznámek z `note-index/global`. Obě trasy vracejí jediný druh, takže klient nic nevybírá ani nefiltruje; striktní parsování DTO, kontrola řazení, rozsahu a řetězu kurzorů se sdílí s klientem kombinovaného indexu (`lib/target-staging-kind-index-client.ts`).
- Dosavadní seznam Projektů (resp. Poznámek) je skrytý jen tehdy, když je zapnutý příznak tohoto pohledu; ostatní pohledy zůstávají dosavadní.

## Životní cyklus (jako R3-FE-2)

1. Čtení existuje jen pro serverem potvrzenou generaci (`runtime.known()`); relace čtení se vytváří přes `useTargetSession`, klíčovaná generací **a rozsahem**.
2. Změna rozsahu nebo generace relaci uvolní a řádky předchozího rozsahu zmizí okamžitě, ještě před novým čtením (zobrazí se jen řádky aktuální relace a stránky se shodným `scope`).
3. `hidden` / `pagehide` / `offline` názvy skryjí; po návratu se nejprve znovu ověří (žádné automatické předčítání, `resume()` nic nenačítá). 401/403 jde přes rozpočet odmítnutí (`createRefusalBudget`), poté stav „odmítnuto“ s ručním ověřením.
4. **Vědomé rozhodnutí:** při „Načíst další“ zůstávají již autorizované řádky téže relace viditelné (na rozdíl od samostatného náhledu, který je při stránkování skrývá) — jde o tutéž relaci a identitu bez události soukromí, takže seznam neproblikává. Jakákoli chyba (včetně 401/409) je skryje všechny. Žádná perzistence, žádné logování obsahu.

## Omezení

- **Jen čtení:** řádky jsou text, bez navigace do detailu a bez zápisů — to je R3-FE-4 (tichá poznámka v UI).
- Počet řádků na stránku určuje server (výchozí 50); seznam nezobrazuje počty ani průběh.
- Vyhledávání zatím rozsahem nezužuje. Boční panel a ostatní pohledy dál vycházejí z dosavadních dat.
- Při otevření staršího (místního) detailu projektu se klíč `scope` z adresy ztratí (číst: výchozí Vše); detaily v cílovém režimu jsou předmětem R3-FE-4.
- Pokud při změně rozsahu probíhá zápis Mého plánu, jeho stav se nezahazuje; teprve po dokončení se zpětná vazba (Undo) předchozího rozsahu vyčistí.
- Žádná produkční aktivace; plná Browser E2E se nespouští.
