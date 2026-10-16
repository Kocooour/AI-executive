# ProposalCard

Jediná podoba návrhu změny od Lumi – v chatu, na Home, v plánu dne, v Inboxu i na mobilu (LUMI-UX-003, 011).

**Kdy:** kdykoli Lumi (chat, agent, plán dne, extrakce) navrhuje změnu kanonických dat. Nikdy nezobrazovat návrh jako hotovou akci.

**Co dodává volající:** souhrn (`h3`), cílový prostor, platnost, zdroj a čas vytvoření (jen pro audit, ne do hlavičky), řádky změn `{pole, teď, po}`, dopady (kalendář, externí systémy), nevratné účinky, stav `pending | expired | conflict | done`, akce `onApprove`, `onReject`, volitelně `onUndo` a odkaz na audit.

**Pravidla**
- Čekající návrh: přerušovaný okraj `proposal`, štítek **Návrh**. Provedený: plný okraj `line`, štítek **Provedeno** (text `on-success-soft` na `success-soft`); štítek Návrh má text `on-accent-soft` na `accent-soft`.
- Hodnoty „po schválení“ tučně `text`; nezměněná pole ukázat jen pokud jsou pro rozhodnutí důležitá (např. termín zůstává).
- Expirovaný/konfliktní stav: *Schválit* vypnuté, důvod v bloku `warning-soft`, nabídnout *Posoudit znovu*.
- *Zpět* jen tam, kde je bezpečné; jinak jen odkaz na audit.
- Na iPhonu ve spodním sheetu; dopady lze sbalit, ale workspace, před/po a tlačítka zůstávají vidět.
- Hlavička je krátká: štítek, dlaždice cílového prostoru (`ws-*`), název prostoru a u čekajícího návrhu platnost. Žádná další metadata (zdroj, čas) – ta jsou v auditu. Dopady jednou větou.
