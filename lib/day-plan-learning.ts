import type { Entity } from "./db";

export interface LearnedPlanning {
  estimatedMinutes: number;
  estimateSource: "explicit" | "actual" | "learned" | "default";
  estimateSamples: number;
  preferredMinute: number | null;
  timeSamples: number;
}

type Feedback = { decision?: unknown; at?: unknown; plannedMinutes?: unknown; proposedStart?: unknown; chosenStart?: unknown };

function validMinutes(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 10 && number <= 480 ? Math.ceil(number / 5) * 5 : null;
}

function median(values: number[]) {
  const ordered = [...values].sort((a, b) => a - b);
  const upper = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[upper] : (ordered[upper - 1] + ordered[upper]) / 2;
}

function kind(task: Entity) {
  return task.title.toLocaleLowerCase("cs-CZ").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .match(/[a-z]{3,}/)?.[0] || "";
}

function comparable(task: Entity, sample: Entity) {
  if (task.id === sample.id || task.workspaceId !== sample.workspaceId || sample.type !== "task") return false;
  const project = String(task.properties.projectId || "");
  const sampleProject = String(sample.properties.projectId || "");
  return Boolean(kind(task) && kind(task) === kind(sample) && (!project || !sampleProject || project === sampleProject));
}

function minuteInZone(value: unknown, timezone: string) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return null;
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(value)).map((part) => [part.type, part.value]));
  return Number(parts.hour) * 60 + Number(parts.minute);
}

export function learnPlanning(task: Entity, peers: Entity[], timezone: string): LearnedPlanning {
  const explicit = validMinutes(task.properties.estimatedMinutes);
  const durationSamples: number[] = [];
  const actualSamples: number[] = [];
  const timeSamples: number[] = [];
  const seenFeedback = new Set<string>();
  for (const peer of peers) {
    if (!comparable(task, peer)) continue;
    const sessions = Array.isArray(peer.properties.workSessionHistory) ? peer.properties.workSessionHistory : [];
    for (const entry of sessions.slice(-30)) {
      const actual = entry && typeof entry === "object" ? validMinutes((entry as { actualMinutes?: unknown }).actualMinutes) : null;
      if (actual !== null) actualSamples.push(actual);
    }
    const history = Array.isArray(peer.properties.planningHistory) ? peer.properties.planningHistory : [];
    let peerMinutes: number | null = null;
    let peerTime: number | null = null;
    for (const entry of history.slice(-50)) {
      if (!entry || typeof entry !== "object") continue;
      const feedback = entry as Feedback;
      if (feedback.decision !== "accepted" && feedback.decision !== "adjusted") continue;
      const fingerprint = `${feedback.at}:${feedback.decision}:${feedback.chosenStart || feedback.proposedStart}`;
      if (feedback.at && seenFeedback.has(fingerprint)) continue;
      if (feedback.at) seenFeedback.add(fingerprint);
      // A planned block is a planning preference, never a measurement of actual work.
      const minutes = validMinutes(feedback.plannedMinutes);
      if (minutes !== null) peerMinutes = minutes;
      const at = minuteInZone(feedback.chosenStart || feedback.proposedStart, timezone);
      if (at !== null) peerTime = at;
    }
    if (peerMinutes !== null) durationSamples.push(peerMinutes);
    if (peerTime !== null) timeSamples.push(peerTime);
  }
  const actualEstimate = actualSamples.length >= 3 ? Math.round(Math.max(10, Math.min(480, median(actualSamples))) / 5) * 5 : null;
  const estimateSamples = actualEstimate !== null ? actualSamples.length : durationSamples.length;
  const learned = durationSamples.length >= 3 ? Math.round(Math.max(30, Math.min(120, median(durationSamples))) / 5) * 5 : 60;
  const estimatedMinutes = explicit ?? actualEstimate ?? learned;
  return {
    estimatedMinutes,
    estimateSource: explicit !== null ? "explicit" : actualEstimate !== null ? "actual" : durationSamples.length >= 3 ? "learned" : "default",
    estimateSamples,
    preferredMinute: timeSamples.length >= 3 ? Math.round(median(timeSamples) / 15) * 15 : null,
    timeSamples: timeSamples.length,
  };
}
