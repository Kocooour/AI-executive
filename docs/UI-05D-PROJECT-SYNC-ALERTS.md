# UI-05d — Identita projektu v upozorněních na synchronizaci

## Rozsah

Samostatné pokračování UI-05c na aktuálním `main`. Jen opt-in náhled Lumi v1 (`NEXT_PUBLIC_LUMI_DESIGN_V1_PREVIEW=1`); nepovoluje nové zápisy, role, oprávnění, cílové API ani produkční cutover.

- Každé nevyřízené upozornění na neúspěšnou synchronizaci projektu má již samostatný identifikátor a pravidla pro Undo/serverové potvrzení. V UI-05d se k němu přidává **název projektu zachycený při konkrétní lokální akci**.
- Globální `role="alert"` vypisuje název projektu přímo před textem o nedokončené synchronizaci. Samostatné tlačítko má v češtině i angličtině přístupný název obsahující identitu projektu. Při více souběžných selháních jsou zprávy čitelné a jednoznačně rozlišitelné.
- Je-li název prázdný či nedostupný, zobrazí se existující neprůhledné ID. Název je pouze prezentační nápověda již provedené akce, **nikoliv zdroj autorizace**; základy synchronizace, nezávislé řešení upozornění a legacy flag-off chování se nemění.
- Jednotkové testy ověřují dva projekty, vlastní skrytí, Undo jen jednoho z nich, dostupné popisky obou jazyků a fallback názvu. CI: typecheck, cílené testy a production build. Browser E2E až před produkčním nasazením.
