// Pure, browser-safe label / ID rules shared by the 2a planner (lib/area-normalization.ts), the write
// invariants (lib/area-write-invariants.ts) and the client. Do not import node-only modules here.
import { sha256Hex } from "./sha256";

export type WorkspaceKind = "personal" | "shared";

export const displayLabel = (label: string) => label.trim().normalize("NFC").replace(/\s+/g, " ");
export const normalizedLabel = (label: string) => displayLabel(label).toLocaleLowerCase("cs");
const digest = (...parts: string[]) => sha256Hex(JSON.stringify(parts)).slice(0, 32);
export const generatedAreaId = (workspaceId: string, label: string) =>
  "area:2a:" + digest(workspaceId, normalizedLabel(label));
export const generatedRelationId = (entityId: string, areaId: string) =>
  "relation:2a:" + digest(entityId, areaId);
// Same namespace as the planner's legacy project links, kept for the planner's use.
export const generatedProjectRelationId = (entityId: string, projectId: string) =>
  "relation:2a:" + digest("project", entityId, projectId);
// A relation ID for a write after the planner's deterministic one was used and deleted (its ID is tombstoned for
// good); `attempt` 1, 2, ... derives the next deterministic candidate.
export const writeRelationId = (entityId: string, areaId: string, attempt: number) =>
  attempt <= 0 ? generatedRelationId(entityId, areaId) : "relation:2w:" + digest(entityId, areaId, String(attempt));

export const fallbackAreaTitle = (kind: WorkspaceKind) =>
  kind === "shared" ? "Nezařazeno (původní sdílené)" : "Nezařazeno";
export const areaKindForWorkspace = (kind: WorkspaceKind): "private" | "shared" =>
  kind === "personal" ? "private" : "shared";
