# D2b part 7 — effective Area scope-graph drift audit (read-only)

**Status: diagnostic library and focused tests only.** This does not enable multi-user sharing, workspace partition, recovery replay/import, conflict preferences, unfreeze, hold release, writes or deletion. It does **not** replace the defer-only policy for every v1 candidate in D2b/6.

## Why this exists

The v1 offline rescue file contains changed entities/relations, **not** a complete old relation graph. A task or note can inherit Area A through an unchanged project membership edge, while its parent project moves to Area B only on the server. Both the task and its direct project link would be absent from the v1 file. Comparing just changed records cannot establish a safe target scope.

The new auditOfflineRecoveryScopes({ before, current }) takes **two caller-supplied, allegedly full graphs**, non-negative revision and restore-generation metadata, checks graph invariants, resolves effective Area for projects, tasks and notes, then compares routing **across all records**, including unchanged children. Target generation must be newer. Deleted/added records remain explicit unresolved counts. Project task/note Area is inherited, never guessed from an absent direct Area edge. Cross-Area non-membership relations are counted.

It rejects:
- missing, duplicate or cross-kind-colliding IDs, over-limit graphs (20,000 entities or 50,000 relations per graph);
- unknown workspace, incorrect Area kind or cross-workspace/dangling relation endpoints;
- multiple parents or Area links, conflicting legacy areaId/projectId references;
- direct Area links on project members, inactive Area for active content, or an unassigned project/standalone task/note;
- non-membership relations whose endpoints cannot both resolve to an Area (including workspace-level endpoints); these never silently disappear from diagnostic counts;
- reuse of one canonical ID for a different entity type, or between an entity and a relation, across the two generations, even if its effective Area is unchanged;
- invalid revisions/generations or a target generation that is not newer.

The result contains **aggregate counts only** (sameScope, movedArea, movedWorkspace, absentOnOneSide, cross-Area links), no record IDs, titles, drafts, contents, tokens or raw scope maps. The result and summary are frozen; inputs remain unchanged.

## What the result does *not* establish

A pure function **cannot prove that a claimed full graph is complete, authentic, fresh, owned by the actor, or authorized**. An attacker can supply a self-consistent but incomplete graph. A correct SHA or server revision is not an authenticated baseline/ACL proof. Even sameScope for every record says nothing about owner consent, membership revocation, history, tombstones, pending sync, attachment and side-table routing or the recovery hold.

Every result therefore has immutable state:
- completeness, identity, membership, areaPermission: unverified;
- consent: not-requested;
- canApply: false; canReleaseHold: false; automaticReplayAllowed: false.

The audit is **not connected to UI, sync or the D2b/6 preference API**. Never use diagnostic counts, browser snapshot, user assertion, or local file SHA to make an access decision. Do not log or transmit input graphs. The existing recovery file and persistent hold remain untouched.

## Still required before release-capable recovery

1. Authoritative server-issued actor/Area membership and ACL evidence with revocation, bounded freshness, policy revision and target-scope validation. No client-asserted authenticated flags.
2. Complete versioned baseline and target graph **attestation**, covering inherited relationships, server-only moves, tombstones/side tables, attachments and sensitive history, bound to actor and generation.
3. Per-item compare-and-swap on current revision and policy, explicit owner review of collision/deletion/draft handling, independently confirmed consent and crash-safe transaction/rollback with cross-tab fence.
4. Security review and focused negative/multi-tab tests before recovery-capable UI; full browser E2E **only** as the exact-main-SHA gate before deployment.

## Validation and isolation

tests/d2b-recovery-scope-audit.test.mjs covers unchanged graphs, server-only parent Area moves with inherited task/note scope, workspace moves, missing records, ambiguous/dangling/cross-workspace relations, workspace-to-work non-membership edges, cross-generation project/task/note type changes and entity/relation ID recycling, inconsistent legacy references, archived Areas, bounds and fake client ACL assertions.

Branch: codex/d2b-scope-graph-audit-20261026 from main 0e7a46126fa443c39b15662381beb242a5130865. Pure diagnostic change: no local server instance, database, caches, storage or credentials; no integration branch. If later needed, synthetic preview on port 3001 with prefix lumi_codex_d2b_scope. Standard PR Checks on exact HEAD must pass (pnpm typecheck, pnpm test, pnpm build, deployment script syntax). No full browser E2E during PR review.
