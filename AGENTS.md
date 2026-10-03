# Albert development workflow

These instructions apply to every software-development task in this repository.

## Required model roles

Use the following four-role workflow for every development iteration, including bug fixes, refactors, UI work, integrations, security changes, and deployment preparation:

1. The primary strong model owns requirements analysis, solution design, architecture, validation against the original Albert brief, and the final decision on readiness.
2. Delegate implementation to one medium model. Prefer `gpt-6-sol` unless the task or environment requires another comparable model.
3. After an implementation is available, run two independent lightweight test agents in parallel. Prefer `gpt-6-luna`:
   - Tester A covers functional behavior, UX, responsive/mobile behavior, and acceptance criteria.
   - Tester B covers regressions, edge cases, security implications, data integrity, and failure recovery.
4. The primary strong model reviews both test reports, reproduces material findings when possible, coordinates fixes, and performs the final verification.

Do not treat an implementation as complete before both independent testers have reported, unless agent tooling is unavailable or a higher-priority safety/system constraint prevents delegation. If that happens, state the limitation explicitly in the final response and perform equivalent local checks.

## Scope control

- Validate every iteration against the original Albert product brief and the user's latest requirements.
- Preserve existing work and data. Do not remove or overwrite unrelated behavior.
- If a proposed change materially diverges from the original brief or requires a product decision, ask the user before implementing that divergence.
- Testers must inspect the implemented result independently; they must not merely restate the implementation agent's report.
- The primary model remains accountable for the delivered result and must not accept agent findings without review.

## Delivery policy

- After a development iteration passes the required reviews and final verification, commit it, push `main`, and deploy it to the configured Albert server without asking for an additional confirmation.
- Before deployment, preserve unrelated server changes, create and verify a recoverable database backup, use a fast-forward-only update, build the production application, restart it through the configured service manager, and verify the service, database integrity, authentication boundary, and configured HTTPS route.
- If credentials, server state, a failed check, or a destructive/conflicting condition prevents safe delivery, stop at that boundary and report the concrete blocker instead of weakening safeguards.
