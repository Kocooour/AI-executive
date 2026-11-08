/**
 * R2d.4k: the Attention evaluation time zone is the actor's SERVER-SIDE profile
 * zone (`personal_notification_settings.time_zone`), never client input. It is
 * read inside the same pinned snapshot / write transaction as the Attention
 * evaluation, validated by the canonical window function and fails closed
 * (null) when the settings row, epoch row or zone is missing or invalid.
 * Leaf module (no writer/reader imports) so reader, writer and bundle share it.
 */
import type {DatabaseSync} from "node:sqlite";
import {attentionEvaluationWindow} from "./target-attention-read-model";

export type TargetAttentionProfileZone={
  /** Validated IANA zone of the actor's profile. */
  timeZone:string;
  /** personal_notification_epochs.revision of the same snapshot (live-guard witness). */
  notificationEpoch:number;
};

export function readTargetAttentionProfileZone(
  db:DatabaseSync,actor:string,
):TargetAttentionProfileZone|null {
  try {
    const row=db.prepare(
      "SELECT time_zone AS zone FROM personal_notification_settings WHERE user_id=?"
    ).get(actor) as {zone:unknown}|undefined;
    const e=db.prepare("SELECT revision FROM personal_notification_epochs WHERE user_id=?")
      .get(actor) as {revision:unknown}|undefined;
    if(!row||!e||typeof row.zone!=="string"||
      typeof e.revision!=="number"||!Number.isSafeInteger(e.revision)||e.revision<0)
      return null;
    return attentionEvaluationWindow(0,row.zone)===null?null
      :{timeZone:row.zone,notificationEpoch:e.revision};
  }catch{return null;}
}
