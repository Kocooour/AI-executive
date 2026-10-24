import { buildContext } from "./context";
import { db, personalWorkspaceId, type Entity, type EntityType } from "./db";
import { areaKindOf, assignFallbackArea, taskIsInProject } from "./area-write-client";

export type ToolName =
  | "search_entities"
  | "get_entity"
  | "create_entity"
  | "update_entity"
  | "get_context";
export interface ToolCall {
  name: ToolName;
  arguments: Record<string, unknown>;
}
export interface ToolResult {
  ok: boolean;
  data?: unknown;
  error?: string;
}

const requestedWorkspace = (call: ToolCall) =>
  String(call.arguments.workspaceId || personalWorkspaceId);

export async function runTool(call: ToolCall): Promise<ToolResult> {
  try {
    const workspaceId = requestedWorkspace(call);
    switch (call.name) {
      case "search_entities": {
        const query = String(call.arguments.query || "").toLowerCase();
        const type = call.arguments.type as EntityType | undefined;
        const all = await db.entities.toArray();
        return {
          ok: true,
          data: all
            .filter(
              (entity) =>
                entity.type !== "workspace" &&
                (workspaceId === "all" || entity.workspaceId === workspaceId) &&
                (!type || entity.type === type) &&
                `${entity.title} ${entity.content || ""}`
                  .toLowerCase()
                  .includes(query),
            )
            .slice(0, 50),
        };
      }
      case "get_entity": {
        const entity = await db.entities.get(String(call.arguments.id));
        return {
          ok: true,
          data:
            entity &&
            entity.type !== "workspace" &&
            (workspaceId === "all" || entity.workspaceId === workspaceId)
              ? entity
              : null,
        };
      }
      case "create_entity": {
        if (workspaceId === "all") {
          return { ok: false, error: "A write workspace is required" };
        }
        const workspace = await db.entities.get(`workspace:${workspaceId}`);
        if (!workspace || workspace.type !== "workspace") {
          return { ok: false, error: "Workspace not found" };
        }
        const now = Date.now();
        const entity: Entity = {
          id: crypto.randomUUID(),
          type: call.arguments.type as EntityType,
          title: String(call.arguments.title || "Untitled"),
          content: String(call.arguments.content || ""),
          status: String(call.arguments.status || "active"),
          workspaceId,
          properties:
            (call.arguments.properties as Record<string, unknown>) || {},
          createdAt: now,
          updatedAt: now,
        };
        if (entity.type === "workspace") {
          return { ok: false, error: "Workspace creation is not an agent tool" };
        }
        // 2a part 4: an Area carries its workspace's kind; a project or standalone task gets the fallback Area.
        await db.transaction("rw", db.entities, db.relations, async () => {
          if (entity.type === "area") {
            const kind = await areaKindOf(entity.workspaceId);
            if (kind) entity.properties = { ...entity.properties, kind };
          }
          await db.entities.add(entity);
          if (entity.type === "project" || (entity.type === "task" && !(await taskIsInProject(entity)))) {
            await assignFallbackArea(entity, now);
          }
        });
        return { ok: true, data: entity };
      }
      case "update_entity": {
        const id = String(call.arguments.id);
        const existing = await db.entities.get(id);
        if (
          !existing ||
          existing.type === "workspace" ||
          existing.workspaceId !== workspaceId
        ) {
          return { ok: false, error: "Entity not found" };
        }
        const requestedPatch = {
          ...(call.arguments.patch as Partial<Entity>),
        };
        delete requestedPatch.workspaceId;
        delete requestedPatch.type;
        const patch = {
          ...requestedPatch,
          id: existing.id,
          updatedAt: Date.now(),
        };
        await db.entities.update(id, patch);
        return { ok: true, data: await db.entities.get(id) };
      }
      case "get_context": {
        const entity = await db.entities.get(String(call.arguments.id));
        if (
          !entity ||
          entity.type === "workspace" ||
          (workspaceId !== "all" && entity.workspaceId !== workspaceId)
        ) {
          return { ok: true, data: null };
        }
        return {
          ok: true,
          data: await buildContext(
            entity.id,
            Number(call.arguments.depth || 1),
          ),
        };
      }
      default:
        return { ok: false, error: "Unknown tool" };
    }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
