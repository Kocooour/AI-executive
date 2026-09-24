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
