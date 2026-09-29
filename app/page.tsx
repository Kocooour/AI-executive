"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  db,
  seed,
  migratePropertyRelations,
  type Entity,
  type EntityType,
} from "../lib/db";
import { buildContext, type ContextBundle } from "../lib/context";
import { LocalPreviewProvider, type AIMessage } from "../lib/ai-provider";
import { assistantAgent } from "../lib/agents";
import { mergeSnapshots, type ServerSnapshot } from "../lib/server-sync";

const views = [
    "Home",
    "Inbox",
    "Today",
    "Upcoming",
    "Anytime",
    "Someday",
    "Completed",
    "Projects",
    "Areas",
    "Notes",
  ],
  day = 86400000;
const moreViews = [
  "Inbox",
  "Upcoming",
  "Anytime",
  "Someday",
  "Completed",
  "Areas",
  "Notes",
];
const ymd = (d = new Date()) =>
  [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, "0"),
    String(d.getDate()).padStart(2, "0"),
  ].join("-");

export default function App() {
  const [items, setItems] = useState<Entity[]>([]),
    [relations, setRelations] = useState<any[]>([]),
    [view, setView] = useState("Today"),
    [text, setText] = useState(""),
    [selected, setSelected] = useState<Entity | null>(null),
    [query, setQuery] = useState(""),
    [capture, setCapture] = useState(false),
    [captureType, setCaptureType] = useState<"task" | "note">("task"),
    [captureProjectId, setCaptureProjectId] = useState(""),
    [draft, setDraft] = useState(""),
    [undo, setUndo] = useState<Entity | null>(null),
    [context, setContext] = useState<ContextBundle | null>(null),
    [assistantOpen, setAssistantOpen] = useState(false),
    [moreOpen, setMoreOpen] = useState(false),
    [startupView, setStartupView] = useState("Today"),
    [workspaceName, setWorkspaceName] = useState("Personal"),
    [workspaceDraft, setWorkspaceDraft] = useState("Personal"),
    [settingsSaved, setSettingsSaved] = useState(false),
    [syncStatus, setSyncStatus] = useState<
      "connecting" | "synced" | "syncing" | "offline"
    >("connecting"),
    [aiText, setAiText] = useState(""),
    [messages, setMessages] = useState<AIMessage[]>([]);
  const serverRevision = useRef(0);
  const syncQueue = useRef<Promise<void>>(Promise.resolve());
  async function load() {
    setItems(await db.entities.toArray());
    setRelations(await db.relations.toArray());
  }
  async function applySnapshot(snapshot: ServerSnapshot) {
    await db.transaction("rw", db.entities, db.relations, async () => {
      await db.entities.clear();
      await db.relations.clear();
      if (snapshot.entities.length) await db.entities.bulkAdd(snapshot.entities);
      if (snapshot.relations.length)
        await db.relations.bulkAdd(snapshot.relations);
    });
    serverRevision.current = snapshot.revision;
    await load();
  }
  async function putSnapshot(
    entities: Entity[],
    snapshotRelations: any[],
    baseRevision: number,
  ) {
    return fetch("/api/store", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseRevision,
        entities,
        relations: snapshotRelations,
      }),
    });
  }
  async function syncToServer() {
    const operation = syncQueue.current.then(async () => {
      setSyncStatus("syncing");
      const localEntities = await db.entities.toArray();
      const localRelations = await db.relations.toArray();
      let response = await putSnapshot(
        localEntities,
        localRelations,
        serverRevision.current,
      );
      if (response.status === 409) {
        const current = (await response.json()) as ServerSnapshot;
        const merged = mergeSnapshots(current, localEntities, localRelations);
        response = await putSnapshot(
          merged.entities,
          merged.relations,
          current.revision,
        );
      }
      if (!response.ok) throw new Error("Server synchronization failed");
      const saved = (await response.json()) as ServerSnapshot;
      await applySnapshot(saved);
      localStorage.setItem("ai-executive-server-synced", "1");
      setSyncStatus("synced");
    });
    syncQueue.current = operation.catch(() => {
      setSyncStatus("offline");
    });
    return syncQueue.current;
  }
  async function pullFromServer() {
    try {
      const response = await fetch("/api/store", { cache: "no-store" });
      if (!response.ok) throw new Error("Server synchronization failed");
      const snapshot = (await response.json()) as ServerSnapshot;
      if (snapshot.revision > serverRevision.current) {
        await applySnapshot(snapshot);
      }
      setSyncStatus("synced");
    } catch {
      setSyncStatus("offline");
    }
  }
  async function inspect(e: Entity) {
    setSelected(e);
    setContext(await buildContext(e.id, 2));
  }
  function closeDetail() {
    setSelected(null);
    setContext(null);
  }
  async function askAI() {
    if (!aiText.trim()) return;
    const user: { role: "user"; content: string } = {
      role: "user",
      content: aiText.trim(),
    };
    const history = [...messages, user];
    setMessages(history);
    setAiText("");
    try {
      const response = await fetch("/api/ai", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: history, context }),
      });
      if (response.ok) {
        const res = await response.json();
        setMessages([...history, { role: "assistant", content: res.message }]);
      } else {
        const provider = new LocalPreviewProvider();
        const res = await provider.complete({
          agent: assistantAgent,
          messages: history,
          context,
        });
        setMessages([...history, { role: "assistant", content: res.message }]);
      }
    } catch {
      const provider = new LocalPreviewProvider();
      const res = await provider.complete({
        agent: assistantAgent,
        messages: history,
        context,
      });
      setMessages([...history, { role: "assistant", content: res.message }]);
    }
  }
  useEffect(() => {
    const savedView = localStorage.getItem("ai-executive-startup-view");
    const savedWorkspaceName = localStorage.getItem(
      "ai-executive-workspace-name",
    );
    if (savedView && views.includes(savedView)) {
      setStartupView(savedView);
      setView(savedView);
    }
    if (savedWorkspaceName) {
      setWorkspaceName(savedWorkspaceName);
      setWorkspaceDraft(savedWorkspaceName);
    }
    async function initialize() {
      await seed();
      await migratePropertyRelations();
      try {
        const response = await fetch("/api/store", { cache: "no-store" });
        if (!response.ok) throw new Error("Server synchronization failed");
        let snapshot = (await response.json()) as ServerSnapshot;
        const alreadySynchronized =
          localStorage.getItem("ai-executive-server-synced") === "1";
        if (!alreadySynchronized) {
          const localEntities = await db.entities.toArray();
          const localRelations = await db.relations.toArray();
          const merged = mergeSnapshots(snapshot, localEntities, localRelations);
          let saveResponse = await putSnapshot(
            merged.entities,
            merged.relations,
            snapshot.revision,
          );
          if (saveResponse.status === 409) {
            snapshot = (await saveResponse.json()) as ServerSnapshot;
            const retry = mergeSnapshots(
              snapshot,
              merged.entities,
              merged.relations,
            );
            saveResponse = await putSnapshot(
              retry.entities,
              retry.relations,
              snapshot.revision,
            );
          }
          if (!saveResponse.ok) throw new Error("Initial synchronization failed");
          snapshot = (await saveResponse.json()) as ServerSnapshot;
          localStorage.setItem("ai-executive-server-synced", "1");
        }
        await applySnapshot(snapshot);
        setSyncStatus("synced");
      } catch {
        await load();
        setSyncStatus("offline");
      }
    }
    initialize();
  }, []);

  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === "visible") pullFromServer();
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);

  function saveWorkspaceName() {
    const name = workspaceDraft.trim();
    if (!name) return;
    localStorage.setItem("ai-executive-workspace-name", name);
    setWorkspaceName(name);
    setWorkspaceDraft(name);
    setSettingsSaved(true);
    window.setTimeout(() => setSettingsSaved(false), 1800);
  }
  const tasks = items.filter((x) => x.type === "task"),
    projects = items.filter((x) => x.type === "project"),
    areas = items.filter((x) => x.type === "area"),
    today = ymd();
  const targets = (sourceId: string, type: string) =>
    relations
      .filter((r) => r.sourceEntityId === sourceId && r.relationType === type)
      .map((r) => r.targetEntityId);
  const sources = (targetId: string, type: string) =>
    relations
      .filter((r) => r.targetEntityId === targetId && r.relationType === type)
      .map((r) => r.sourceEntityId);
  const visible = useMemo(
    () =>
      tasks.filter((t) => {
        if (view === "Completed") return t.status === "completed";
        if (t.status !== "open") return false;
        const p = t.properties;
        if (view === "Inbox") return p.inbox === true;
        if (view === "Today") return p.today === true || p.when === today;
        if (view === "Upcoming")
          return typeof p.when === "string" && p.when > today;
        if (view === "Anytime")
          return !p.when && !p.someday && p.inbox !== true;
        if (view === "Someday") return p.someday === true;
        return true;
      }),
    [tasks, view, today],
  );
  function parseCapture(raw: string) {
    let title = raw.trim(),
      when = "";
    const lower = title.toLowerCase();
    if (lower.includes(" zítra")) {
      when = ymd(new Date(Date.now() + day));
      title = title.replace(/\s+zítra/i, "");
    } else if (lower.includes(" dnes")) {
      when = today;
      title = title.replace(/\s+dnes/i, "");
    }
    const m = title.match(/\s+(\d{1,2})\.(\d{1,2})\.?$/);
    if (m) {
      const d = new Date();
      d.setMonth(Number(m[2]) - 1, Number(m[1]));
      when = ymd(d);
      title = title.slice(0, m.index).trim();
    }
    return { title, when };
  }
  async function create(
    type: EntityType,
    title: string,
    extra: Record<string, unknown> = {},
  ) {
    if (!title.trim()) return;
    const now = Date.now(),
      id = crypto.randomUUID(),
      projectId = typeof extra.projectId === "string" ? extra.projectId : "",
      areaId = typeof extra.areaId === "string" ? extra.areaId : "",
      properties = { ...extra },
      parsed =
        type === "task"
          ? parseCapture(title)
          : { title: title.trim(), when: "" };
    delete properties.projectId;
    delete properties.areaId;
    await db.transaction("rw", db.entities, db.relations, async () => {
      await db.entities.add({
        id,
        type,
        title: parsed.title,
        status: type === "task" ? "open" : "active",
        workspaceId: "personal",
        properties:
          type === "task"
            ? {
                inbox: !projectId && view === "Inbox" && !parsed.when,
                today: view === "Today" || parsed.when === today,
                ...(parsed.when ? { when: parsed.when } : {}),
                ...properties,
              }
            : properties,
        createdAt: now,
        updatedAt: now,
      });
      if (projectId) {
        await db.relations.add({
          id: crypto.randomUUID(),
          workspaceId: "personal",
          sourceEntityId: id,
          targetEntityId: projectId,
          relationType: "belongs_to_project",
          createdAt: now,
        });
      }
      if (areaId) {
        await db.relations.add({
          id: crypto.randomUUID(),
          workspaceId: "personal",
          sourceEntityId: id,
          targetEntityId: areaId,
          relationType: "belongs_to_area",
          createdAt: now,
        });
      }
    });
    setText("");
    setDraft("");
    await syncToServer();
    await load();
    if (selected) setContext(await buildContext(selected.id, 2));
    return id;
  }

  function openCapture(type: "task" | "note" = "task", projectId = "") {
    setCaptureType(type);
    setCaptureProjectId(projectId);
    setDraft("");
    setCapture(true);
  }
  async function submitCapture() {
    const title = draft.trim();
    if (!title) return;
    const globalTask = captureType === "task" && !captureProjectId;
    setCapture(false);
    if (globalTask) {
      closeDetail();
      setMoreOpen(false);
      setView("Inbox");
    }
    try {
      await create(captureType, title, {
        ...(captureProjectId ? { projectId: captureProjectId } : {}),
        ...(captureType === "task"
          ? { inbox: !captureProjectId, today: false }
          : {}),
      });
    } catch {
      setDraft(title);
      setCapture(true);
      setSyncStatus("offline");
    }
  }
  async function relate(
    sourceId: string,
    targetId: string,
    relationType: string,
  ) {
    const existing = await db.relations
      .where("sourceEntityId")
      .equals(sourceId)
      .filter((r) => r.relationType === relationType)
      .toArray();
    await db.transaction("rw", db.relations, async () => {
      await db.relations.bulkDelete(existing.map((r) => r.id));
      if (targetId)
        await db.relations.add({
          id: crypto.randomUUID(),
          workspaceId: "personal",
          sourceEntityId: sourceId,
          targetEntityId: targetId,
          relationType,
          createdAt: Date.now(),
        });
    });
    await syncToServer();
    await load();
    if (selected) setContext(await buildContext(selected.id, 2));
  }
  async function rename(e: Entity, title: string) {
    if (!title.trim()) return;
    await db.entities.update(e.id, {
      title: title.trim(),
      updatedAt: Date.now(),
    });
    await syncToServer();
    await load();
    setSelected((await db.entities.get(e.id)) || null);
  }
  async function remove(e: Entity) {
    setUndo(e);
    await db.entities.delete(e.id);
    await syncToServer();
    closeDetail();
    load();
  }
  async function restore() {
    if (!undo) return;
    await db.entities.put({
      ...undo,
      status: undo.status === "completed" ? "open" : undo.status,
      updatedAt: Date.now(),
    });
    await syncToServer();
    setUndo(null);
    load();
  }
  async function patch(e: Entity, properties: Record<string, unknown>) {
    await db.entities.update(e.id, {
      properties: { ...e.properties, ...properties },
      updatedAt: Date.now(),
    });
    await syncToServer();
    await load();
    setSelected((await db.entities.get(e.id)) || null);
  }
  async function done(id: string) {
    const t = await db.entities.get(id);
    if (
      t?.type === "task" &&
      (t.properties.recurrence || t.properties.repeat)
    ) {
      const rec = (t.properties.recurrence || {
        frequency: t.properties.repeat,
        interval: 1,
        mode: "scheduled",
      }) as any;
      const base =
        rec.mode === "completion"
          ? new Date()
          : new Date(String(t.properties.when || today));
      const next = new Date(base),
        n = Number(rec.interval || 1);
      if (rec.frequency === "daily") next.setDate(next.getDate() + n);
      if (rec.frequency === "weekly") next.setDate(next.getDate() + 7 * n);
      if (rec.frequency === "monthly") next.setMonth(next.getMonth() + n);
      if (rec.frequency === "yearly") next.setFullYear(next.getFullYear() + n);
      await create("task", t.title, {
        ...t.properties,
        projectId: targets(t.id, "belongs_to_project")[0],
        areaId: targets(t.id, "belongs_to_area")[0],
        when: ymd(next),
        today: false,
        inbox: false,
      });
    }
    if (t) setUndo(t);
    await db.entities.update(id, {
      status: "completed",
      updatedAt: Date.now(),
    });
    await syncToServer();
    closeDetail();
    load();
  }
  const type: EntityType =
    view === "Projects"
      ? "project"
      : view === "Areas"
        ? "area"
        : view === "Notes"
          ? "note"
          : "task";
  const collection = ["Projects", "Areas", "Notes"].includes(view)
    ? items.filter((x) => x.type === type)
    : visible;
  return (
    <main>
      <aside>
        <button
          className="workspaceButton"
          onClick={() => {
            setView("Settings");
            closeDetail();
          }}
          aria-label="Workspace settings"
        >
          <b>{workspaceName}</b>
          <span>⌄</span>
        </button>
        <nav>
          {views.map((x) => (
            <button
              className={view === x ? "active" : ""}
              onClick={() => {
                setView(x);
                closeDetail();
              }}
              key={x}
            >
              {x}
              {x === "Today" ? (
                <span>
                  {
                    tasks.filter(
                      (t) =>
                        t.status === "open" &&
                        (t.properties.today === true ||
                          t.properties.when === today),
                    ).length
                  }
                </span>
              ) : null}
            </button>
          ))}
        </nav>
        <footer className="sidebarActions">
          <button onClick={() => openCapture()} aria-label="Create a new task">
            ＋ New
          </button>
          <button
            className={view === "Settings" ? "active" : ""}
            onClick={() => {
              setView("Settings");
              closeDetail();
            }}
          >
            ⚙ Settings
          </button>
        </footer>
      </aside>
      <section>
        <header>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onFocus={() => setView("Search")}
            placeholder="Search…"
            aria-label="Search"
          />
          <button
            className="aiButton"
            onClick={() => setAssistantOpen(true)}
            aria-label="Ask AI"
          >
            ◇ Ask AI
          </button>
        </header>
        <div className="content">
          <p className="eyebrow">PERSONAL · LOCAL</p>
          <h1>{view}</h1>
          {view === "Home" && (
            <div className="dashboard">
              <div>
                <b>
                  {
                    tasks.filter(
                      (t) =>
                        t.status === "open" &&
                        (t.properties.today === true ||
                          t.properties.when === today),
                    ).length
                  }
                </b>
                <span>Today</span>
              </div>
              <div>
                <b>
                  {
                    tasks.filter(
                      (t) => t.status === "open" && t.properties.inbox === true,
                    ).length
                  }
                </b>
                <span>Inbox</span>
              </div>
              <div>
                <b>{projects.filter((p) => p.status === "active").length}</b>
                <span>Projects</span>
              </div>
            </div>
          )}
          {view === "Search" && query && (
            <div className="searchResults">
              {items
                .filter((x) => {
                  const q = query.toLowerCase(),
                    linked = relations
                      .filter(
                        (r) =>
                          r.sourceEntityId === x.id ||
                          r.targetEntityId === x.id,
                      )
                      .flatMap((r) => [
                        items.find((i) => i.id === r.sourceEntityId)?.title ||
                          "",
                        items.find((i) => i.id === r.targetEntityId)?.title ||
                          "",
                      ])
                      .join(" ");
                  return (x.title + " " + (x.content || "") + " " + linked)
                    .toLowerCase()
                    .includes(q);
                })
                .map((x) => (
                  <article key={x.id} onClick={() => inspect(x)}>
                    <div>
                      <strong>{x.title}</strong>
                      <small>{x.type}</small>
                    </div>
                  </article>
                ))}
            </div>
          )}
          {view === "Settings" && (
            <div className="settingsPanel">
              <section>
                <h2>Workspace</h2>
                <label>
                  Name
                  <div className="workspaceNameEditor">
                    <input
                      value={workspaceDraft}
                      onChange={(e) => {
                        setWorkspaceDraft(e.target.value);
                        setSettingsSaved(false);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") saveWorkspaceName();
                      }}
                      aria-label="Workspace name"
                    />
                    <button
                      onClick={saveWorkspaceName}
                      disabled={!workspaceDraft.trim()}
                    >
                      Save
                    </button>
                  </div>
                </label>
                {settingsSaved && (
                  <p className="saveConfirmation" role="status">
                    Workspace saved.
                  </p>
                )}
                <label>
                  Open on startup
                  <select
                    value={startupView}
                    onChange={(e) => {
                      setStartupView(e.target.value);
                      localStorage.setItem(
                        "ai-executive-startup-view",
                        e.target.value,
                      );
                    }}
                  >
                    {views
                      .filter((item) => item !== "Home")
                      .map((item) => (
                        <option key={item}>{item}</option>
                      ))}
                  </select>
                </label>
              </section>
              <section>
                <h2>Data & AI</h2>
                <p>
                  Your workspace data is stored locally in this browser. AI
                  uses the server provider when configured and falls back to a
                  local preview otherwise.
                </p>
                <dl>
                  <div>
                    <dt>Stored items</dt>
                    <dd>{items.length}</dd>
                  </div>
                  <div>
                    <dt>Relations</dt>
                    <dd>{relations.length}</dd>
                  </div>
                  <div>
                    <dt>Server sync</dt>
                    <dd className={`syncStatus ${syncStatus}`}>
                      {syncStatus === "synced"
                        ? "Synced"
                        : syncStatus === "syncing"
                          ? "Syncing…"
                          : syncStatus === "offline"
                            ? "Offline"
                            : "Connecting…"}
                    </dd>
                  </div>
                </dl>
              </section>
            </div>
          )}
          {view !== "Settings" && (
            <>
              <div
                className={
                  "list " +
                  (view === "Home" || view === "Search" ? "secondary" : "")
                }
              >
                {collection.map((x) => (
              <article key={x.id} onClick={() => inspect(x)}>
                {x.type === "task" ? (
                  <button
                    className="check"
                    onClick={(e) => {
                      e.stopPropagation();
                      done(x.id);
                    }}
                  >
                    ○
                  </button>
                ) : (
                  <div className="entityIcon">
                    {x.type === "project" ? "◆" : x.type === "area" ? "●" : "▤"}
                  </div>
                )}
                <div>
                  <strong>{x.title}</strong>
                  <small>
                    {x.type === "task"
                      ? [
                          x.properties.priority &&
                          x.properties.priority !== "none"
                            ? "● " + x.properties.priority
                            : null,
                          x.properties.when,
                          x.properties.deadline &&
                            "deadline " + x.properties.deadline,
                        ]
                          .filter(Boolean)
                          .join(" · ") ||
                        (x.properties.today === true
                          ? "Today"
                          : x.properties.someday === true
                            ? "Someday"
                            : x.properties.inbox === true
                              ? "Inbox"
                              : "Anytime")
                      : x.type}
                  </small>
                </div>
                  </article>
                ))}
              </div>
              <div className="capture">
                <input
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && create(type, text)}
                  placeholder={"+ Add " + type}
                />
                <button onClick={() => create(type, text)}>Add</button>
              </div>
            </>
          )}
        </div>
      </section>
      <nav className="mobileNav">
        {["Home", "Today", "+", "Projects", "More"].map((x) => (
          <button
            key={x}
            className={
              (view === x || (x === "More" && moreOpen)) && x !== "+"
                ? "active"
                : ""
            }
            aria-label={x === "+" ? "Quick capture" : x}
            onClick={() => {
              if (x === "+") return openCapture();
              if (x === "More") return setMoreOpen((open) => !open);
              setMoreOpen(false);
              closeDetail();
              setView(x);
            }}
          >
            {x}
          </button>
        ))}
      </nav>
      {moreOpen && (
        <div className="mobileMoreBackdrop" onClick={() => setMoreOpen(false)}>
          <div className="mobileMore" onClick={(e) => e.stopPropagation()}>
            {moreViews.map((item) => (
              <button
                key={item}
                className={view === item ? "active" : ""}
                onClick={() => {
                  setView(item);
                  closeDetail();
                  setMoreOpen(false);
                }}
              >
                {item}
              </button>
            ))}
          </div>
        </div>
      )}
      {capture && (
        <div className="captureOverlay" onClick={() => setCapture(false)}>
          <form
            className="captureModal"
            onClick={(e) => e.stopPropagation()}
            onSubmit={(e) => {
              e.preventDefault();
              submitCapture();
            }}
          >
            <h2>{captureType === "note" ? "Add note" : "Quick Capture"}</h2>
            <input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={
                captureType === "note" ? "Note title" : "What needs to be done?"
              }
            />
            {captureType === "task" && (
              <p>Try “Zavolat Petrovi zítra” or “Servis 25.9.”</p>
            )}
            <div>
              <button type="button" onClick={() => setCapture(false)}>
                Cancel
              </button>
              <button
                type="submit"
                className="ai"
                disabled={!draft.trim()}
              >
                {captureType === "note" ? "Add note" : "Add task"}
              </button>
            </div>
          </form>
        </div>
      )}
      {selected && (
        <div className="backdrop" onClick={closeDetail}>
          <aside className="detail" onClick={(e) => e.stopPropagation()}>
            <button
              className="close"
              onClick={closeDetail}
            >
              ×
            </button>
            <p className="eyebrow">{selected.type}</p>
            <input
              className="titleEdit"
              value={selected.title}
              onChange={(e) =>
                setSelected({ ...selected, title: e.target.value })
              }
              onBlur={(e) => rename(selected, e.target.value)}
            />
            {context && (
              <div className="contextStrip">
                <b>Context</b>
                <span>
                  {context.summary.tasks} tasks · {context.summary.notes} notes
                  · {context.summary.projects} projects ·{" "}
                  {context.summary.areas} areas
                </span>
                <small>
                  {context.related
                    .slice(0, 6)
                    .map((x) => x.title)
                    .join(" · ") || "No related entities"}
                </small>
              </div>
            )}
            {selected.type === "area" && (
              <div className="projectDetail">
                <h3>PROJECTS</h3>
                {projects
                  .filter((p) =>
                    sources(selected.id, "belongs_to_area").includes(p.id),
                  )
                  .map((p) => (
                    <article key={p.id} onClick={() => inspect(p)}>
                      <div className="entityIcon">◆</div>
                      <div>
                        <strong>{p.title}</strong>
                        <small>project</small>
                      </div>
                    </article>
                  ))}
                <h3>TASKS</h3>
                {tasks
                  .filter(
                    (t) =>
                      t.status === "open" &&
                      sources(selected.id, "belongs_to_area").includes(t.id),
                  )
                  .map((t) => (
                    <article key={t.id} onClick={() => inspect(t)}>
                      <button
                        className="check"
                        onClick={(e) => {
                          e.stopPropagation();
                          done(t.id);
                        }}
                      >
                        ○
                      </button>
                      <strong>{t.title}</strong>
                    </article>
                  ))}
              </div>
            )}
            {selected.type === "project" && (
              <div className="projectDetail">
                <label>
                  Area
                  <select
                    value={String(
                      targets(selected.id, "belongs_to_area")[0] || "",
                    )}
                    onChange={async (e) => {
                      await relate(
                        selected.id,
                        e.target.value,
                        "belongs_to_area",
                      );
                    }}
                  >
                    <option value="">None</option>
                    {areas.map((a) => (
                      <option value={a.id} key={a.id}>
                        {a.title}
                      </option>
                    ))}
                  </select>
                </label>
                <h3>OPEN TASKS</h3>
                {tasks
                  .filter(
                    (t) =>
                      t.status === "open" &&
                      sources(selected.id, "belongs_to_project").includes(t.id),
                  )
                  .map((t) => (
                    <article key={t.id}>
                      <button className="check" onClick={() => done(t.id)}>
                        ○
                      </button>
                      <strong>{t.title}</strong>
                    </article>
                  ))}
                <button
                  onClick={() => {
                    openCapture("task", selected.id);
                  }}
                >
                  ＋ Add task
                </button>
                <h3>NOTES</h3>
                {items
                  .filter(
                    (n) =>
                      n.type === "note" &&
                      sources(selected.id, "belongs_to_project").includes(n.id),
                  )
                  .map((n) => (
                    <article key={n.id}>
                      <div>
                        <strong>{n.title}</strong>
                        <p>{n.content}</p>
                      </div>
                    </article>
                  ))}
                <button
                  onClick={() => {
                    openCapture("note", selected.id);
                  }}
                >
                  ＋ Add note
                </button>
              </div>
            )}
            {selected.type === "note" && (
              <div className="fields">
                <label>
                  Project
                  <select
                    value={String(
                      targets(selected.id, "belongs_to_project")[0] || "",
                    )}
                    onChange={async (e) => {
                      await relate(
                        selected.id,
                        e.target.value,
                        "belongs_to_project",
                      );
                    }}
                  >
                    <option value="">None</option>
                    {projects.map((p) => (
                      <option value={p.id} key={p.id}>
                        {p.title}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            )}
            {selected.type === "task" && (
              <div className="fields">
                <label>
                  When
                  <input
                    type="date"
                    value={String(selected.properties.when || "")}
                    onChange={(e) =>
                      patch(selected, {
                        when: e.target.value,
                        today: e.target.value === today,
                        inbox: false,
                        someday: false,
                      })
                    }
                  />
                </label>
                <label>
                  Deadline
                  <input
                    type="date"
                    value={String(selected.properties.deadline || "")}
                    onChange={(e) =>
                      patch(selected, { deadline: e.target.value })
                    }
                  />
                </label>
                <label>
                  Project
                  <select
                    value={String(
                      targets(selected.id, "belongs_to_project")[0] || "",
                    )}
                    onChange={async (e) => {
                      await patch(selected, { inbox: false });
                      await relate(
                        selected.id,
                        e.target.value,
                        "belongs_to_project",
                      );
                    }}
                  >
                    <option value="">None</option>
                    {projects.map((p) => (
                      <option value={p.id} key={p.id}>
                        {p.title}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Area
                  <select
                    value={String(
                      targets(selected.id, "belongs_to_area")[0] || "",
                    )}
                    onChange={async (e) => {
                      await relate(
                        selected.id,
                        e.target.value,
                        "belongs_to_area",
                      );
                    }}
                  >
                    <option value="">None</option>
                    {areas.map((a) => (
                      <option value={a.id} key={a.id}>
                        {a.title}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Priority
                  <select
                    value={String(selected.properties.priority || "none")}
                    onChange={(e) =>
                      patch(selected, { priority: e.target.value })
                    }
                  >
                    <option value="none">None</option>
                    <option value="low">Low</option>
                    <option value="medium">Medium</option>
                    <option value="high">High</option>
                  </select>
                </label>
                <label>
                  Reminder
                  <input
                    type="datetime-local"
                    value={String(selected.properties.reminderAt || "")}
                    onChange={(e) =>
                      patch(selected, { reminderAt: e.target.value })
                    }
                  />
                </label>
                <label>
                  Task notes
                  <textarea
                    value={String(selected.properties.notes || "")}
                    onChange={(e) => patch(selected, { notes: e.target.value })}
                    placeholder="Notes…"
                  />
                </label>
                <label>
                  Checklist
                  <textarea
                    value={
                      Array.isArray(selected.properties.checklist)
                        ? (selected.properties.checklist as string[]).join("\n")
                        : ""
                    }
                    onChange={(e) =>
                      patch(selected, {
                        checklist: e.target.value.split("\n").filter(Boolean),
                      })
                    }
                    placeholder={"One item per line"}
                  />
                </label>
                <label>
                  Repeat
                  <select
                    value={String(
                      (selected.properties.recurrence as any)?.frequency ||
                        selected.properties.repeat ||
                        "",
                    )}
                    onChange={(e) =>
                      patch(selected, {
                        recurrence: e.target.value
                          ? {
                              frequency: e.target.value,
                              interval: 1,
                              mode: "scheduled",
                            }
                          : null,
                        repeat: null,
                      })
                    }
                  >
                    <option value="">Never</option>
                    <option value="daily">Daily</option>
                    <option value="weekly">Weekly</option>
                    <option value="monthly">Monthly</option>
                    <option value="yearly">Yearly</option>
                  </select>
                </label>
                {(selected.properties.recurrence as any)?.frequency && (
                  <>
                    <label>
                      Every
                      <input
                        type="number"
                        min="1"
                        value={String(
                          (selected.properties.recurrence as any)?.interval ||
                            1,
                        )}
                        onChange={(e) =>
                          patch(selected, {
                            recurrence: {
                              ...(selected.properties.recurrence as any),
                              interval: Number(e.target.value),
                            },
                          })
                        }
                      />
                    </label>
                    <label>
                      Repeat from
                      <select
                        value={String(
                          (selected.properties.recurrence as any)?.mode ||
                            "scheduled",
                        )}
                        onChange={(e) =>
                          patch(selected, {
                            recurrence: {
                              ...(selected.properties.recurrence as any),
                              mode: e.target.value,
                            },
                          })
                        }
                      >
                        <option value="scheduled">Scheduled date</option>
                        <option value="completion">Completion date</option>
                      </select>
                    </label>
                  </>
                )}
                <button
                  onClick={() =>
                    patch(selected, {
                      someday: true,
                      today: false,
                      when: "",
                      inbox: false,
                    })
                  }
                >
                  Move to Someday
                </button>
                <button onClick={() => done(selected.id)}>Complete</button>
                <button className="danger" onClick={() => remove(selected)}>
                  Delete
                </button>
              </div>
            )}
          </aside>
        </div>
      )}
      {assistantOpen && (
        <div className="assistantPanel">
          <div className="assistantHead">
            <b>Assistant</b>
            <button onClick={() => setAssistantOpen(false)}>×</button>
          </div>
          <div className="assistantContext">
            {context
              ? "Context: " + context.focus.title
              : "No entity context selected"}
          </div>
          <div className="assistantMessages">
            {messages.length === 0 && (
              <p>Ask about your tasks, projects, notes or current context.</p>
            )}
            {messages.map((m, i) => (
              <div key={i} className={"msg " + m.role}>
                {m.content}
              </div>
            ))}
          </div>
          <div className="assistantComposer">
            <input
              value={aiText}
              onChange={(e) => setAiText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") askAI();
              }}
              placeholder="Ask AI…"
            />
            <button onClick={askAI}>Send</button>
          </div>
        </div>
      )}
      {undo && (
        <div className="undo">
          Item changed <button onClick={restore}>Undo</button>
        </div>
      )}
    </main>
  );
}
