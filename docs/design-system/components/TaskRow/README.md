# TaskRow

Řádek úkolu, projektu nebo poznámky v seznamu – jeden řádek jako v Things.

**Co dodává volající:** název, jeden pravý údaj (datum, odhad nebo počet), stav synchronizace, `onComplete`, `onOpen`.

**Pravidla**
- Bez podtitulu a bez rámečku kolem seznamu; řádky leží přímo na `app-bg`, výběr `selected`, najetí `hover`.
- Pravý údaj: datum (`danger` po termínu), jinak odhad; nic, pokud není co říct. Projekt a oblast se ukazují až v detailu nebo v seskupení seznamu.
- Čekající synchronizace jen ikonou ↻ v `warning` s nápovědou.
- Kroužek má `aria-label` „Dokončit …“ a dotykový cíl 44 px.
