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
