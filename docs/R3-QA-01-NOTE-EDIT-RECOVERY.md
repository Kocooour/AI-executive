# R3-QA-01 — prohlížečová akceptace obnovy editace poznámky

**Stav:** cílená syntetická integrační QA v reálném React/Next.js UI Lumi, **nikoli** plná release Browser E2E ani produkční aktivace. Navazuje na sloučený [PR #368](https://github.com/Kocooour/AI-executive/pull/368) a [R3-FE-4b](R3-FE-04B-NOTE-DETAIL-EDIT.md). Bezpečnostní regresní výjimka pro opravený P1, protože čistě unit test koordinátoru neověří zavření skutečné komponenty, Back/Forward a životní cyklus prohlížeče.

## Měřitelný výsledek

Pro jednu serverově potvrzenou identitu a dvě autorizované soukromé poznámky v izolovaném browser test serveru proběhne **každý ze tří scénářů zvlášť na 390 px (mobil) i 1280 px (desktop)**. Browser workflow spouští stejné případy ve třech nezávislých konfiguračních profilech (původní editor, oba editační flags, pouze nový 4b flag), tedy celkem 18 případů:

1. **První PATCH končí definitivním 409 až po zavření detailu.** Koordinátor musí uvolnit marker bez namountovaného editoru a následný pokus o editaci druhé poznámky musí být možný na telefonu (390 px) i desktopu (1280 px). Nevznikne nový příkaz A.
2. **Nejistý PATCH → zopakování přesného stejného UUID → 409.** Oprávněný uživatel dál přečte druhou poznámku, ale žádnou novou editaci nesmí odeslat; obsahově prázdný marker zůstane. Použije se stále stejný commandId.
3. **Reload po ztracené odpovědi.** Privátní koncept (název/tělo/CAS) nezůstane v DOM ani v tabovém storage; jen UUID a ověřená generace. Ve druhé poznámce lze explicitně zavolat **read-only** ověření původního příkazu. Odpověď `committed` uvolní marker, znovu autorizuje detail a **neodešle žádný PATCH**. `not_recorded`, 404 nebo timeout zůstávají podle unit kontraktů fail-closed.

Všechny tři scénáře testují **skutečně připojené UI komponenty a client runtime**, ale serverové endpointy `/api/target-staging/**` jsou při každém browser běhu přesměrované na pevně definované **syntetické odpovědi**. Nejde o důkaz serverové ACL (ten pokrývají existující HTTP/SQLite integrační testy), produkční autorizace ani offline E2E.

## Izolace a spuštění

`LUMI_TARGET_NOTE_EDIT_E2E=true` aktivuje v `playwright.config.ts` potřebné cílové UI a HTTP/write flags **pouze pro nezávislý, dočasný Playwright server**, nikoliv pro běžný běh Lumi. Na obyčejném serveru všechny nové flags zůstávají default-off.

Spuštění na izolované větvi s odděleným Playwright data adresářem a portem:

```bash
LUMI_TARGET_NOTE_EDIT_E2E=true E2E_PORT=3119 E2E_SKIP_BUILD=1 \
  pnpm exec playwright test e2e/target-note-edit-recovery.spec.ts --project=desktop
```

Před spuštěním musí být nainstalované závislosti, Chromium a sestavená produkční aplikace (`pnpm build`). Samostatný GitHub Actions workflow `r3-note-edit-recovery-browser.yml` provádí tyto kroky automaticky na větvi PR; soubory z pracovního stromu ani soukromé údaje nepoužívá. Release brána nadále vyžaduje **plnou Browser E2E na přesném release commitu před produkčním nasazením**. Profily lze pro lokální ověření nastavit přes `LUMI_TARGET_NOTE_EDIT_PROFILE=legacy|combined|4b` při `LUMI_TARGET_NOTE_EDIT_E2E=true`; jde pouze o jednorázový izolovaný testovací server. V obou 4b profilech se navíc ověřuje absence druhého PATCH editoru, dostupnost smazání před editačním PATCH, jeho zablokování při nejistém PATCH a opětovné povolení až po potvrzeném receipt.

## Další závislosti a omezení

- Quick Capture stále nelze bezpečně připojit k cílovému note-create API bez **serverově autorizovaného výběru zapisovatelných soukromých Oblastí**; aktivní filtr Vše/Osobní/Sdílené není důkazem oprávnění ani cílem zápisu.
- Otevřený projektový rename PR #370 a starší editační PR #365 se tímto QA nemění; žádný společný produktový flag se neaktivuje.
- Testy nejsou náhradou za reálné offline/bfcache scénáře, přístupovou revokaci, zálohu/restore, R4 inventuru či výslovný souhlas s cutoverem.
