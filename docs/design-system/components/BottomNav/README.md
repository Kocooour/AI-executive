# BottomNav — Lumi Design v1.0 (cílová komponenta)

**Aktuální cílové rozhodnutí 2026-11-04** nahrazuje dřívější krátkodobý návrh kořenového mobilního menu z 3. 11. a historickou pětici Domů / Doručené / Dnes / Kalendář / Více.

- Na iPhonu je **pevná spodní lišta se čtyřmi cíli**: **Můj plán / Kalendář / Projekty / Více**. Při startu je aktivní Můj plán; Hledat je pouze z horní lišty. Ikony zachovat ze stávajícího Lumi podle významu, ne nahrazovat nahodilými emoji.
- **Více** otevírá dostupné sekundární pohledy: Domů / Denní brief, Doručené, Dnes, Nadcházející, Poznámky, Oblasti, uložené filtry, integrace, nastavení a nápovědu. Projekty mají vlastní tab a úplný autorizovaný seznam, nikoli umělý limit nebo skrytí v menu Více.
- Globální filtr **Vše / Osobní / Sdílené** je jiná komponenta než spodní navigace; volba Vše může zahrnovat všechny oprávněné projekty, Můj plán však zůstává osobním seznamem mých závazků.
- Dotykové cíle nejméně 44 × 44 px, aktivní stav čitelný i bez barvy, fokus/VoiceOver, safe-area inset, klávesnice a reduced motion. Při otevřeném Více zůstává jen jeden aktuální navigační stav; po návratu se obnoví kontext a fokus jen při platných oprávněních.
- **Stav:** cílový design, nikoli tvrzení o již nasazené komponentě. Věrnost [UX/UI](../../../UX-UI.md) a [design systému](../../README.md); [preview.html](preview.html) ilustruje nový cíl.
