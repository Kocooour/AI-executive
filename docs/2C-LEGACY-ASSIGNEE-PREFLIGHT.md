# 2c, part 1 — read-only legacy owner assignee preflight

**Status:** a bounded, pure, **non-executable** planner for the approved `Můj plán` continuity migration. This is independent of the incomplete 2b partition; it does not migrate, change any task, write to SQLite/Dexie, upgrade sync, enable UI, invite users, or activate shared access.

## Why this matters

The future My Plan read model includes private work plus shared tasks with an explicit `assigneeUserId` equal to the actor. Older shared workspace tasks often have no assignee. Activating My Plan first would hide that existing work.

`planLegacyOwnerAssignees({ source, legacySharedWorkspaceIds })` reviews a caller-supplied snapshot plus an **explicit legacy-workspace designation**. For an active shared workspace whose current `properties.members` is exactly `[{ id: "owner", role: "owner" }]`, it proposes **only open, unassigned** task IDs for future backfill to `owner`. Already-owned open tasks remain unchanged. Completed/non-open, personal and unrelated multiuser tasks are never candidates. Malformed assignees, unexpected assignees, missing/ambiguous membership, duplicate IDs and stale/invalid snapshot counters block the whole preflight.

The output is deterministic, sorted and immutable: candidate task IDs and aggregate counts only, no titles, fields, drafts or proposed mutated entities. The input is not modified.

## Strict safety boundary

The input `legacySharedWorkspaceIds` and mutable `workspace.properties.members` are **not attested historical provenance or authoritative membership**. A browser may supply forged values. A separate 2b-reviewed, authenticated lineage mapping and current membership/ACL check will be necessary before any real write.

Consequently this library permanently emits:

- `phase: "legacy-assignee-preflight-only"`
- `membershipEvidence: "unverified"`, `legacyOriginEvidence: "unverified"`
- `canApply: false`, `canActivateMyPlan: false`, `canEnableSharing: false`

Do not use its result as authority for editing tasks or permission to release recovery holds. Candidate IDs are private. Keep output in volatile local memory, never log, persist, place in a URL, upload or send to AI. There is **no executor** or new API/UI wiring.

## Future implementation gates

1. The audited, backed-up 2a normalization must run successfully and stay invariant.
2. 2b must complete its independently reviewed Area partition, full side-table routing, offline preservation and authorization barriers, with recoverable rollback.
3. Establish trusted server-side single-owner and historical legacy-workspace provenance evidence; do not infer legacy status from `kind=shared` alone or from input supplied by the client.
4. Introduce a transactionally guarded 2c executor using current revision/restoreGeneration and membership-policy checks, preserving task IDs and all fields beyond `assigneeUserId`. Re-audit after any concurrent change; abort on conflicting owner/assignment/membership.
5. Before enabling My Plan, verify **the actual Home / Today / Inbox identities, order and counts** on the resulting state; the test-only projection with `selectScopedWork` is *not* a substitute. Shared Area with two or more members must never have unassigned tasks backfilled by this rule.
6. Complete server-side authorized read scopes, cache invalidation/revocation, and multiuser data isolation before activating the scope switcher or sharing.

## Validation and isolation

`tests/legacy-assignee-preflight.test.mjs` covers sorting, unchanged canonical data, previously assigned and completed tasks, preview of My Plan continuity, unknown/duplicate workspaces, multi-member cases, non-owner assignments, malformed metadata and invalid snapshot revisions.

Branch `codex/2c-legacy-owner-assignee-preflight-20261026` based on main `b73dc177183332ee049ee46bcad20f9cb66c2453`. GitHub-only changes; no worktree, local service, database, credentials or mutable state; no overlapping branches requiring an integration branch. A future synthetic preview can use port 3001 and private state prefix `lumi_codex_2c_preflight`. PR Checks on the **exact HEAD** must pass: deployment script syntax, `pnpm typecheck`, `pnpm test`, and `pnpm build`. Full browser E2E stays exclusively at the predeployment release gate.
