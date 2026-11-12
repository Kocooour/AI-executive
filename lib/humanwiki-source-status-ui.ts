/**
 * H1-real.9: untrusted network JSON -> minimal, owner-only UI projection.
 * Client validation is defense in depth, not an authority. Never persist it.
 */
export type HumanWikiSourceType = "chatgpt_user_export" | "claude_user_export";
export type HumanWikiSourceIntent = "withdrawal_requested" | "grant_requested" | null;
export type HumanWikiSourceStatus = Readonly<{
  witnessState: "signed_witness_prefix_covers_owner_intents" |
    "signed_witness_prefix_lags_owner_intents";
  sources: Readonly<Record<HumanWikiSourceType, Readonly<{
    revision: number; latestIntent: HumanWikiSourceIntent;
  }>>>;
}>;

const exactly = (value: unknown, expected: readonly string[]): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype &&
  Object.keys(value).sort().join(",") === [...expected].sort().join(",");

const sourceTypeKeys = ["chatgpt_user_export", "claude_user_export"] as const;
const rootFields = [
  "result", "witnessState", "sources", "importAuthorized", "consentVerified",
  "independentWitnessVerified", "withdrawalComplete", "realImportEnabled", "claimsCreated",
] as const;
const sourceFields = ["revision", "latestIntent"] as const;

function parseSource(value: unknown) {
  if (!exactly(value, sourceFields) ||
      !Number.isSafeInteger(value.revision) || (value.revision as number) < 0 ||
      !["withdrawal_requested", "grant_requested", null].includes(
        value.latestIntent as string | null,
      ) ||
      ((value.revision as number) === 0) !== (value.latestIntent === null)) {
    return null;
  }
  return {
    revision: value.revision as number,
    latestIntent: value.latestIntent as HumanWikiSourceIntent,
  };
}

export function parseHumanWikiSourceStatus(value: unknown): HumanWikiSourceStatus | null {
  if (!exactly(value, rootFields) ||
      value.result !== "source_intent_and_witness_observation_not_authorization" ||
      !["signed_witness_prefix_covers_owner_intents",
        "signed_witness_prefix_lags_owner_intents"].includes(value.witnessState as string) ||
      value.importAuthorized !== false || value.consentVerified !== false ||
      value.independentWitnessVerified !== false || value.withdrawalComplete !== false ||
      value.realImportEnabled !== false || value.claimsCreated !== 0 ||
      !exactly(value.sources, sourceTypeKeys)) return null;
  const chatgpt = parseSource(value.sources.chatgpt_user_export);
  const claude = parseSource(value.sources.claude_user_export);
  if (!chatgpt || !claude) return null;
  return {
    witnessState: value.witnessState as HumanWikiSourceStatus["witnessState"],
    sources: { chatgpt_user_export: chatgpt, claude_user_export: claude },
  };
}
