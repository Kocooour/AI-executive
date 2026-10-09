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

// Records held back on this device because the server would refuse them; everything else is
// still sent. Each can be opened to fix it, or deleted.
export function HeldBack({ app }: { app: LumiApp }) {
  const { heldBack, inspect, remove, tr } = app;
  if (!heldBack.length) return null;
  return (
    <section className="heldBack" aria-label={tr("heldBackTitle")}>
      <h2>{tr("heldBackTitle")}</h2>
      <p>{tr("heldBackExplanation")}</p>
      {heldBack.map((entity) => (
        <div className="heldBackItem" key={entity.id}>
          <span>
            <b>{entity.title || tr("untitledItem")}</b>
            <small>{heldBackReason(app, entity)}</small>
          </span>
          <div className="notificationActions">
            {/* Data that is not valid cannot be fixed in the app, only deleted. */}
            {!["invalid", "workspace"].includes(app.heldReasons.get(entity.id) || "") && <button onClick={() => inspect(entity)}>{tr("heldBackFix")}</button>}
            <button onClick={() => remove(entity)}>{tr("delete")}</button>
          </div>
        </div>
      ))}
    </section>
  );
}
