# TaskRow

Řádek úkolu, projektu nebo poznámky v seznamu – jeden řádek jako v Things.

**Co dodává volající:** název, jeden pravý údaj (datum, odhad nebo počet), stav synchronizace, `onComplete`, `onOpen`.

**Pravidla**
- Bez podtitulu a bez rámečku kolem seznamu; řádky leží přímo na `app-bg`, výběr `selected`, najetí `hover`.
- Pravý údaj: datum (`danger` po termínu), jinak odhad; nic, pokud není co říct. Projekt a oblast se ukazují až v detailu nebo v seskupení seznamu.
- Čekající synchronizace nahrazuje pravý údaj textem „↻ čeká na odeslání“ v `warning` – viditelně, ne jen v nápovědě (`title` není dostupný na dotyku ani z klávesnice).
- Kroužek má okraj `control-border` (≥3:1 i na vybraném řádku), `aria-label` „Dokončit …“ a dotykový cíl 44 px.
