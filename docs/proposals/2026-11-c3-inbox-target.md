# C-3 — význam Inboxu na cílových datech (návrh k rozhodnutí vlastníka)

**Stav:** návrh, bez implementace a bez změn schématu, dat nebo produkčních příznaků. Navazuje na [milník C](https://github.com/Kocooour/AI-executive/issues/466) a C-1 (#467).

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

## Předběžné doporučení a otázky pro vlastníka

**A** je nejjednodušší a nejsrozumitelnější v první jednouživatelské verzi: Inbox = vědomě ještě nezpracované cílové úkoly, jejich Oblast zůstává povinná a nezávislá. Při návrhu schématu předem vymezit budoucí sdílený režim (globální vs. per-user triage); pokud Inbox znamená **osobní rozhodnutí každého člena**, je vhodnější C.

K rozhodnutí před C-3:

1. Má být Inbox vyprázdněn **výslovným krokem „Zpracovat“** (A), nebo automaticky při naplánování/zařazení (B)?
2. Může být zpracování sdílené položky společné pro všechny, nebo musí být **osobní pro každého uživatele** (C)?
3. Má se nový úkol z Quick Capture objevit v Inboxu vždy, nebo jen když uživatel neprovede žádné další třídicí rozhodnutí při vytvoření?

Bez odpovědí nevytvářet cílový Inbox, neměnit ACL, schéma ani migrovat staré záznamy. C-1 ponechává legacy Inbox výhradně v odděleném archivu pro čtení.
