# Client UI layout

`app/page.tsx` is the app shell: it calls `useLumiApp()` once and composes the views.

| Path | Contents |
| --- | --- |
| `use-lumi-app.tsx` | All client state, effects and handlers. Returns one object, typed as `LumiApp`. |
| `views/*.tsx` | One component per screen area. Each takes `{ app }: { app: LumiApp }`, destructures what it renders and holds no state of its own. |
| `types.ts` | Shapes of API responses and view models used by the client. |
| `copy.ts` | Czech and English UI strings. |
| `navigation.ts` | View lists and icons for the sidebar, the mobile bar and the "More" sheet. |
| `format.ts` | Display helpers that depend on the UI strings. |

Rules for changes:

- Client-side filtering in a view is presentation only. Workspace authorization, revisions and approvals stay on the server path described in the repository README.
- Add new state and handlers to `use-lumi-app.tsx` and return them; do not duplicate state inside a view.
- Pure logic without React or UI strings belongs in `lib/` with a test.
