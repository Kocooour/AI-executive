# AI Executive

Local-first Personal AI OS prototype.

## Run

```bash
npm install
npm run dev
```

### Iteration 1
- Responsive desktop/mobile shell
- Today view
- Task completion
- Quick task capture
- Foundation for Inbox, Upcoming, Projects, Areas and Notes

### Iteration 2\n- IndexedDB persistence with Dexie\n- Persistent task creation and completion\n- Inbox backed by local entity data\n- UUID-based local entities\n\nNext: Projects, Areas, Notes and richer task scheduling.

### Iteration 10–11
- First-class relations
- Bidirectional relation traversal
- Area aggregates related projects and tasks
- Project aggregates related tasks and notes

Next: migrate legacy property links fully into relations and add relation-aware search.

### Iteration 13–14
- Relation-aware Context Builder
- Model-independent Tool API: search/get/create/update/get_context
- Agent definitions with explicit tool allowlists
- No LLM or Hermes dependency in Core

### AI provider
The assistant calls the server-side `/api/ai` endpoint. Set `OPENAI_API_KEY` and optionally `OPENAI_MODEL` in the deployment environment. Secrets are never stored in IndexedDB or exposed to the browser. If the endpoint is unavailable, the UI falls back to LocalPreviewProvider.

### MVP 2 persistence and PWA

- The server source of truth is SQLite at `.data/store.sqlite` (or `$AI_EXECUTIVE_DATA_DIR/store.sqlite`).
- On first runtime access, an existing `.data/store.json` is migrated without changing entity IDs or relations and retained as a legacy recovery copy.
- Logical JSON backups live in `.data/backups`. The Settings screen can create and restore them; restore always creates a safety backup first.
- One automatic daily backup is created before the first data change of the day.
- The app ships a manifest, icons, offline shell, and service worker. Installation outside localhost requires HTTPS.
