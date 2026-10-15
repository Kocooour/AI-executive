# Client UI layout

`app/page.tsx` is the app shell: it calls `useLumiApp()` once and composes the views.

| Path | Contents |
| --- | --- |
| `use-lumi-app.tsx` | Client state, effects and handlers not yet moved to a domain hook. Calls the domain hooks and returns everything as one object, typed as `LumiApp`. |
| `hooks/use-*.ts` | Domain hooks, one per area of the app (`use-app-badge.ts`, `use-attention.ts`, `use-backups.ts`, `use-day-plan.ts`, `use-notifications.ts`, `use-passkeys.ts`, `use-sign-in.ts`, `use-sync.ts`). Each takes the values it needs from the rest of the app as arguments and returns its state and handlers, which `useLumiApp` passes on in its result (spread, or listed key by key where it also uses them itself). |
| `views/*.tsx` | One component per screen area. Each takes `{ app }: { app: LumiApp }`, destructures what it renders and holds no state of its own. |
| `types.ts` | Shapes of API responses and view models used by the client. |
| `copy.ts` | Czech and English UI strings. |
| `navigation.ts` | View lists and icons for the sidebar, the mobile bar and the "More" sheet. |
| `format.ts` | Display helpers that depend on the UI strings. |

Rules for changes:

- Client-side filtering in a view is presentation only. Workspace authorization, revisions and approvals stay on the server path described in [the architecture contract](../../docs/ARCHITECTURE.md), with product requirements in [PRODUCT.md](../../docs/PRODUCT.md).
- Add new state and handlers to the domain hook they belong to, or to `use-lumi-app.tsx` while that area has none; do not duplicate state inside a view.
- `use-lumi-app.tsx` was split one domain at a time, each move verbatim and in its own PR. The sync core (local copy, revision, saving and loading) is in `use-sync.ts`; the start-up synchronization, sign-out and the refresh on focus still live in `use-lumi-app.tsx`, because they also set up the address, workspaces and the session.
- Pure logic without React or UI strings belongs in `lib/` with a test.
