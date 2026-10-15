# Button

Tlačítka Lumi: jedna primární akce na plochu, ostatní sekundární nebo textové.

**Co dodává volající:** popisek (sloveso: Přidat úkol, Schválit, Otevřít), varianta `primary | secondary | text | danger`, stav `disabled` s vysvětlením vedle.

**Pravidla**
- Primární: `accent` + text `on-accent` (v tmavém tématu tmavý). Sekundární: `surface` + okraj `control-border`. Textové: `accent` bez rámu. Destruktivní: `danger` text a okraj, vždy s potvrzovacím dialogem.
- Výška 36 px, na dotyku 44 px. `radius-md`.
- Fokus: plný 2px obrys `focus-ring`, odsazení 2px.
- Dnešní kód má pět podob sekundárního tlačítka (Otevřít, Obnovit náhled, Jiný čas, Dokončit, Zrušit) – sjednotit na tuto.
