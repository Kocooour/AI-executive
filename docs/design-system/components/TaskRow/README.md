# TaskRow

Řádek úkolu nebo poznámky v seznamu. Projektový řádek uvádí název, průběh a nejvýše jeden další krok nebo aktuální problém.

**Co dodává volající:** název, kompaktní relevantní datum/termín či odhad, případnou rezervaci času u úkolu, stav synchronizace, `onComplete`, `onOpen`.

**Pravidla**
- Bez rámečku kolem seznamu; běžné řádky rostou podle skutečného obsahu, nikdy podle délky odhadu. Dotykový cíl má alespoň 44 px. Rezervace času či návrh bloku je kompaktní údaj u jediného úkolu, ne druhá akční položka.
- Pravý údaj je střídmý; datum/termín (`danger` po termínu) a důležité upozornění se neskrývají kvůli rezervaci času. Odhad je volitelný a neřídí výšku. Projekt a oblast se ukazují v detailu nebo v seskupení seznamu.
- Čekající synchronizace nahrazuje pravý údaj textem „↻ čeká na odeslání“ v `warning` – viditelně, ne jen v nápovědě (`title` není dostupný na dotyku ani z klávesnice).
- Kroužek má okraj `control-border` (≥3:1 i na vybraném řádku), `aria-label` „Dokončit …“ a dotykový cíl 44 px.
