import type { Entity } from "./db";

export function normalizeProjectTitle(value: string) {
  return value.toLocaleLowerCase("cs-CZ")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function findActiveProjectWithTitle(
  entities: Entity[],
  workspaceId: string,
  title: string,
) {
  const normalized = normalizeProjectTitle(title);
  if (!normalized) return null;
  return entities.find((entity) =>
    entity.type === "project" &&
    entity.status === "active" &&
    entity.workspaceId === workspaceId &&
    normalizeProjectTitle(entity.title) === normalized
  ) || null;
}
