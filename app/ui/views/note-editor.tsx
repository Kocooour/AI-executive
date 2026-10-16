"use client";
import { useEffect, useState } from "react";
import { lineDiff } from "../../../lib/line-diff";
import type { LumiApp } from "../use-lumi-app";
import { MarkdownText } from "./markdown-text";

// The body of a note (Markdown, edited as text and shown as a safe preview) and its version history,
// which the server keeps (lib/note-revisions.ts) and which is only available online.

interface RevisionSummary {
  revision: number;
  createdAt: number;
  origin: "baseline" | "created" | "edited" | "backup_restore";
  title: string;
  contentLength: number;
  sameAsRevision: number | null;
}
interface RevisionDetail extends RevisionSummary { content: string }
type History = { state: "loading" } | { state: "unavailable" } | { state: "ready"; revisions: RevisionSummary[] };

const originKey = { baseline: "revOriginBaseline", created: "revOriginCreated", edited: "revOriginEdited", backup_restore: "revOriginBackup" } as const;

export function NoteEditor({ app }: { app: LumiApp }) {
  const { selected, noteBodyDraft, noteBodyError, editNoteBody, saveNoteBody, restoreNoteVersion, unsent, syncStatus, language, tr } = app;
  const note = selected!;
  const id = note.id;
  const stored = note.content ?? "";
  const text = noteBodyDraft?.id === id ? noteBodyDraft.text : stored;
  const [mode, setMode] = useState<"edit" | "preview">("edit");
  const [history, setHistory] = useState<History>({ state: "loading" });
  const [chosen, setChosen] = useState<number | null>(null);
  const [detail, setDetail] = useState<RevisionDetail | "unavailable" | null>(null);
  const [restored, setRestored] = useState<number | null>(null);
  const [restoring, setRestoring] = useState(false);
  // Refreshed once the note's save is acknowledged: while the change waits to be sent the server has nothing new.
  const waiting = unsent.has(id);
  const updatedAt = note.updatedAt;

  useEffect(() => {
    if (waiting) return;
    let current = true;
    if (typeof navigator !== "undefined" && navigator.onLine === false) { setHistory({ state: "unavailable" }); return; }
    fetch(`/api/notes/revisions?noteId=${encodeURIComponent(id)}`, { cache: "no-store", signal: AbortSignal.timeout(15_000) })
      .then(async (response) => {
        if (!response.ok) throw new Error("unavailable");
        return (await response.json()) as { revisions: RevisionSummary[] };
      })
      .then((body) => { if (current) setHistory({ state: "ready", revisions: body.revisions }); })
      .catch(() => { if (current) { setHistory({ state: "unavailable" }); setChosen(null); setDetail(null); } });
    return () => { current = false; };
  }, [id, waiting, updatedAt]);

  useEffect(() => {
    if (chosen === null) { setDetail(null); return; }
    let current = true;
    setDetail(null);
    fetch(`/api/notes/revisions?noteId=${encodeURIComponent(id)}&revision=${chosen}`, { cache: "no-store", signal: AbortSignal.timeout(15_000) })
      .then(async (response) => {
        if (!response.ok) throw new Error("unavailable");
        return (await response.json()) as { revision: RevisionDetail };
      })
      .then((body) => { if (current) setDetail(body.revision); })
      .catch(() => { if (current) setDetail("unavailable"); });
    return () => { current = false; };
  }, [id, chosen]);

  const locale = language === "cs" ? "cs-CZ" : "en-GB";
  const status = noteBodyError === id ? "noteSaveFailed"
    : noteBodyDraft?.id === id ? "noteUnsaved"
      : waiting ? (syncStatus === "offline" ? "noteSavedOffline" : "noteSaving")
        : "noteSaved";
  const revisions = history.state === "ready" ? history.revisions : [];

  function change(index: number) {
    const older = revisions[index + 1];
    if (!older) return "";
    const delta = revisions[index].contentLength - older.contentLength;
    if (delta === 0) return tr("revNoCharChange");
    return tr(delta > 0 ? "revCharsAdded" : "revCharsRemoved").replace("{count}", String(Math.abs(delta)));
  }

  async function restore() {
    if (!detail || detail === "unavailable") return;
    setRestoring(true);
    const number = detail.revision;
    const ok = await restoreNoteVersion(note, detail.title, detail.content);
    setRestoring(false);
    if (ok) { setRestored(number); setChosen(null); }
  }

  return (
    <section className="noteEditor">
      <div className="noteEditorHead">
        <span id={`noteText-${id}`}>{tr("noteText")}</span>
        <div className="noteModeToggle" role="group">
          <button type="button" aria-pressed={mode === "edit"} onClick={() => setMode("edit")}>{tr("noteEdit")}</button>
          <button type="button" aria-pressed={mode === "preview"} onClick={() => setMode("preview")}>{tr("notePreview")}</button>
        </div>
      </div>
      {mode === "edit" ? (
        <textarea
          className="noteBody"
          aria-labelledby={`noteText-${id}`}
          data-user-content
          maxLength={100000}
          value={text}
          onChange={(e) => editNoteBody(id, e.target.value, stored)}
          // Only text typed here is saved: leaving the field unchanged writes nothing.
          onBlur={(e) => { if (noteBodyDraft?.id === id) void saveNoteBody(note, e.target.value); }}
          placeholder={tr("noteTextPlaceholder")}
        />
      ) : text.trim() ? <MarkdownText text={text} /> : <p className="noteEmpty">{tr("noteEmptyPreview")}</p>}
      <p className="noteStatus" role="status" aria-live="polite" data-state={status}>{tr(status)}</p>

      <div className="noteHistory">
        <h3>{tr("versionHistory")}</h3>
        {restored !== null && <p className="noteStatus" role="status">{tr("revRestoredStatus").replace("{version}", String(restored))}</p>}
        {history.state === "loading" && <p className="noteEmpty">{tr("revLoading")}</p>}
        {history.state === "unavailable" && <p className="noteEmpty" role="status">{tr("revOnlineOnly")}</p>}
        {history.state === "ready" && revisions.length === 0 && <p className="noteEmpty">{tr("revNone")}</p>}
        {history.state === "ready" && revisions.length > 0 && (
          <ul className="revisionList">
            {revisions.map((item, index) => (
              <li key={item.revision}>
                <button type="button" aria-pressed={chosen === item.revision} onClick={() => setChosen(chosen === item.revision ? null : item.revision)}>
                  <strong>{tr("revVersion").replace("{n}", String(item.revision))}</strong>
                  <span>{new Date(item.createdAt).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" })}</span>
                  <span>{tr(originKey[item.origin])}{change(index) ? ` · ${change(index)}` : ""}</span>
                  {item.sameAsRevision !== null && <span>{tr("revSameAs").replace("{n}", String(item.sameAsRevision))}</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
        {chosen !== null && detail === null && <p className="noteEmpty">{tr("revLoading")}</p>}
        {chosen !== null && detail === "unavailable" && <p className="noteEmpty" role="status">{tr("revOnlineOnly")}</p>}
        {chosen !== null && detail && detail !== "unavailable" && (
          <div className="revisionDetail">
            <h4 data-user-content>{tr("revVersion").replace("{n}", String(detail.revision))} · {detail.title}</h4>
            <MarkdownText text={detail.content} />
            <h4>{tr("revChanges")}</h4>
            <pre className="revisionDiff" data-user-content aria-label={tr("revChanges")}>
              {lineDiff(detail.content, text).map((line, index) => (
                <span key={index} className={`diff-${line.kind}`}>
                  {line.kind === "added" ? "+ " : line.kind === "removed" ? "- " : "  "}{line.text}{"\n"}
                </span>
              ))}
            </pre>
            <button type="button" className="revisionRestore" disabled={restoring} onClick={() => void restore()}>{tr("revRestore")}</button>
          </div>
        )}
      </div>
    </section>
  );
}
