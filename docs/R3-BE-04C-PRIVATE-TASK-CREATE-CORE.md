# R3-BE-4c.1 — základ transakčního vytvoření soukromého úkolu

**Cíl:** první backendový stavební krok pro Quick Capture úkolů, který už nepoužívá legacy store. Tato iterace je **pouze interní staging writer**, nemá HTTP endpoint, UI ani produkční zapnutí. Funkce na vznik projektu a sdílených úkolů zůstávají samostatnými úkoly.

## Kontrakt

Interní `TargetStagingSessionAuthority.createPrivateTask(sessionToken,command,durableSessionTokenHash?)` přijme přesně pět polí:

```json
{
  "taskId": "6cb777df-44dd-442b-8847-e1a4f25c281d",
  "commandId": "59d9d832-bdb8-4ab0-8e3f-83a4cd377974",
  "areaId": "PRIVATE_AREA_ID",
  "restoreGeneration": "CURRENT_RESTORE_GENERATION",
  "title": "Zavolat"
}
```

`taskId` a `commandId` jsou klientem předem vygenerované UUID, které se při nejistém výsledku **nemění**. `title` je neprázdné, bez úvodních/koncových mezer a řídicích znaků, nejvýše 4096 UTF-8 bajtů. `areaId` je explicitní organizace záznamu, **nikdy autorizační důkaz**. `actor`, `scope`, `workspaceId`, `projectId` a `assigneeUserId` jsou zakázaná pole.

Writer přijme pouze krátce platný serverem podepsaný **write audience** credential. V `withPinnedTargetStagingWrite` pod `BEGIN IMMEDIATE` znovu ověří identitu, případnou durable session (i bezprostředně před commitem), restore generation, vlastní soukromou Oblast a její oprávnění. Cizí, sdílená nebo neexistující Oblast jsou nerozlišitelné. Před `INSERT` se odmítá již existující ID i ID v trvalé tabulce tombstonů; úkol vzniká jen se `status=open`, `revision=0`, `project_id=NULL`, bez assignee a termínu. SQLite triggery aktualizují `areas.content_revision` a `change_log`.

Příkaz ukládá content-free receipt pod namespace `r3:private-task-create-receipt-v1:` se SHA-256 digestem přesného příkazu a aktérovým/ID-vázaným klíčem. Pod stejným commit boundary jako task a change-log zapisuje `task_create` do chráněného anchor journalu. **Úspěšné opakování** kontroluje znovu *aktuální* právo a existenci tasku v původní privátní Oblasti, poté vrací `{ok:true,replayed:true}` bez duplicit. Konfliktní payload se stejným UUID vrací idempotency conflict; smazaný/přesunutý task, změna generace, revokovaná session nebo cizí oblast se nesmí znovu potvrdit. Obsah titulku se nesmí objevit v journálu, receipt ani change-feed.

Pro zatím izolovaný staging writer jsou receipt/change-feed řádky omezené stávajícími kapacitními limity a produkční retence/archivace **není schválená**. Nekonzistentní commit/confirm musí selhat jako nejednoznačný výsledek, nikoli zakládat nový command ID.

## Validace

```bash
node --experimental-loader ./tests/ts-loader.mjs --test tests/target-private-task-create-writer.test.mjs
```

Test používá skutečnou izolovanou SQLite, podepsané writable/read-only tokeny, dvě identity, cizí/sdílenou Oblast, durable session revokaci, skutečné smazání s tombstonem, idempotentní replay, konflikt, přísný tvar požadavku, JSON a journal audit a legacy sentinel bez změn. Plné PR Checks zahrnují Typecheck a produkční build; browserové E2E až před produkčním nasazením.

## Nesplněné kroky před používáním

- Chybí **default-off HTTP `POST /api/target-staging/tasks`** a samostatný child proces s bezpečným předáním obsahu přes stdin, současnou session/Area kontrolou a přesným DTO zpět.
- Chybí read-only recovery/status pro ztracenou HTTP odpověď, klientské pending/uncertain/cancel/Undo a FE Quick Capture pro úkol.
- Create do sdíleného projektu/Oblasti vyžaduje samostatnou autorizaci a výslovné rozhodnutí o zveřejnění.
- Stagingový pinned-fd model není produkční VFS a nepovoluje R4 cutover. Reálná data, import HumanWiki ani produkční migrace se tímto PR nezapínají.
