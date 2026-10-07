# Lumi architecture

This document is an implementation map. [README.md](README.md) remains the canonical product, security, and operations specification; consult it for normative requirements and current delivery status.

## System at a glance

```text
Next.js UI and route handlers
            ↓
Application services and policy
            ↓
Canonical SQLite state + history
      ↙             ↓              ↘
Dexie cache     Planner/context     Integration adapters
and offline     resolver/tools       (calendar, AI, delivery)
queue
```

Lumi is a local-first personal AI OS built with Next.js, TypeScript, Dexie, and SQLite. The browser can keep a local cache and visibly pending offline work, but canonical acceptance, authorization, revisions, audit, and conflict handling happen in the application service backed by SQLite.

## Layers and ownership

| Layer | Responsibility |
| --- | --- |
| `app/` | UI, route entry points, and presentation. Client-side filtering is never the authorization boundary. |
| `lib/` | Domain behavior, persistence, workspace authorization, synchronization, proposals, approval, audit, Undo, planning, context resolution, tool registry, and integration adapters. |
| SQLite and local data | Canonical structured state, revisions, tombstones, and audit/history. Keep it outside static assets and out of version control. |
| Dexie and PWA shell | Local cache, offline experience, and visible pending/conflict state; not a second source of truth. |
| `ops/` and `deployment/` | Operational configuration and least-privilege service setup, not application business logic. |
| `tests/` | Regression and contract coverage for behavior that must remain deterministic. |

## Core flows

### Canonical mutation

```text
UI or chat
  → authenticated, explicit-workspace request
  → canonical service and policy validation
  → reviewable proposal
  → explicit owner approval
  → revision-checked mutation
  → history / audit / guarded Undo
```

Chat uses the same services and proposal boundary as the UI. It is neither a second data store nor an authorization bypass.

### AI and integrations

```text
Provider or trigger
  → minimum authorized Context Resolver bundle
  → allowlisted Tool Registry reads
  → deterministic or model analysis
  → validated proposal
  → owner approval before any write or external side effect
```

Models never control permissions or write directly to the database or providers. Provider-specific formats, credentials, and rate limits stay in adapters; the domain uses normalized contracts.

### Offline work

```text
Local capture or edit
  → visible pending state
  → synchronization
  → canonical acceptance or resolvable conflict
```

Pending work is not confirmed context for an agent before canonical acceptance. Offline availability never implies a fresh calendar, push delivery, or completed server-side work.

## Architectural boundaries

- **Workspace and sensitivity:** Each request, record, cache entry, relation, search result, and export has an authorized scope. `All my work` is read-only.
- **Evidence and freshness:** Claims, recommendations, and planning results retain provenance, review state, and freshness. Unknown information stays unknown.
- **Data integrity:** Stable IDs, expected revisions, idempotency, history, and tombstones protect synchronization and guarded Undo.
- **Trust and actions:** Material mutations and external effects follow the proposal/approval/audit contract in the README.
- **Secrets and privacy:** Credentials use approved secret storage. Protected source content must not leak into static files, logs, backups, client bundles, or unauthorized AI context.
- **Adapters:** External calendars, delivery channels, and AI providers are replaceable integrations; they do not define the Lumi domain model.

## Extension checklist

Before adding a feature or integration, establish:

1. the canonical record and its workspace/sensitivity ownership;
2. server-side authorization and API/input validation;
3. revision, history, Undo, migration, and synchronization effects;
4. offline, failure, freshness, and conflict behavior;
5. provider/context exposure and explicit approval requirements;
6. targeted tests and documentation updates.

For detailed product rules, acceptance scenarios, and operational safeguards, return to [README.md](README.md).
