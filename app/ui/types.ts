import { type AttentionItem } from "../../lib/attention";
import { type AIMessage } from "../../lib/ai-provider";

export interface AttentionResponse {
  items: Array<AttentionItem & { sourceFingerprint: string; lifecycleState: "active" }>;
  hidden: { snoozed: number; dismissed: number };
  workspaceId: string;
  timezone: string;
  evaluatedAt: number;
  dataRevision: number;
  source: string;
  sourceUpdatedAt: number;
  coverage: { rules: string[]; excluded: string[]; projectActivity: string; deletedTaskHistory: boolean; externalActivity: boolean };
}
export interface BackupSummary {
  name: string;
  createdAt: number;
  entityCount: number;
  relationCount: number;
  error?: string;
}
export interface PasskeySummary {
  id: string;
  label: string;
  rpId: string;
  createdAt: number;
  lastUsedAt: number | null;
  backedUp: boolean;
}
export interface NotificationPreferences {
  enabled: boolean;
  attentionPush: boolean;
  timezone: string;
  workdayStart: string;
  workdayEnd: string;
  workdays: number[];
}
export interface DayPlanItem {
  taskId: string;
  title: string;
  estimatedMinutes: number;
  reason: "overdue" | "today" | "deadline" | "priority" | "context";
  start?: string;
  end?: string;
  estimateSource?: "explicit" | "actual" | "learned" | "default";
  estimateSamples?: number;
  preferredMinute?: number | null;
  timeSamples?: number;
  planningSource?: "albert-day-plan" | "manual" | "other";
  whyNow: string[];
}
export interface DayPlan {
  revision: number;
  workspaceId: string;
  date: string;
  timezone: string;
  calendar: "ready" | "missing" | "stale" | "non-workday";
  freeMinutes: number | null;
  requiredMinutes: number;
  overloaded: boolean;
  existingBlocks: DayPlanItem[];
  planBlocks: DayPlanItem[];
  unscheduled: DayPlanItem[];
}
export interface WorkSession {
  id: string; workspaceId: string; taskId: string; taskTitle: string;
  state: "running" | "paused" | "completed"; revision: number;
  accumulatedMs: number; runningSince: number | null; elapsedMs: number;
  startedAt: number; completedAt: number | null; estimatedMinutes: number | null; overrun: boolean;
}
export interface PACTAgentSummary {
  id: string;
  name: string;
  version: number;
  instructions: string;
  tools: string[];
  triggerModes: string[];
}
export interface PACTAgentRunSummary {
  id: string;
  agentId: string;
  workspaceId: string;
  triggerMode: string;
  status: "running" | "completed" | "failed";
  inputSummary: string;
  outputSummary: string | null;
  createdAt: number;
  completedAt: number | null;
}
export interface PACTAgentResult {
  agentId: string;
  title: string;
  summary: string;
  recommendations: string[];
  createdAt: number;
}
export interface CaptureSuggestion {
  projectId: string;
  projectTitle: string;
  areaId: string;
  areaTitle: string;
  priority: "none" | "low" | "medium" | "high";
  estimatedMinutes: number;
  scheduledStart: string;
  scheduledEnd: string;
  scheduledDate: string;
  scheduledOptions: Array<{ start: string; end: string; date: string }>;
  confidence: "low" | "medium" | "high";
  reasons: string[];
  constraints: string[];
  newProjectSuggestion: {
    title: string;
    areaId: string;
    areaTitle: string;
    confidence: "medium" | "high";
    reason: string;
  } | null;
}
export type CaptureProjectAction = "" | "existing" | "new" | "none";
export interface CalendarSourceState {
  id: string;
  workspaceId: string;
  label: string;
  status: string;
  configured: boolean;
  lastSyncAt: number | null;
  lastSuccessAt: number | null;
  lastError: string;
  eventCount: number;
  revision: number;
}
export interface CalendarEvent {
  id: string;
  sourceId: string;
  workspaceId: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  timezone: string;
  status: string;
  busy: boolean;
  private: boolean;
}
export interface DurableContextItem {
  id: string;
  workspaceId: string;
  scope: "me" | "work" | "family" | "rules" | "project" | "workspace";
  sensitivity: "normal" | "sensitive";
  provenance: "owner" | "imported" | "ai-suggested";
  status: "active" | "archived" | "pending";
  title: string;
  content: string;
  projectId?: string;
  createdAt: number;
  updatedAt: number;
}
export interface ContextClaimItem {
  id: string;
  workspaceId: string;
  subject: { id: string; type: string; canonicalEntityId: string | null; title: string; archivedAt?: number | null };
  predicate: string;
  literal: { type: "string" | "number" | "boolean" | "date"; value: string | number | boolean } | null;
  target: { id: string; type: string; canonicalEntityId: string | null; title: string; archivedAt?: number | null } | null;
  reviewStatus: "proposed" | "confirmed" | "rejected";
  freshness: "current" | "needs_review" | "stale";
  sensitivity: "normal" | "sensitive";
  provenance: "owner";
  validFrom: string | null;
  validTo: string | null;
  source: { provider?: string; locator?: string; author?: string; sourceAt?: string; coverage?: string } | null;
  evidence: { locator?: string; excerpt?: string; stance?: string } | null;
  revision: number;
  archivedAt: number | null;
  recordedAt: number;
  updatedAt: number;
  eligibleForAI?: boolean;
}
export interface ContextInboxProposal {
  id: string; kind: "claim";
  subject: { entityId: string; type: string; title: string };
  predicate: string;
  literal: { type: "string" | "number" | "boolean" | "date"; value: string | number | boolean };
  freshness: "current" | "needs_review" | "stale";
  sensitivity: "normal" | "sensitive";
  validFrom: string | null; validTo: string | null; evidenceExcerpt: string; reason: "waiting" | "importance" | "deadline" | "preference";
  suggestedTarget?: { type: "person" | "organization"; title: string; matches: Array<{ id: string; title: string }> };
  selectedTargetId?: string;
}
export interface StandaloneSubjectItem { id: string; workspaceId: string; type: "person" | "organization"; title: string; revision: number; archivedAt: number | null; }
export interface ContextInboxTaskDraft { id: string; title: string; subject: { entityId: string; type: string; title: string }; suggestedDate: string | null; suggestedPriority: "none" | "low" | "medium" | "high"; reason: "action_item"; }
export interface NotificationState {
  publicKey: string;
  subscriptionCount: number;
  preferences: NotificationPreferences;
}
export interface AIProposal {
  id: string;
  summary: string;
  changes: Array<{ label: string; value: string }>;
  expiresAt: number;
}
export interface AssistantMessage extends AIMessage {
  proposal?: AIProposal;
  actionId?: string;
  resolved?: boolean;
}
export type Language = "cs" | "en";
export type ThemeMode = "system" | "light" | "dark";
