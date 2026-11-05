import assert from "node:assert/strict";
import test from "node:test";
import { proposalApprovalGate } from "../lib/ai-proposal-gate.ts";

const fresh = { workspaceId: "personal", expiresAt: 10_000 };

test("only a valid current-scope proposal may reach the approval action", () => {
  assert.equal(proposalApprovalGate(fresh, "personal", 9_999), null);
  assert.equal(proposalApprovalGate(fresh, "personal", 10_000), "expired");
  assert.equal(proposalApprovalGate(fresh, "personal", 10_001), "expired");
  assert.equal(proposalApprovalGate({ ...fresh, expiresAt: Number.NaN }, "personal", 9_000), "expired");
});

test("workspace drift and aggregate scope block old proposals", () => {
  assert.equal(proposalApprovalGate(fresh, "shared", 100), "workspace");
  assert.equal(proposalApprovalGate(fresh, "all", 100), "workspace");
  assert.equal(proposalApprovalGate({ ...fresh, workspaceId: "all" }, "all", 100), "workspace");
  assert.equal(proposalApprovalGate({ ...fresh, workspaceId: "" }, "personal", 100), "workspace");
});

test("a server conflict blocks the action regardless of its remaining lifetime", () => {
  assert.equal(proposalApprovalGate(fresh, "personal", 100, "Revision changed"), "conflict");
  assert.equal(proposalApprovalGate({ ...fresh, expiresAt: 1 }, "other", 10, "Cannot act"), "conflict");
});
