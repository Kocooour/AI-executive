# NavItem — Lumi Design v1.0

Položka desktopového sidebaru či přímého navigačního cíle. Zachovat existující významové ikony Lumi a dobrý kontrast/fokus.

- **Desktop:** přímo rolovatelný sidebar s hlavními a sekundárními cíli, všemi oprávněnými projekty v aktivním globálním **Vše / Osobní / Sdílené**, bez pevného limitu, bez brány „More views“. Globální Search a Lumi Chat jsou v hlavičce; Quick Capture je plovoucí tlačítko se zkratkou ([rozhodnutí 2026-11-05](../../../decisions/2026-11-05-ui-revize-a-vertikalni-rez.md)). Projekty mají samostatnou stránku.
- **Mobil:** neklonovat desktop jako rolovatelné *kořenové* menu. Cíle **Můj plán / Kalendář / Projekty / Více** jsou ve spodní liště; sekundární cesty jsou pod Více, Search nahoře. Při návratu bezpečně obnovovat fokus/scroll/draft.
- Uživatelské názvy Oblastí a práva nelze bezpečně nahradit barvou rozsahu. Scope barvy = Vše fialová, Osobní zelená, Sdílené modrá; ikony dokončení úkolů/projektů mají oddělenou stavovou sémantiku.
- Aktivní položka má srozumitelný název a stav `aria-current`, zřetelný fokus, min. 44 px dotykový cíl. Projektové názvy stejné písmo jako úkolové; v projektovém přehledu neukazovat počty/progres.
- [Statický náhled](preview.html) odpovídá cílovému desktop sidebaru, ne aktuálnímu legacy rozložení ani serverovým právům.
