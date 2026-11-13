# R3 milestone A (2/3) — owner-private project and project task create

This is the **backend half** of milestone A package 2. It is isolated target-staging only, synthetic acceptance, **default off** and has no UI. It builds on #390/#393 and #401, which have been integrated into `main`.

## Commands

All requests are POST to the real Next handlers under `/api/target-staging`, with authenticated owner cookie or live durable staging session, strict same-origin request, `x-lumi-target-protocol: 1`, no query, no client-supplied actor and the existing write gate.

| Resource | Create | Exact status (read-only) | Reload recovery (read-only) |
| --- | --- | --- | --- |
| Private project | `/projects` | `/projects/create-status` | `/projects/create-recovery` |
| Task inside private project | `/project-tasks` | `/project-tasks/create-status` | `/project-tasks/create-recovery` |

Project create JSON **exactly**: `{ "projectId": "<uuid>", "commandId": "<uuid>", "areaId": "<private-area-id>", "restoreGeneration": "<uuid>", "title": "<text>" }`.

Project-child task create JSON **exactly**: `{ "taskId": "<uuid>", "commandId": "<uuid>", "projectId": "<existing-project-id>", "restoreGeneration": "<uuid>", "title": "<text>" }`. The **new task ID** must be a lowercase canonical UUID, but the **existing parent project ID** can be a non-UUID text ID (the `isReadableStagingProjectId` contract: at most 512 UTF-8 bytes, no control characters and neither `.` nor `..`). Parent IDs are case-sensitive and must match an existing project exactly; the FE must not enforce UUID-only IDs for existing parents. The task cannot carry `areaId`; the SQL row has `area_id = NULL` and inherits its effective Area from the project. The parent's current private ownership and Area are checked inside the write transaction. A missing, shared or foreign project/Area is the same unavailable denial.

Create succeeds with `201 {ok:true,id}`; an identical replay returns `200 {ok:true,id,replayed:true}`. Status takes the full original command. Recovery takes exactly `{ "commandId":"<uuid>" }` and rechecks live task/project + current ACL before returning `{status:"committed",id}` or `{status:"not_recorded"}`. A missing receipt does **not** prove the original request cannot still commit; do not issue a new command/ID on uncertainty without first handling the original in-flight request.

Errors: malformed `400`, unauthenticated/revoked session `401`, unknown/foreign/shared `404`, reused command with different content `409`, stale generation `409 resync_required` on write, unavailable store `503`. No title, credential or actor is included in receipt, journal or status response.

## Safety

- Pinned isolated SQLite and `BEGIN IMMEDIATE`: verify signed write audience, actor, live durable session, restore generation and private owner ACL under the same lock.
- **New** project IDs and **new** child task IDs are canonical lowercase UUIDs, never reused after tombstoning (including case aliases); existing parent project IDs may be non-UUID readable text as above. Existing project status and task creation never overwrite existing rows.
- Atomic actor+command SHA-256 receipt and ID-only generation witness; replay does not append a second change or journal entry. The internal witness has a shared 2048-byte UTF-8 cap validated **before commit** and on preflight/recovery, covering JSON-escaped 512-byte existing project IDs without poisoning later staging reads/writes.
- Change-log triggers and content-free anchored journal kinds `project_create` and `project_task_create`; no migration of the live/legacy store.
- Read-only status/recovery worker uses canonical pinned preflight. Project child release checks current task/Area/parent revisions using the existing live-read fence; project detail verifies owner-private visibility and rechecks identity before release.
- Write requests bypass the client read queue. Both `create-status` and `create-recovery` have route suffixes classified as reads by `isTargetReadRequest`.

**Flags** (all default false by absence; both require the existing general HTTP and WRITE flags):
`AI_EXECUTIVE_TARGET_STAGING_HTTP_PROJECTS_CREATE_ENABLED`;
`AI_EXECUTIVE_TARGET_STAGING_HTTP_PROJECT_TASKS_CREATE_ENABLED`.
They are classified in `lib/target-personal-profile.ts` as deliberately excluded from the current user-facing `personal-v1` activation until the FE half of the package is delivered.

## Acceptance

`node --experimental-loader ./tests/ts-loader.mjs --test tests/target-staging-private-structure-create-http.test.mjs` tests real route handlers, child processes and real isolated SQLite, including creation, identical replay, command collision, hidden foreign/shared/missing Area or project, no task Area override, tombstoned IDs, maximum 512-byte parent IDs needing JSON escaping (followed by valid preflight, replay, status and recovery), bad generation, session revocation, flags off and read queue routing. Test data are synthetic and kept outside the legacy data directory.

Outside scope: UI/FE, shared Areas, move between projects, production deployment, full release E2E.
