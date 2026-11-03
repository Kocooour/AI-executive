# R2d — task/note parent backlinks (default-off staging)

Follows merged PR #205 (authorized project → child structural relations).
The target schema stores exactly one **canonical parent** for a task or note:
a direct project ID or an independent Area. This vertical implements the reverse
lookup for *authorized* task and note readers, with no new schema/migration.

`GET /api/target-staging/relations/backlinks?kind=task&id=...`
or `?kind=note&id=...`.

- Only when `AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED=true`,
  `AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_ENABLED=true` and
  `AI_EXECUTIVE_TARGET_STAGING_HTTP_RELATIONS_ENABLED=true`. The new
  relation gate defaults OFF, as does staging in production.
- Identity comes from a valid owner cookie or durable authenticated session.
  No requested actor, Area, workspace, restore generation or permissions.
- A single pinned/preflighted SQLite snapshot determines whether the current
  actor can read the exact entity and its **inherited effective Area**. Private
  owner or shared viewer/editor/admin may read. Unknown and inaccessible IDs
  both return content-free 404.
- Response is only `{relations:[{predicate:"belongs_to_project",
  sourceKind,sourceId,projectId}]}`; an authorized standalone item returns
  `{relations:[]}`. Note title/body, task title, policy, Area IDs, revision,
  member list and counts are never serialized to HTTP.
- The internal guard includes exact source, direct/project Area, entity and
  parent revision. After the child returns, the HTTP process revalidates
  **actor/session, Area policy and exact source/parent live state in the same
  transaction**, including for standalone items and empty results. A move,
  parent revision update, revoke, restore or changed identity fails closed.
- No generic semantic relations, arbitrary cross-Area backlinks, claim review,
  search/AI context, UI activation, persistent client hook, migration or
  production deployment are included.

`tests/target-staging-parent-backlinks-http.test.mjs` uses only synthetic
multi-user staging SQLite, real signed test sessions and isolated child
processes. It covers positive owner/editor/viewer and standalone, private
isolation, nonmember/absent results, query forgery, flags, session revoke,
late reparenting/revocation and strict child DTO refusal. Run this under the
focused R2d project read CI together with exact-head `PR Checks`. Broad
Browser E2E remains a pre-production deployment gate, not a per-PR gate.
