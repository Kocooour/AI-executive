# AttentionItem

Doporučení v sekci Pozornost na Home (LUMI-UX-001, 009): název a pod ním důvod, zdroj a čas vyhodnocení.

**Co dodává volající:** název, krátký důvod (např. „Po termínu od 13. 10.“, „Nemá další krok“), tón důvodu (`danger` / `muted`), zdroj jako krátký typ důkazu („termín úkolu“, „aktivita projektu“), čas vyhodnocení (hodina, u dat starších než dnes i datum), akce Otevřít, Odložit, Skrýt.

**Pravidla**
- Dva řádky: název a *důvod · zdroj · čas vyhodnocení* (`meta`; důvod může nést tón `danger`). Tím karta splňuje `docs/UX-UI.md` bez rozbalování a funguje na dotyku i z klávesnice.
- Nespoléhat na `title`/nápovědu – není dostupná na dotyku ani fokusem. ID zdrojů, revize a časová zóna jsou v detailu.
- Zastaralá data: čas vyhodnocení v barvě `warning` se slovem „zastaralé“ a akce Odložit/Skrýt vypnuté.
- Otevřít je vždy vidět; Odložit a Skrýt po najetí nebo fokusu (na klávesnici vždy dosažitelné), na mobilu v detailu.
- Nejvýše pět položek. Prázdný stav: sekce se nezobrazí.
