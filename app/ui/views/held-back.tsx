"use client";
import type { Entity } from "../../../lib/db";
import type { LumiApp } from "../use-lumi-app";

// Why the server would refuse a record (lib/sendable.ts), in words the user can act on.
export function heldBackReason(entity: Entity, tr: (key: string) => string) {
  if (typeof entity.title !== "string" || entity.title.length === 0) return tr("heldBackNoTitle");
  if (entity.title.length > 1000) return tr("heldBackLongTitle");
  if (typeof entity.content === "string" && entity.content.length > 100_000) return tr("heldBackLongContent");
  return tr("heldBackTooLarge");
}

// Records held back on this device because the server would refuse them; everything else is
// still sent. Each can be opened to fix it, or deleted.
export function HeldBack({ app }: { app: LumiApp }) {
  const { heldBack, inspect, remove, tr } = app;
  if (!heldBack.length) return null;
  return (
    <section className="heldBack" role="alert" aria-label={tr("heldBackTitle")}>
      <h2>{tr("heldBackTitle")}</h2>
      <p>{tr("heldBackExplanation")}</p>
      {heldBack.map((entity) => (
        <div className="heldBackItem" key={entity.id}>
          <span>
            <b>{entity.title || tr("untitledItem")}</b>
            <small>{heldBackReason(entity, tr)}</small>
          </span>
          <div className="notificationActions">
            <button onClick={() => inspect(entity)}>{tr("heldBackFix")}</button>
            <button onClick={() => remove(entity)}>{tr("delete")}</button>
          </div>
        </div>
      ))}
    </section>
  );
}
