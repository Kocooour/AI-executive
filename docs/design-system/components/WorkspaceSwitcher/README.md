# WorkScopeSwitcher — cílový globální filtr (historické jméno adresáře WorkspaceSwitcher)

**Schválený Lumi Design v1.0:** globální přepínač celé aplikace má **Vše / Osobní / Sdílené**, nikoli staré pracovní/rodinné „workspaces“ a „Všechna práce“ jen pro čtení. Skutečné datové prostory jsou jen **Osobní** a **Sdílený**; Oblasti tvoří striktní serverové hranice viditelnosti.

- **Vše** (fialová `#8B5CF6`) = všechny serverově autorizované osobní i sdílené záznamy, také nepřidělená práce a autorizované cizí úkoly. **Osobní** (zelená `#16A34A`) = vlastní soukromé položky. **Sdílené** (modrá `#2563EB`) = všechny oprávněné sdílené položky.
- **Můj plán** je samostatná mobilní úvodní obrazovka, **není hodnotou filtru**; ukazuje mou soukromou a mně přidělenou sdílenou práci. Změna filtru v Projektech platí globálně, ale na Mém plánu se stále vybírá jen osobní práce, případně zúžená na Osobní/Sdílené.
- Jde o **čtecí rozsah**, nikdy o cílovou Oblast zápisu, zvýšení role nebo sdílení. Capture a návrh Lumi musejí ukázat jednu přesnou cílovou Oblast, typ soukromá/sdílená a relevantní členy; sdílení potřebuje explicitní souhlas.
- Tématické Oblasti (např. práce/rodina) se zobrazují pouze jemným podbarvením seskupení tam, kde to UX stanoví, ne jako další globální prostory. Bez zběsilých dlaždic s písmeny, počtů Doručených, nadbytečných horních proužků či falešných privilegovaných stavů.
- Dřívější neaktivní přepínač `lib/work-scope-navigation.ts` používá interní `my-plan|personal|shared` a **není možné jej aktivovat bez R3 adaptéru**. Nové Vše vyžaduje bezpečnou [serverovou agregaci](../../../ARCHITECTURE.md#autoritativní-read-model-vše-a-integrační-brána-r3-lumi-design-v10-2026-11-04).
- A11y: popisky hodnot, stav vybráno, plná klávesnice/VoiceOver a 44px cíle. [Preview](preview.html) je referenční, nikoli živé UI.
