# Development

This guide describes the current repository workflow. The canonical product, security, and operations contract is [README.md](../README.md); the shared agent rules are in [AGENTS.md](../AGENTS.md).

## Prerequisites

Use a current supported Node.js release and pnpm. The repository has a `pnpm-lock.yaml`; use pnpm consistently so dependency changes remain reproducible.

```bash
pnpm install
cp .env.example .env.local
```

Configure only the local values you need in `.env.local`. Never commit it, credentials, private source data, backups, or production configuration. Any development authentication shortcut is limited to local use and must not be enabled in production.

## Common commands

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Start the local Next.js development server. |
| `pnpm build` | Create the production build and check production compilation. |
| `pnpm start` | Start the built production application. |
| `pnpm hash-password` | Run the repository password-hash helper. |

The current package scripts do not define a general `test` command. Run focused tests when they exist, and add targeted automated coverage with meaningful new business logic or a regression fix.

## Local data

SQLite state, caches, and backups may contain private personal data. Keep local data outside static assets, do not commit it, and do not attach it to issues or pull requests. Follow the README for data-location, backup, restore, and production safeguards.

A browser cache or offline queue is not the canonical store. Confirm that sync failures, pending work, conflicts, and stale external data are visible rather than silently treated as success.

## Change checklist

Before opening a pull request:

1. Read the relevant README contract and inspect existing code patterns.
2. Keep workspace selection and authorization on the server-side path; `All my work` remains read-only.
3. Preserve proposal → approval → revision-checked action → audit / guarded Undo for meaningful mutations and external side effects.
4. Keep provider-specific behavior in adapters, and minimize the context sent to external models or services.
5. Exercise the changed path and its relevant authorization, offline, failure, and recovery behavior.
6. Run `pnpm build` for source changes, plus available targeted tests.
7. Review the diff for secrets, raw personal data, unrelated changes, and migration or synchronization impact.

## Git and review workflow

Use a separate worktree or clone per simultaneous agent. Create a focused branch from current `main`:

```text
docs/<topic>
feat/<topic>
fix/<topic>
chore/<topic>
```

Do not develop directly on `main`, force-push a shared branch, or modify another agent's branch without an explicit request. Open a pull request for every change with:

- **Summary** — what changed and why;
- **Product / architecture impact** — affected contracts, workspaces, integrations, or data;
- **Validation** — commands and manual checks actually performed;
- **Risks / migrations** — data, sync, privacy, deployment, or compatibility considerations;
- **Follow-ups** — deliberately deferred work.

Ask for independent review when a change affects security, authorization, private data, synchronization, integrations, or deployment.

## Operations boundary

A pull request or merge does not authorize deployment. Production credentials, database migrations, live integrations, backups/restores, and service changes require explicit approval and the safeguards in [README.md](../README.md).
