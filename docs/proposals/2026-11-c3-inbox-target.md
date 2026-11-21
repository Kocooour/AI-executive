# C-3 — význam Inboxu na cílových datech (historický návrh, rozhodnuto)

**Stav: historický návrh, rozhodnutí vlastníka přijato 2026-11-19.** Aktuální závazná implementační a akceptační specifikace je [issue #471](https://github.com/Kocooour/AI-executive/issues/471), rozdělená na **C-3a (Inbox, Zpracovat/Undo, migrace a LegacyInbox)** a **C-3b (návrhy Lumi a Přijmout)**. Tento dokument zachovává původní varianty jen jako archiv rozhodování; není samostatnou konkurenční specifikací ani tvrzením o nasazení.

**Schválené odpovědi:** (1) **Varianta A** — pouze explicitní **Zpracovat** (ne samotná změna When/Oblasti) ukončuje triage. (2) Triage stav patří **úkolu/položce**, nikoli jednotlivému členovi; budoucí sdílení R5 oznámí zpracování ostatním (bez push v C-3). (3) **Každý nový Quick Capture úkol** má stav `unprocessed`, i když už má Oblast či termín. Dokončení úkolu je nezávislý stav. Staré úkoly se bez automatického importu legacy nemigrují; cílové starší úkoly migrují na `processed` bez falešného aktérského zpracování.

**Podmínka pro sloučení a nasazení:** C-3a nesmí být sloučeno do `main` před doloženým produkčním nasazením C-1 + C-2 (samotný merge #470/#474 nestačí). Finální cutover milníku C vyžaduje také C-3b a release gates dle #471.

## Závazné invarianty

- Podle `docs/PRODUCT.md` je **Inbox stav třídění, nikoli Oblast**. Každý samostatný úkol má jednu skutečnou Oblast, bezpečná výchozí hodnota je **soukromé Nezařazeno**. Inbox nesmí nahrazovat Area ID ani určit viditelnost.
- Přidělení, plánovaný den (`When`), stav dokončení a viditelnost jsou nezávislé dimenze. Soukromá položka se nesmí automaticky stát sdílenou.
- V `personal-v1` je jediný vlastník a soukromé Oblasti; rozšíření o sdílení musí mít explicitní autorizační kontrakt. C-3 nesmí zpřístupnit starý Inbox jako zdroj cílového seznamu.
- Třídění se provádí nad cílovými, serverově autorizovanými záznamy; `Vše/Osobní/Sdílené` filtruje pouze to, na co má aktér oprávnění. **Můj plán** si zachovává vlastní pravidla přidělení.

## Varianty

| Varianta | Význam a chování | Dopad na schéma / migraci | Dopad na ACL a bezpečnost |
|---|---|---|---|
| **A — explicitní stav triage (doporučení)** | Nový soukromý úkol se výchozím `triageStatus=unprocessed` objeví v Inboxu bez ohledu na Oblast a `When`. Akce **Zpracovat** jej vyřadí; samotná změna Oblasti ani termínu ho neskrývá. | Nový per-task stav `unprocessed/processed` (případně `processedAt`) s defaultem pro nové záznamy. Existujícím cílovým úkolům je třeba při rollout určit explicitní bezpečné defaulty; **bez automatického importu legacy**. Vyžaduje index/cursor pro čtení Inboxu. | Inbox read model i změny stavu ověřují owner/Area ACL před vrácením názvu či zápisem; u sdílených úkolů je nutno určit, zda stav triage patří položce, nebo aktérovi. CAS a revokace jako u ostatních target writers. |
| **B — odvozený „potřebuje roztřídit“** | Inbox ukazuje otevřené úkoly bez záměrného plánovacího rozhodnutí, např. bez `When` / projektu / explicitního triage potvrzení. Rozhodnutí zpracováno = zvolena některá akce. | Bez nového pole pouze při čisté deterministické definici z existujících hodnot; složitější pravidla a výjimky by již vyžadovaly vlastní triage marker, takže úspora schématu může být jen zdánlivá. | ACL standardních task indexů, ale při filtrování nesmí dojít k úniku názvů nebo countů. Riziko, že změna data způsobí tiché zmizení nebo opětovné objevení v Inboxu; totéž v průběhu sdílení. |
| **C — osobní seznam ke zpracování** | Inbox je stav **každého uživatele nad jemu viditelným úkolem**. Dva členové sdíleného projektu mohou mít tentýž úkol v odlišném stavu roztřídění. | Samostatná per-actor tabulka `task_triage(actorId, taskId, status, revision)`, s indexem pro vlastní Inbox; nové transakce, tombstone a revokační cleanup. Pro jediného vlastníka více infrastruktury než A. | Striktní dvojí autorizace (aktér k triage záznamu + oprávněný aktuální přístup k úkolu). Revokace musí okamžitě odebrat list i počty a zabránit obnovení při offline sync. |

## Historické doporučení a dřívější otázky (zodpovězeno 2026-11-19)

**A** je nejjednodušší a nejsrozumitelnější v první jednouživatelské verzi: Inbox = vědomě ještě nezpracované cílové úkoly, jejich Oblast zůstává povinná a nezávislá. Při návrhu schématu předem vymezit budoucí sdílený režim (globální vs. per-user triage); pokud Inbox znamená **osobní rozhodnutí každého člena**, je vhodnější C.

K rozhodnutí před C-3:

1. Má být Inbox vyprázdněn **výslovným krokem „Zpracovat“** (A), nebo automaticky při naplánování/zařazení (B)?
2. Může být zpracování sdílené položky společné pro všechny, nebo musí být **osobní pro každého uživatele** (C)?
3. Má se nový úkol z Quick Capture objevit v Inboxu vždy, nebo jen když uživatel neprovede žádné další třídicí rozhodnutí při vytvoření?

~~Bez odpovědí nevytvářet cílový Inbox.~~ **Tato historická podmínka již neplatí:** odpovědi jsou schválené výše a implementace se řídí #471. Stará data zůstávají oddělená; žádný automatický import legacy ani tichý produkční cutover není povolen.
