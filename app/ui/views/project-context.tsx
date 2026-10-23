"use client";

import { useEffect, useRef, useState } from "react";
import type { Entity } from "../../../lib/db";
import { contextLimits, contextPatch, contextProblem, ownerProjectContext, readProjectContext } from "../../../lib/project-context";
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
  const storedDraft: Draft = { why: stored.why, goals: stored.goals, doneWhen: stored.doneWhen };
  const storedKey = JSON.stringify(storedDraft);
  const readOnly = app.activeWorkspaceId === "all";
  const [draft, setDraft] = useState<Draft>(storedDraft);
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error" | "tooLong">("idle");
  const [problem, setProblem] = useState<{ field: string; limit: number } | null>(null);
  const container = useRef<HTMLDivElement>(null);
  const focused = useRef(false);
  const draftRef = useRef<Draft>(storedDraft);
  const savedRef = useRef<Draft>(storedDraft);
  const editVersion = useRef(0);
  const dirty = useRef(false);
  const pendingSaves = useRef(0);
  const saveTail = useRef<Promise<void>>(Promise.resolve());
  const focusGoal = useRef<number | null>(null);
  const goalInputs = useRef<Array<HTMLInputElement | null>>([]);

  // A change from elsewhere (sync, another device) replaces the fields only while they are not being edited.
  useEffect(() => {
    savedRef.current = JSON.parse(storedKey) as Draft;
    if (!focused.current && !dirty.current) {
      draftRef.current = JSON.parse(storedKey) as Draft;
      setDraft(draftRef.current);
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
    setState("idle");
  }

  async function save() {
    if (readOnly || !dirty.current) return;
    const version = editVersion.current;
    const snapshot = draftRef.current;
    if (sameText(snapshot, savedRef.current)) { dirty.current = false; return; }
    // Nothing is cut: a text over its limit (an old goal read as "Hotovo, když", too many goals) is not saved until it is shortened.
    const problem = contextProblem(snapshot);
    if (problem) { setProblem(problem); setState("tooLong"); return; }
    setProblem(null);
    pendingSaves.current += 1;
    setState("saving");
    // Saves of this field run one after another. A revision superseded while it waited is skipped; an in-flight save
    // finishes before a newer one starts.
    const run = saveTail.current.then(async () => {
      if (version !== editVersion.current) return;
      const next = ownerProjectContext(snapshot, Date.now());
      await app.patch(project, contextPatch(next), "project context changed", true);
      if (version === editVersion.current) {
        dirty.current = false;
        savedRef.current = normalized(snapshot);
        if (!focused.current) { draftRef.current = normalized(snapshot); setDraft(draftRef.current); }
      }
    });
    saveTail.current = run.then(() => undefined, () => undefined);
    try {
      await run;
      if (version === editVersion.current && pendingSaves.current === 1) setState("saved");
    } catch {
      // The unsent text stays dirty; leaving a field again retries it.
      if (version === editVersion.current) setState("error");
    } finally {
      pendingSaves.current -= 1;
      if (pendingSaves.current === 0) setState((current) => (current === "saving" ? "idle" : current));
    }
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
    </section>
  );
}
