# Button

Tlačítka Lumi: jedna primární akce na plochu, ostatní sekundární nebo textové. **Lumi Design v1.0 používá pro primární akci a fokus fialovou `#8B5CF6` s kontrastní textovou variantou**; starý modrý runtime token `accent` je pouze existující implementace, kterou nahradí samostatné UI PR. Význam `Vše / Osobní / Sdílené` není barvou primárního tlačítka a pozornost zůstává pouze barevnou konturou stavové ikony. Návrhy Lumi mají výrazný fialový štítek a explicitní schválení.

**Co dodává volající:** popisek (sloveso: Přidat úkol, Schválit, Otevřít), varianta `primary | secondary | text | danger`, stav `disabled` s vysvětlením vedle.

**Pravidla**
- Cílově primární: fialový akcent a čitelný text (kontrast nejméně 4,5:1, ověřit v obou tématech); ve starém runtime se prozatím používá `accent` + `on-accent`. Sekundární: `surface` + okraj `control-border`. Textové: `accent` bez rámu. Destruktivní: `danger` text a okraj, vždy s potvrzovacím dialogem.
- Výška 36 px, na dotyku 44 px. `radius-md`.
- Fokus: plný 2px obrys `focus-ring`, odsazení 2px.
- Dnešní kód má pět podob sekundárního tlačítka (Otevřít, Obnovit náhled, Jiný čas, Dokončit, Zrušit) – sjednotit na tuto.
