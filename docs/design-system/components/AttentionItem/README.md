# AttentionItem

Doporučení v sekci Pozornost na Home (LUMI-UX-001, 009): název a krátký důvod; podrobnosti v přístupném Proč?.

**Co dodává volající:** název, krátký důvod (např. „Po termínu od 13. 10.“, „Nemá další krok“), tón důvodu (`danger` / `muted`), oprávněný zdroj v běžné řeči („termín úkolu“, „aktivita projektu“), přesný čas vyhodnocení včetně data, pokud je potřeba pro jednoznačnost, a stav čerstvosti/nejistoty/konfliktu, akce Otevřít, Odložit, Skrýt.

**Pravidla**
- Výchozí řádek: název a krátký důvod (`meta`; důvod může nést tón `danger`). Přístupné **Proč?** rozbalí lidsky čitelný oprávněný zdroj a přesný čas vyhodnocení; funguje dotykem, klávesnicí i čtečkou.
- Nespoléhat na `title`/nápovědu. Interní ID zdrojů, revize, pravidla a technické časové zóny nejsou v Proč? ani v detailu úkolu.
- Zastaralost, nejistota či konflikt jsou viditelné hned textem, ne jen barvou nebo po rozbalení; neznámý čas se nevymýšlí. Akce, jejichž bezpečnost na aktuálnosti závisí, se při zastaralosti vypnou s vysvětlením.
- Otevřít je vždy vidět; Odložit a Skrýt po najetí nebo fokusu (na klávesnici vždy dosažitelné), na mobilu v detailu.
- Nejvýše pět položek. Prázdný stav se řídí klidným textem Home, bez vytváření naléhavosti.
