// Presentation gate for Lumi-generated write proposals. This is never an
// authorization check: /api/ai/actions rechecks the stored proposal and ACL.
export type ProposalApprovalBlock = "conflict" | "expired" | "workspace" | null;

export function proposalApprovalGate(
  proposal: { workspaceId: string; expiresAt: number },
  writeWorkspaceId: string,
  now: number,
  blocked?: string,
): ProposalApprovalBlock {
  if (blocked) return "conflict";
  if (!Number.isFinite(proposal.expiresAt) || now >= proposal.expiresAt) return "expired";
  if (!proposal.workspaceId || proposal.workspaceId === "all" || !writeWorkspaceId ||
    writeWorkspaceId === "all" || proposal.workspaceId !== writeWorkspaceId) return "workspace";
  return null;
}
