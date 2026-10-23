"use client";

import { useEffect, useRef, useState } from "react";
import type { Entity } from "../../../lib/db";
import { contextLimits, contextPatchIfUnchanged, contextProblem, ownerProjectContext, readProjectContext, sameStoredContext, type ProjectContext } from "../../../lib/project-context";
import { db } from "../../../lib/db";
import { labelsFor } from "../project-labels";
import type { LumiApp } from "../use-lumi-app";

// A textarea that grows with its text, so a long text is fully visible.
function GrowingTextarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${element.scrollHeight + 2}px`;
  }, [props.value]);
  return <textarea ref={ref} {...props} />;
}

type Draft = { why: string; goals: string[]; doneWhen: string };
const contextDraft = (context: Pick<ProjectContext, "why" | "goals" | "doneWhen">): Draft =>
  ({ why: context.why, goals: [...context.goals], doneWhen: context.doneWhen });

const sameText = (a: Draft, b: Draft) => JSON.stringify(normalized(a)) === JSON.stringify(normalized(b));
const normalized = (draft: Draft) => ({
  why: draft.why.trim(),
  goals: draft.goals.map((goal) => goal.trim()).filter(Boolean),
  doneWhen: draft.doneWhen.trim(),
});

// The context of a project, edited in place (B1, proposal §4.1-4.2). Saved when a field is left, with a visible state. The
// whole context travels as one object (sync merges it whole, lib/project-context.ts). Same race handling as the former
// goal field: a slow save of an older text must not reset a newer text still being typed, and saves run one after another.
export function ProjectContext({ app, project }: { app: LumiApp; project: Entity }) {
  const t = labelsFor(app.language);
  const stored = readProjectContext(project.properties);
  const storedDraft = contextDraft(stored);
  const storedKey = JSON.stringify(stored);
  const readOnly = app.activeWorkspaceId === "all";
  const [draft, setDraft] = useState<Draft>(storedDraft);
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error" | "tooLong" | "conflict">("idle");
  const [conflict, setConflict] = useState<Draft | null>(null);
  const [problem, setProblem] = useState<{ field: string; limit: number } | null>(null);
  const container = useRef<HTMLDivElement>(null);
  const focused = useRef(false);
  const draftRef = useRef<Draft>(storedDraft);
  const savedRef = useRef<Draft>(storedDraft);
  // The full origin (including provenance and revision) must not move while there are unsaved edits.
  const baseRef = useRef<ProjectContext>(stored);
  // The context this editor wrote last: when it comes back through sync it is our own save, not a remote change.
  const ownWrite = useRef<ProjectContext | null>(null);
  const editVersion = useRef(0);
  const dirty = useRef(false);
  const pendingSaves = useRef(0);
  const saveTail = useRef<Promise<void>>(Promise.resolve());
  const focusGoal = useRef<number | null>(null);
  const goalInputs = useRef<Array<HTMLInputElement | null>>([]);

  // A remote change must never silently replace the baseline of a locally edited draft.
  useEffect(() => {
    const incoming = JSON.parse(storedKey) as ProjectContext;
    if (ownWrite.current && sameStoredContext(incoming, ownWrite.current)) {
      baseRef.current = incoming;
      return;
    }
    if (!focused.current && !dirty.current) {
      baseRef.current = incoming;
      savedRef.current = contextDraft(incoming);
      draftRef.current = contextDraft(incoming);
      setDraft(draftRef.current);
      setConflict(null);
    } else if (!contextPatchIfUnchanged({ context: incoming }, baseRef.current, incoming)) {
      setConflict(contextDraft(incoming));
      setState("conflict");
    }
  }, [storedKey]);
  useEffect(() => {
    if (focusGoal.current !== null) {
      goalInputs.current[focusGoal.current]?.focus();
      focusGoal.current = null;
    }
  }, [draft.goals.length]);

  function edit(next: Draft) {
    draftRef.current = next;
    editVersion.current += 1;
    dirty.current = true;
    setDraft(next);
    if (!conflict) setState("idle");
  }

  async function save(confirmedOverwrite = false) {
    if (readOnly || !dirty.current) return;
    if (conflict && !confirmedOverwrite) { setState("conflict"); return; }
    const version = editVersion.current;
    const snapshot = draftRef.current;
    const base = baseRef.current;
    if (sameText(snapshot, savedRef.current)) { dirty.current = false; return; }
    // Nothing is cut: a text over its limit (an old goal read as "Hotovo, když", too many goals) is not saved until it is shortened.
    const problem = contextProblem(snapshot);
    if (problem) { setProblem(problem); setState("tooLong"); return; }
    setProblem(null);
    pendingSaves.current += 1;
    setState("saving");
    // Saves of this field run one after another. A revision superseded while it waited is skipped; an in-flight save
    // finishes before a newer one starts.
    let stale = false;
    const run = saveTail.current.then(async () => {
      if (version !== editVersion.current) return;
      const next = ownerProjectContext(snapshot, Date.now());
      await app.patch(project, (currentProperties) => {
        // app.patch evaluates this while holding the IndexedDB write transaction.
        // Compare against the ORIGINAL edit base, not a remote update received while typing.
        // Our own earlier save (a field saved a moment ago) is not a change from elsewhere.
        const own = ownWrite.current && sameStoredContext(readProjectContext(currentProperties), ownWrite.current) ? ownWrite.current : null;
        const patch = contextPatchIfUnchanged(currentProperties, own ?? base, next);
        if (!patch) { stale = true; throw new Error("Project context was updated during editing"); }
        ownWrite.current = next;
        return patch;
      }, "project context changed", true);
      if (version === editVersion.current) {
        dirty.current = false;
        baseRef.current = next;
        savedRef.current = normalized(snapshot);
        setConflict(null);
        if (!focused.current) { draftRef.current = normalized(snapshot); setDraft(draftRef.current); }
      }
    });
    saveTail.current = run.then(() => undefined, () => undefined);
    try {
      await run;
      if (version === editVersion.current && pendingSaves.current === 1) setState("saved");
    } catch {
      if (version === editVersion.current) {
        if (stale) {
          // Preserve the unsent draft and present the newest copy side-by-side.
          const latest = await db.entities.get(project.id).catch(() => undefined);
          setConflict(contextDraft(readProjectContext(latest?.properties)));
          setState("conflict");
        } else setState("error");
      }
    } finally {
      pendingSaves.current -= 1;
      if (pendingSaves.current === 0) setState((current) => (current === "saving" ? "idle" : current));
    }
  }

  async function resolveConflict(keepMine: boolean) {
    const latest = await db.entities.get(project.id).catch(() => undefined);
    if (!latest) { setState("error"); return; }
    const remote = readProjectContext(latest.properties);
    baseRef.current = remote;
    savedRef.current = contextDraft(remote);
    setConflict(null);
    if (!keepMine) {
      dirty.current = false;
      draftRef.current = contextDraft(remote);
      setDraft(draftRef.current);
      setState("idle");
      return;
    }
    // Explicit owner choice. If another sync arrives meanwhile, the transactional guard reopens the conflict.
    dirty.current = true;
    await save(true);
  }

  const empty = !draft.why.trim() && !draft.doneWhen.trim() && !draft.goals.some((goal) => goal.trim());
  const approvedDate = stored.provenance === "lumi-approved" && stored.updatedAt > 0
    ? new Intl.DateTimeFormat(app.language === "cs" ? "cs-CZ" : "en-GB", { day: "numeric", month: "numeric" }).format(new Date(stored.updatedAt))
    : "";

  return (
    <section className="projectContext" aria-label={t.contextTitle} data-context-empty={empty ? "true" : "false"}>
      <div
        ref={container}
        className="projectContextFields"
        onFocus={() => { focused.current = true; }}
        onBlur={(event) => {
          // Every field is saved when it is left (an unchanged context writes nothing); moving between the fields
          // of the context does not count as leaving it, so a save does not reset a field that is about to be typed in.
          if (!container.current?.contains(event.relatedTarget as Node | null)) focused.current = false;
          void save();
        }}
      >
        <label className="projectContextField">
          <span>{t.why}</span>
          <GrowingTextarea
            aria-label={t.why}
            readOnly={readOnly}
            value={draft.why}
            placeholder={t.whyHint}
            rows={2}
            maxLength={contextLimits.why}
            onChange={(event) => edit({ ...draft, why: event.target.value })}
          />
        </label>
        <div className="projectContextField" role="group" aria-label={t.goals}>
          <span>{t.goals}</span>
          {draft.goals.map((goal, index) => (
            <div className="projectGoalRow" key={index}>
              <span aria-hidden="true">•</span>
              <input
                ref={(element) => { goalInputs.current[index] = element; }}
                aria-label={`${t.goals} ${index + 1}`}
                readOnly={readOnly}
                value={goal}
                placeholder={t.goalPlaceholder}
                maxLength={contextLimits.goal}
                onChange={(event) => edit({ ...draft, goals: draft.goals.map((item, at) => at === index ? event.target.value : item) })}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" || readOnly) return;
                  event.preventDefault();
                  if (goal.trim() && draft.goals.length < contextLimits.goals) {
                    focusGoal.current = index + 1;
                    edit({ ...draft, goals: [...draft.goals.slice(0, index + 1), "", ...draft.goals.slice(index + 1)] });
                  }
                }}
              />
              {!readOnly && (
                <button type="button" className="projectGoalRemove" aria-label={t.removeGoal(index + 1)}
                  onClick={() => { edit({ ...draft, goals: draft.goals.filter((_, at) => at !== index) }); void save(); }}>×</button>
              )}
            </div>
          ))}
          {!readOnly && draft.goals.length < contextLimits.goals && (
            <button type="button" className="projectGoalAdd"
              onClick={() => { focusGoal.current = draft.goals.length; focused.current = true; edit({ ...draft, goals: [...draft.goals, ""] }); }}>
              ＋ {t.addGoal}
            </button>
          )}
        </div>
        <label className="projectContextField">
          <span>{t.doneWhen}</span>
          <GrowingTextarea
            aria-label={t.doneWhen}
            readOnly={readOnly}
            value={draft.doneWhen}
            placeholder={t.doneWhenHint}
            rows={2}
            maxLength={contextLimits.doneWhen}
            onChange={(event) => edit({ ...draft, doneWhen: event.target.value })}
          />
        </label>
      </div>
      <div className="projectContextFoot">
        <small className="projectContextHint">{readOnly ? t.readOnly : t.help}</small>
        {approvedDate && <small className="projectContextProvenance">{t.approved(approvedDate)}</small>}
        {state === "saving" && <small role="status" className="projectContextState">{t.saving}</small>}
        {state === "saved" && <small role="status" className="projectContextState saved">{t.saved}</small>}
        {state === "tooLong" && <small role="alert" className="projectContextState error">{problem?.field === "goals" ? t.tooMany(problem.limit) : t.tooLong(problem?.limit ?? contextLimits.doneWhen)}</small>}
        {state === "error" && <small role="alert" className="projectContextState error">{t.saveError}</small>}
      </div>
      {conflict && <div className="projectContextConflict" role="alert" aria-label={t.contextConflict}>
        <p>{t.contextConflict}</p>
        <strong>{t.contextRemote}</strong>
        <dl>
          <dt>{t.why}</dt><dd>{conflict.why || "—"}</dd>
          <dt>{t.goals}</dt><dd>{conflict.goals.join("; ") || "—"}</dd>
          <dt>{t.doneWhen}</dt><dd>{conflict.doneWhen || "—"}</dd>
        </dl>
        <div className="projectContextConflictActions">
          <button type="button" onClick={() => { void resolveConflict(false); }}>{t.contextLoadRemote}</button>
          <button type="button" onClick={() => { void resolveConflict(true); }}>{t.contextKeepMine}</button>
        </div>
      </div>}
    </section>
  );
}
