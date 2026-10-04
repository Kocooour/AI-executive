import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-static";

export async function GET(request: Request) {
  const origin = new URL(request.url).origin;
  return NextResponse.json({
    openapi: "3.1.0",
    info: {
      title: "Lumi Integration API",
      version: "0.1.0",
      description: "Workspace-scoped Lumi API. Planning may prepare proposals; external confirmation is not exposed.",
    },
    servers: [{ url: origin }],
    components: {
      securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
    },
    security: [{ bearerAuth: [] }],
    paths: {
      "/api/integrations/aifred": {
        post: {
          operationId: "planWithAifred",
          summary: "Ask Lumi to reason or prepare an approval-bound proposal",
          requestBody: {
            required: true,
            content: { "application/json": { schema: {
              type: "object", required: ["workspaceId", "message"], additionalProperties: false,
              properties: {
                workspaceId: { type: "string", minLength: 1, maxLength: 120 },
                message: { type: "string", minLength: 1, maxLength: 20000 },
                focusEntityId: { type: "string", maxLength: 240 },
              },
            } } },
          },
          responses: { "200": { description: "Answer and optional proposal" }, "401": { description: "Authentication required" } },
        },
      },
      "/api/integrations/aifred/tools": {
        post: {
          operationId: "readAifredTool",
          summary: "Run an allowlisted read-only Lumi tool",
          requestBody: {
            required: true,
            content: { "application/json": { schema: {
              type: "object", required: ["workspaceId", "tool"], additionalProperties: false,
              properties: {
                workspaceId: { type: "string", minLength: 1, maxLength: 120 },
                tool: { type: "string", enum: ["task.read", "project.read", "note.read", "calendar.read", "calendar.free_time", "context.read"] },
                input: { type: "object", additionalProperties: true },
              },
            } } },
          },
          responses: { "200": { description: "Read-only result" }, "401": { description: "Authentication required" } },
        },
      },
    },
  });
}
