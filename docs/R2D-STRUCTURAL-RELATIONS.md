# R2d — project structural relations, authorized end-to-end (default-off)

This staging-only iteration follows #203. It exposes a **functional vertical
read** of canonical relations already stored in the isolated target model:
`contains_task` and `contains_note`, with source project and opaque target
identifier. Unlike reviewable Context Graph claims, **these are structural
parentage edges derived from the canonical FK**. They do NOT grant access across
Areas, connect independent projects, or represent proposed/approved semantic
links. No generic typed-relations table exists in the current staging schema.

## Endpoint and trust boundary

`GET /api/target-staging/projects/:projectId/relations?limit=50&cursor=...`

- Disabled unless existing staging HTTP and notes flags **and**
  `AI_EXECUTIVE_TARGET_STAGING_HTTP_RELATIONS_ENABLED=true`. Default is OFF.
- Authenticated owner-cookie or live durable-session actor is derived server-side;
  no actor, Area, workspace, restore generation, or foreign target selector is
  accepted. An inaccessible and an absent project produce the same content-free
  404. Viewer/editor/admin may read a shared project; only the private owner
  may read a private project.
- In a **single pinned preflighted SQLite snapshot**, the selector resolves
  project ACL and selects canonical child-task and child-note links. Task and
  note rows must inherit parent Area (no independent Area). No task/note
  title/body, unrelated project, membership, count, claimant or tombstone
  is in the response.
- An isolated child process returns a strictly bounded DTO. The HTTP process
  performs a **single live** actor/session/Area/project/returned-task and note
  journal release check. Changed authorization, note data/generation, project
  identity or returned task parentage fails closed.
- Pages contain up to 50 edges, sorted by predicate then opaque target ID,
  with a signed authenticated-actor/project/endpoint-bound continuation token.
  The token is not a credential; revision changes force a new bootstrap.
  Signed cursor reuse across actors, projects and endpoints fails closed.
- Output: `{relations:[{predicate,projectId,targetId}],hasMore,nextCursor}`.
  `Cache-Control: no-store`. No UI integration or production enablement.

## Validation and follow-ups

- `tests/target-staging-project-relations-http.test.mjs` exercises genuine
  synthetic SQLite staging, all roles, missing/private foreign projects,
  default-off, anti-forgery, paging and stale cursor, note-edit live witness
  and strict child DTO. Full `PR Checks` on exact commit are required.
- General user-authored typed links/backlinks and independently reviewed
  person/organization/claim relations are **not implemented here**. Their
  target schema and read/write ACLs need separate review before search,
  AI or aggregate consumers use them.
- Not enabled in production; no schema migration, data wipe, UI hooks,
  offline cache, or server deployment. Full Browser E2E runs only as
  pre-production release gate on exact deploy SHA, not per PR.
