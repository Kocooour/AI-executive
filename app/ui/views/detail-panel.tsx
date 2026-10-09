"use client";
import { byManualOrder, taskDueTone } from "../../../lib/task-views";
import { addLocalDays, fromLocalDateTime, toLocalDateTime, ymd, zonedDateTimeToIso } from "../../../lib/local-dates";
import type { LumiApp } from "../use-lumi-app";
import { ProjectIcon } from "./project-icon";
import { DurationInput } from "./duration-input";
import { SyncConflicts } from "./sync-conflicts";
import { heldBackReason } from "./held-back";

export function DetailPanel({ app }: { app: LumiApp }) {
  const {
    titleEdited,
    titleEditSeq,
    noteOpenTexts,
    unsent,
    heldBack,
    askConfirm,
    acceptNativeDrop,
    areas,
    calendarToday,
    checklistDraft,
    closeDetail,
    editNotes,
    notesDraft,
    saveNotes,
    context,
    contextClaims,
    contextPredicateLabel,
    done,
    dragHandle,
    dragTarget,
    draggingId,
    inspect,
    language,
    notificationState,
    openCapture,
    patch,
    projects,
    relate,
    remove,
    rename,
    reopenTask,
    scheduleTask,
    scopedItems,
    selected,
    setActiveDragTarget,
    setChecklistDraft,
    setProjectStatus,
    setSelected,
    sources,
    targets,
    tasks,
    today,
    tr,
    workSession,
    workSessionAction,
    workSessionBusy,
  } = app;
  return (
    <>
      {selected && (
        <div className="backdrop" onClick={closeDetail}>
          <aside className="detail" onClick={(e) => e.stopPropagation()}>
            <button
              className="close"
              onClick={closeDetail}
            >
              ×
            </button>
            <p className="eyebrow">{tr(selected.type)}</p>
            <input
              className="titleEdit"
              maxLength={1000}
              value={selected.title}
              onChange={(e) => {
                titleEdited.current = true;
                titleEditSeq.current += 1;
                setSelected({ ...selected, title: e.target.value });
              }}
              onBlur={(e) => {
                // Only a title the user changed is saved; an untouched field cannot put back an old one.
                if (!titleEdited.current) { noteOpenTexts(); return; }
                // The title stays marked as edited (also for other tabs signing out) until it is
                // saved; a failed save keeps it marked, and typing on during the save keeps it too.
                const seq = titleEditSeq.current;
                rename(selected, e.target.value, seq).then(() => {
                  if (titleEditSeq.current !== seq) return;
                  titleEdited.current = false;
                  noteOpenTexts();
                }, () => undefined);
              }}
            />
            {heldBack.some((entity) => entity.id === selected.id)
              ? <p className="recordState recordHeldBack" role="status">{tr("heldBackDetail").replace("{reason}", () => heldBackReason(app, selected))}</p>
              : unsent.has(selected.id) && <p className="recordState" role="status">{tr("unsentDetail")}</p>}
            <SyncConflicts app={app} entity={selected} />
            {context && (
              <div className="contextStrip">
                <b>{tr("context")}</b>
                <span>
                  {tr("contextSummary").replace("{tasks}", String(context.summary.tasks)).replace("{notes}", String(context.summary.notes))
                    .replace("{projects}", String(context.summary.projects)).replace("{areas}", String(context.summary.areas))}
                </span>
                <small>
                  {context.related
                    .slice(0, 6)
                    .map((x) => x.title)
                    .join(" · ") || tr("noRelatedEntities")}
                </small>
              </div>
            )}
            {(selected.type === "task" || selected.type === "project") && (
              <section className="detailKnowledge" aria-label={tr("whatLumiKnows")}>
                <h3>{tr("whatLumiKnows2")}</h3>
                {contextClaims.filter((claim) => (claim.subject.canonicalEntityId === selected.id || claim.target?.canonicalEntityId === selected.id) && !claim.archivedAt).map((claim) => <article key={claim.id}>
                  <strong>{claim.subject.title} · {contextPredicateLabel(claim.predicate)}: {String(claim.literal?.value ?? claim.target?.title ?? "—")}</strong>
                  <small>{claim.reviewStatus === "confirmed" ? (tr("confirmed2")) : claim.reviewStatus === "proposed" ? (tr("toReview2")) : (tr("rejected"))} · {claim.freshness === "current" ? (tr("current2")) : claim.freshness === "needs_review" ? (tr("needsReview2")) : (tr("stale2"))}{claim.validTo ? ` · ${tr("validTo2")} ${claim.validTo}` : ""}</small>
                </article>)}
                {!contextClaims.some((claim) => (claim.subject.canonicalEntityId === selected.id || claim.target?.canonicalEntityId === selected.id) && !claim.archivedAt) && <p>{tr("noClaimsForThis")}</p>}
              </section>
            )}
            {selected.type === "area" && (
              <div className="projectDetail">
                <h3>{tr("Projects").toUpperCase()}</h3>
                {projects
                  .filter((p) =>
                    sources(selected.id, "belongs_to_area").includes(p.id),
                  )
                  .sort(byManualOrder(`project:area:${selected.id}`))
                  .map((p) => (
                    <article
                      key={p.id}
                      className={`${draggingId === p.id ? "isDragging" : ""} ${dragTarget === `entity:${p.id}` ? "dropActive" : ""}`.trim()}
                      data-drop-entity={p.id}
                      onDragOver={(event) => { event.preventDefault(); setActiveDragTarget(`entity:${p.id}`); }}
                      onDrop={(event) => acceptNativeDrop(event, `entity:${p.id}`)}
                      onClick={() => inspect(p)}
                    >
                      {dragHandle(p, `project:area:${selected.id}`)}
                      <div className="entityIcon projectIcon"><ProjectIcon /></div>
                      <div>
                        <strong>{p.title}</strong>
                        <small>{tr("project")}</small>
                      </div>
                    </article>
                  ))}
                <h3>{tr("task").toUpperCase()}</h3>
                {tasks
                  .filter(
                    (t) =>
                      t.status === "open" &&
                      sources(selected.id, "belongs_to_area").includes(t.id),
                  )
                  .sort(byManualOrder(`task:area:${selected.id}`))
                  .map((t) => (
                    <article
                      key={t.id}
                      className={`${draggingId === t.id ? "isDragging" : ""} ${dragTarget === `entity:${t.id}` ? "dropActive" : ""} ${taskDueTone(t, today)}`.trim()}
                      data-drop-entity={t.id}
                      onDragOver={(event) => { event.preventDefault(); setActiveDragTarget(`entity:${t.id}`); }}
                      onDrop={(event) => acceptNativeDrop(event, `entity:${t.id}`)}
                      onClick={() => inspect(t)}
                    >
                      {dragHandle(t, `task:area:${selected.id}`)}
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
                <div className="projectActions">
                  <button type="button" onClick={() => void setProjectStatus(selected, selected.status === "completed" ? "active" : "completed")}>{tr(selected.status === "completed" ? "reopen" : "complete")}</button>
                  <button type="button" className="danger" onClick={async () => {
                    const project = selected;
                    if (await askConfirm({ title: tr("projectDeleteTitle"), message: tr("projectDeleteConfirm").replace("{title}", () => project.title), confirmLabel: tr("delete"), danger: true })) void remove(project);
                  }}>{tr("delete")}</button>
                </div>
                <label>
                  {tr("deadline")}
                  <input type="date" value={String(selected.properties.deadline || "")}
                    onChange={(event) => void patch(selected, { deadline: event.target.value }, "deadline changed")} />
                </label>
                <label>
                  {tr("area")}
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
                    <option value="">{tr("none")}</option>
                    {areas.filter((area) => area.workspaceId === selected.workspaceId).map((a) => (
                      <option value={a.id} key={a.id}>
                        {a.title}
                      </option>
                    ))}
                  </select>
                </label>
                <h3>{tr("openTasks").toUpperCase()}</h3>
                {tasks
                  .filter(
                    (t) =>
                      t.status === "open" &&
                      sources(selected.id, "belongs_to_project").includes(t.id),
                  )
                  .sort(byManualOrder(`task:project:${selected.id}`))
                  .map((t) => (
                    <article
                      key={t.id}
                      className={`${draggingId === t.id ? "isDragging" : ""} ${dragTarget === `entity:${t.id}` ? "dropActive" : ""} ${taskDueTone(t, today)}`.trim()}
                      data-drop-entity={t.id}
                      onDragOver={(event) => { event.preventDefault(); setActiveDragTarget(`entity:${t.id}`); }}
                      onDrop={(event) => acceptNativeDrop(event, `entity:${t.id}`)}
                      onClick={() => inspect(t)}
                    >
                      {dragHandle(t, `task:project:${selected.id}`)}
                      <button className="check" onClick={(event) => { event.stopPropagation(); done(t.id); }}>
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
                  ＋ {tr("addTask")}
                </button>
                <h3>{tr("Notes").toUpperCase()}</h3>
                {scopedItems
                  .filter(
                    (n) =>
                      n.type === "note" &&
                      sources(selected.id, "belongs_to_project").includes(n.id),
                  )
                  .sort(byManualOrder(`note:project:${selected.id}`))
                  .map((n) => (
                    <article
                      key={n.id}
                      className={`${draggingId === n.id ? "isDragging" : ""} ${dragTarget === `entity:${n.id}` ? "dropActive" : ""}`.trim()}
                      data-drop-entity={n.id}
                      onDragOver={(event) => { event.preventDefault(); setActiveDragTarget(`entity:${n.id}`); }}
                      onDrop={(event) => acceptNativeDrop(event, `entity:${n.id}`)}
                      onClick={() => inspect(n)}
                    >
                      {dragHandle(n, `note:project:${selected.id}`)}
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
                  ＋ {tr("addNote")}
                </button>
              </div>
            )}
            {selected.type === "note" && (
              <div className="fields">
                <label>
                  {tr("project")}
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
                    <option value="">{tr("none")}</option>
                    {projects.filter((project) => project.workspaceId === selected.workspaceId && (project.status === "active" || targets(selected.id, "belongs_to_project").includes(project.id))).map((p) => (
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
                  {tr("list")}
                  <select
                    value={
                      selected.properties.inbox === true
                        ? "Inbox"
                        : selected.properties.someday === true
                          ? "Someday"
                        : selected.properties.today === true ||
                            (typeof selected.properties.when === "string" && selected.properties.when !== "" && selected.properties.when <= today)
                            ? "Today"
                            : "Anytime"
                    }
                    onChange={(event) => {
                      const destination = event.target.value;
                      patch(selected, {
                        inbox: destination === "Inbox",
                        someday: destination === "Someday",
                        today: destination === "Today",
                        when: destination === "Today" ? today : "",
                      }, `moved to ${destination}`);
                    }}
                  >
                    <option value="Inbox">{tr("Inbox")}</option>
                    <option value="Today">{tr("Today")}</option>
                    <option value="Anytime">{tr("Anytime")}</option>
                    <option value="Someday">{tr("Someday")}</option>
                  </select>
                </label>
                <div className="scheduleField">
                  <span>{tr("when")}</span>
                  <div className="scheduleChoices" role="group" aria-label={tr("when")}>
                    {(["today", "tomorrow", "someday", "clear"] as const).map((choice) => (
                      <button key={choice} type="button"
                        className={choice === "today" ? (selected.properties.when === today ? "active" : "")
                          : choice === "tomorrow" ? (selected.properties.when === ymd(addLocalDays(new Date(), 1)) ? "active" : "")
                            : choice === "someday" ? (selected.properties.someday === true ? "active" : "")
                              : (!selected.properties.when && selected.properties.someday !== true && selected.properties.inbox !== true ? "active" : "")}
                        onClick={() => void scheduleTask(selected, choice)}>{tr(`schedule${choice[0].toUpperCase()}${choice.slice(1)}`)}</button>
                    ))}
                  </div>
                  <input
                    type="date"
                    aria-label={tr("when")}
                    value={String(selected.properties.when || "")}
                    onChange={(e) => void scheduleTask(selected, e.target.value || "clear")}
                  />
                </div>
                <label>
                  {tr("deadline")}
                  <input
                    type="date"
                    value={String(selected.properties.deadline || "")}
                    onChange={(e) =>
                      patch(selected, { deadline: e.target.value })
                    }
                  />
                </label>
                <label>
                  {tr("project")}
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
                    <option value="">{tr("none")}</option>
                    {projects.filter((project) => project.workspaceId === selected.workspaceId && (project.status === "active" || targets(selected.id, "belongs_to_project").includes(project.id))).map((p) => (
                      <option value={p.id} key={p.id}>
                        {p.title}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  {tr("area")}
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
                    <option value="">{tr("none")}</option>
                    {areas.filter((area) => area.workspaceId === selected.workspaceId).map((a) => (
                      <option value={a.id} key={a.id}>
                        {a.title}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  {tr("priority")}
                  <select
                    value={String(selected.properties.priority || "none")}
                    onChange={(e) =>
                      patch(selected, { priority: e.target.value })
                    }
                  >
                    <option value="none">{tr("none")}</option>
                    <option value="low">{tr("low")}</option>
                    <option value="medium">{tr("medium")}</option>
                    <option value="high">{tr("high")}</option>
                  </select>
                </label>
                <label>
                  {tr("duration")}
                  <DurationInput
                    value={String(selected.properties.estimatedMinutes || "")}
                    onChange={(estimatedMinutes) => {
                      const plannedStart = String(selected.properties.plannedStart || "");
                      patch(selected, {
                        estimatedMinutes,
                        ...(plannedStart ? { plannedEnd: new Date(Date.parse(plannedStart) + estimatedMinutes * 60_000).toISOString() } : {}),
                      }, "duration changed");
                    }}
                  />
                </label>
                <label>
                  {tr("plannedTime")}
                  <input
                    type="datetime-local"
                    value={toLocalDateTime(selected.properties.plannedStart)}
                    onChange={(event) => {
                      const plannedStart = fromLocalDateTime(event.target.value);
                      const estimatedMinutes = Number(selected.properties.estimatedMinutes || 30);
                      const feedback = { date: calendarToday, decision: "adjusted", at: Date.now(), chosenStart: plannedStart,
                        plannedMinutes: plannedStart ? estimatedMinutes : undefined };
                      const history = Array.isArray(selected.properties.planningHistory) ? selected.properties.planningHistory : [];
                      patch(selected, {
                        plannedStart,
                        plannedEnd: plannedStart ? new Date(Date.parse(plannedStart) + estimatedMinutes * 60_000).toISOString() : "",
                        planningSource: plannedStart ? "manual" : "",
                        planningFeedback: feedback,
                        planningHistory: [...history, feedback].slice(-50),
                        ...(event.target.value ? { when: event.target.value.slice(0, 10), inbox: false, someday: false } : {}),
                      }, "planned time changed");
                    }}
                  />
                </label>
                <label>
                  {tr("reminder")}
                  <input
                    type="datetime-local"
                    value={toLocalDateTime(selected.properties.reminderAt)}
                    onChange={(e) =>
                      patch(selected, { reminderAt: fromLocalDateTime(e.target.value) }, "reminder changed")
                    }
                  />
                </label>
                {selected.properties.when && notificationState && (
                  <button
                    type="button"
                    onClick={() => {
                      const planned = new Date(`${String(selected.properties.when)}T12:00:00Z`);
                      const workdays = notificationState.preferences.workdays;
                      while (workdays.length && !workdays.includes(planned.getUTCDay())) {
                        planned.setUTCDate(planned.getUTCDate() + 1);
                      }
                      const date = planned.toISOString().slice(0, 10);
                      patch(selected, {
                        reminderAt: zonedDateTimeToIso(
                          date,
                          notificationState.preferences.workdayStart,
                          notificationState.preferences.timezone,
                        ),
                      }, "workday reminder set");
                    }}
                  >
                    {tr("nextWorkday")}
                  </button>
                )}
                <label>
                  {tr("taskNotes")}
                  <textarea
                    value={notesDraft?.id === selected.id ? notesDraft.text : String(selected.properties.notes || "")}
                    onChange={(e) => editNotes(selected.id, e.target.value, String(selected.properties.notes || ""))}
                    // Only notes typed here are saved: leaving the field unchanged must not write the
                    // value it showed back over a change made meanwhile in another tab or device.
                    onBlur={(e) => { if (notesDraft?.id === selected.id) void saveNotes(selected, e.target.value); }}
                    placeholder={tr("notesPlaceholder")}
                  />
                </label>
                <div className="checklistField">
                  <span>{tr("checklist")}</span>
                  {(Array.isArray(selected.properties.checklist)
                    ? selected.properties.checklist
                    : []
                  ).map((raw, index, all) => {
                    const item = typeof raw === "string"
                      ? { id: `${index}`, title: raw, done: false }
                      : raw as { id?: string; title?: string; done?: boolean };
                    return (
                      <label className="checklistItem" key={item.id || index}>
                        <input
                          type="checkbox"
                          checked={Boolean(item.done)}
                          onChange={() => patch(selected, (stored) => ({
                            // From the stored list: another tab or device may have changed it.
                            checklist: (Array.isArray(stored.checklist) ? stored.checklist : all).map((entry, entryIndex) => {
                              const normalized = typeof entry === "string"
                                ? { id: `${entryIndex}`, title: entry, done: false }
                                : entry as { id?: string; title?: string; done?: boolean };
                              const target = item.id ? normalized.id === item.id : entryIndex === index;
                              return target ? { ...normalized, done: !item.done } : normalized;
                            }),
                          }), "checklist updated")}
                        />
                        <span className={item.done ? "checked" : ""}>{item.title}</span>
                      </label>
                    );
                  })}
                  <div className="checklistAdd">
                    <input
                      value={checklistDraft}
                      onChange={(event) => setChecklistDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key !== "Enter" || !checklistDraft.trim()) return;
                        event.preventDefault();
                        const added = { id: crypto.randomUUID(), title: checklistDraft.trim(), done: false };
                        patch(selected, (stored) => ({
                          checklist: [...(Array.isArray(stored.checklist) ? stored.checklist : []), added],
                        }), "checklist item added");
                        setChecklistDraft("");
                      }}
                      placeholder={tr("addChecklistItem")}
                    />
                    <button
                      type="button"
                      disabled={!checklistDraft.trim()}
                      onClick={() => {
                        const added = { id: crypto.randomUUID(), title: checklistDraft.trim(), done: false };
                        patch(selected, (stored) => ({
                          checklist: [...(Array.isArray(stored.checklist) ? stored.checklist : []), added],
                        }), "checklist item added");
                        setChecklistDraft("");
                      }}
                    >{tr("add")}</button>
                  </div>
                </div>
                <label>
                  {tr("repeat")}
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
                    <option value="">{tr("never")}</option>
                    <option value="daily">{tr("daily")}</option>
                    <option value="weekly">{tr("weekly")}</option>
                    <option value="monthly">{tr("monthly")}</option>
                    <option value="yearly">{tr("yearly")}</option>
                  </select>
                </label>
                {(selected.properties.recurrence as any)?.frequency && (
                  <>
                    <label>
                      {tr("every")}
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
                      {tr("repeatFrom")}
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
                        <option value="scheduled">{tr("scheduledDate")}</option>
                        <option value="completion">{tr("completionDate")}</option>
                      </select>
                    </label>
                  </>
                )}
                {Array.isArray(selected.properties.activity) && selected.properties.activity.length > 0 && (
                  <div className="activityLog">
                    <h3>{tr("history").toUpperCase()}</h3>
                    {[...selected.properties.activity]
                      .reverse()
                      .slice(0, 12)
                      .map((entry: any, index) => (
                        <div key={`${entry.at}-${index}`}>
                          <span>{String(entry.action || "updated")}</span>
                          <time>{new Date(Number(entry.at)).toLocaleString()}</time>
                        </div>
                      ))}
                  </div>
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
                  {tr("moveSomeday")}
                </button>
                {selected.status === "completed" ? (
                  <button onClick={() => reopenTask(selected)}>{tr("reopen")}</button>
                ) : (
                  <>
                    {!workSession && <button className="primaryAction" disabled={workSessionBusy} onClick={() => workSessionAction("start", selected)}>{tr("workStart")}</button>}
                    <button onClick={() => done(selected.id)}>{workSession?.taskId === selected.id ? tr("workFinish") : tr("complete")}</button>
                  </>
                )}
                <button className="danger" onClick={() => remove(selected)}>
                  {tr("delete")}
                </button>
              </div>
            )}
          </aside>
        </div>
      )}
    </>
  );
}
