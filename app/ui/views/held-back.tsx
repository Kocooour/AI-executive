"use client";
import type { Entity } from "../../../lib/db";
import { entityConflicts } from "../../../lib/field-merge";
import type { HeldBackReason } from "../../../lib/sendable";
import type { LumiApp } from "../use-lumi-app";

const reasonKeys: Record<HeldBackReason, string> = {
  noTitle: "heldBackNoTitle",
  longTitle: "heldBackLongTitle",
  longContent: "heldBackLongContent",
  longNotes: "heldBackLongNotes",
  tooLarge: "heldBackTooLarge",
  invalid: "heldBackInvalid",
  workspace: "heldBackWorkspace",
};

// Why the server would refuse a record (lib/sendable.ts), in words the user can act on.
export function heldBackReason(app: Pick<LumiApp, "heldReasons" | "tr">, entity: Entity) {
  return app.tr(reasonKeys[app.heldReasons.get(entity.id) || "invalid"]);
}

// The state of a record next to its title: not on the server yet, held back, or changed on
// another device at the same time.
export function RecordMarks({ app, entity }: { app: LumiApp; entity: Entity }) {
  const { heldReasons, unsent, tr } = app;
  return (
    <>
      {entityConflicts(entity).length > 0 && <span className="conflictMark" role="img" aria-label={tr("conflictBadge")} title={tr("conflictBadge")}> ⇄</span>}
      {heldReasons.has(entity.id)
        ? <span className="heldBackMark" role="img" aria-label={tr("heldBackBadge")} title={tr("heldBackBadge")}> ⚠</span>
        : unsent.has(entity.id) && <span className="unsentMark" role="img" aria-label={tr("unsentBadge")} title={tr("unsentBadge")}> ↑</span>}
    </>
  );
}

// Reasons the app has an editor for (title, notes); the others can only be deleted here.
const fixable = new Set<HeldBackReason>(["noTitle", "longTitle", "longNotes"]);

// Records held back on this device because the server would refuse them; everything else is
// still sent. Each can be opened to fix it, or deleted. Only those of the open workspace are
// listed (as everywhere else); of the others only their number is shown.
export function HeldBack({ app }: { app: LumiApp }) {
  const { heldBack: all, activeWorkspaceId, inspect, remove, tr } = app;
  const heldBack = all.filter((entity) => activeWorkspaceId === "all" || entity.workspaceId === activeWorkspaceId);
  const elsewhere = all.length - heldBack.length;
  if (!all.length) return null;
  // Nothing of the open workspace: only a short note that other workspaces have some.
  if (!heldBack.length) return <p className="heldBackElsewhere heldBackNote" role="status">{tr("heldBackElsewhere").replace("{count}", String(elsewhere))}</p>;
  return (
    <section className="heldBack" aria-label={tr("heldBackTitle")}>
      <h2>{tr("heldBackTitle")}</h2>
      <p>{tr("heldBackExplanation")}</p>
      {elsewhere > 0 && <p className="heldBackElsewhere">{tr("heldBackElsewhere").replace("{count}", String(elsewhere))}</p>}
      {heldBack.map((entity) => (
        <div className="heldBackItem" key={entity.id}>
          <span>
            <b>{entity.title || tr("untitledItem")}</b>
            <small>{heldBackReason(app, entity)}</small>
          </span>
          <div className="notificationActions">
            {/* A workspace is not deleted from here: that would leave its records behind without it
                (and drop them from the server). Its name is fixed in Settings. */}
            {entity.type === "workspace"
              ? <small className="heldBackNoFix">{tr(app.heldReasons.get(entity.id) === "longTitle" ? "heldBackWorkspaceFix" : "heldBackWorkspaceNoFix")}</small>
              : <>
                {fixable.has(app.heldReasons.get(entity.id) || "invalid")
                  ? <button onClick={() => inspect(entity)}>{tr("heldBackFix")}</button>
                  : <small className="heldBackNoFix">{tr("heldBackOnlyDelete")}</small>}
                <button onClick={() => remove(entity)}>{tr("delete")}</button>
              </>}
          </div>
        </div>
      ))}
    </section>
  );
}
