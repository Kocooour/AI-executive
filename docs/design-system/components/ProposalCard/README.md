# ProposalCard

Jediná podoba návrhu změny od Lumi – v chatu, na Home, v plánu dne, v Inboxu i na mobilu (LUMI-UX-003, 011). **Lumi Design v1.0:** fialový/fialovorůžový návrh má **čtyřcípou jiskru ✦, explicitní štítek „Návrh Lumi“ a akci „Posoudit“**; nikdy se nejeví jako dokončený úkol, potvrzená rezervace ani jako per-user priorita.

**Kdy:** kdykoli Lumi (chat, agent, plán dne, extrakce) navrhuje změnu kanonických dat; spouštěč návrhu je viditelný. Přímá nízkoriziková ruční změna Kdy se ukládá hned s bezpečným Undo. Změny přístupu, nevratné/externí účinky a posun za termín vyžadují příslušné potvrzení. Nikdy nezobrazovat návrh jako hotovou akci.

**Co dodává volající:** souhrn (`h3`), lidsky čitelnou cílovou Oblast, soukromý/sdílený rozsah a relevantní členy, platnost, zdroj a čas vytvoření (jen pro audit, ne do hlavičky), řádky změn `{pole, teď, po}`, dopady (kalendář, externí systémy), nevratné účinky, stav `pending | expired | conflict | done`, akce `onApprove`, `onReject`, volitelně `onUndo` a odkaz na audit.

**Pravidla**
- Čekající návrh: jasně odlišná fialová plocha / okraj `proposal` a jiskra ✦, štítek **Návrh Lumi** + **Posoudit** (v detailu před/po, dopady, cílová Oblast a Schválit/Odmítnout). Provedený: plný okraj `line`, štítek **Provedeno** (text `on-success-soft` na `success-soft`); štítek Návrh Lumi má text `on-accent-soft` na `accent-soft`.
- Hodnoty „po schválení“ tučně `text`; nezměněná pole ukázat jen pokud jsou pro rozhodnutí důležitá (např. termín zůstává).
- Expirovaný/konfliktní stav: *Schválit* vypnuté, důvod v bloku `warning-soft`, nabídnout *Posoudit znovu*.
- *Zpět* jen tam, kde je bezpečné; jinak jen odkaz na audit.
- Na iPhonu ve spodním sheetu; dopady lze sbalit, ale lidsky čitelná cílová Oblast, soukromý/sdílený rozsah, relevantní členové, před/po a tlačítka zůstávají vidět.
- Hlavička je krátká: štítek, cílová Oblast s jasným soukromým/sdíleným označením, oprávnění členové a u čekajícího návrhu platnost. Žádná další metadata (zdroj, čas) – ta jsou v auditu. Dopady jednou větou.

Server dál ověřuje podkladový bezpečnostní prostor, revize, oprávnění, expiraci, idempotenci a audit; technické identifikátory se na kartě nezobrazují.
