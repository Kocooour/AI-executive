export interface ServerAIResult {
  message: string;
  provider: "hermes" | "openai" | "local";
}

async function askHermes(prompt: string): Promise<ServerAIResult | null> {
  const token = process.env.HERMES_BRIDGE_TOKEN?.trim();
  if (!token || process.env.HERMES_AI_ENABLED !== "true") return null;
  const baseUrl = (process.env.HERMES_BRIDGE_URL || "http://127.0.0.1:8787")
    .replace(/\/$/, "");
  const response = await fetch(`${baseUrl}/v1/query`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ prompt }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!response.ok) throw new Error(`Hermes provider returned ${response.status}`);
  const result = await response.json();
  if (Number(result.exit_code) !== 0) throw new Error("Hermes provider failed");
  const message = String(result.stdout || "").trim();
  if (!message) throw new Error("Hermes provider returned an empty response");
  return { message, provider: "hermes" };
}

async function askOpenAI(prompt: string): Promise<ServerAIResult | null> {
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) return null;
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || "gpt-5-mini",
      input: [{ role: "user", content: prompt }],
      max_output_tokens: 1200,
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`OpenAI provider returned ${response.status}`);
  const data = await response.json();
  const message = (data.output || [])
    .flatMap((output: any) => output.content || [])
    .filter((content: any) => content.type === "output_text")
    .map((content: any) => content.text)
    .join("\n")
    .trim();
  if (!message) throw new Error("OpenAI provider returned an empty response");
  return { message, provider: "openai" };
}

export async function completeServerAI(prompt: string): Promise<ServerAIResult | null> {
  const preferred = (process.env.AI_PROVIDER || "hermes").toLowerCase();
  const providers = preferred === "openai"
    ? [askOpenAI, askHermes]
    : [askHermes, askOpenAI];
  let lastError: unknown;
  for (const provider of providers) {
    try {
      const result = await provider(prompt);
      if (result) return result;
    } catch (error) {
      lastError = error;
      console.error("AI provider request failed", error instanceof Error ? error.message : error);
    }
  }
  if (lastError) throw lastError;
  return null;
}


/**
 * C-3b OPENAI-ONLY primitive, deliberately NOT wired to any route or UI.
 *
 * SECURITY: the future caller MUST hold the shared consent/dispatch fence
 * before invoking this function, then revalidate ACL, consent epoch and restore
 * generation before using its result. This low-level function is not consent
 * management, an authorization mechanism, a cache, or a suggestion token.
 *
 * Unlike completeServerAI(), this can NEVER dispatch to Hermes/local. It does
 * not log private content or keep the AI response after returning. Remote
 * provider retention is independent and must be disclosed in release docs.
 */
export interface InboxOpenAIOnlyInput {
  readonly taskTitle: string;
  readonly privateAreaNames: readonly string[];
  readonly privateOpenProjectNames: readonly string[];
}
export type InboxOpenAIOnlyChoice = {
  readonly action: "keep" | "area" | "project";
  readonly targetName: string | null;
  readonly reason: string;
};

const INBOX_AI_MAX_NAMES = 128;
const INBOX_AI_MAX_TITLE_BYTES = 4096;
const INBOX_AI_MAX_NAME_BYTES = 512;
const INBOX_AI_MAX_OUTPUT_BYTES = 8192;
const INBOX_AI_TIMEOUT_MS = 8_000;

/** Explicit input allowlist: no IDs, session, notes, email, metadata or shared data. */
function validInboxAIInput(input: InboxOpenAIOnlyInput): boolean {
  if (!input || typeof input.taskTitle !== "string" ||
      !input.taskTitle.trim() || Buffer.byteLength(input.taskTitle,"utf8") > INBOX_AI_MAX_TITLE_BYTES ||
      !Array.isArray(input.privateAreaNames) ||
      !Array.isArray(input.privateOpenProjectNames) ||
      input.privateAreaNames.length > INBOX_AI_MAX_NAMES ||
      input.privateOpenProjectNames.length > INBOX_AI_MAX_NAMES) return false;
  return [...input.privateAreaNames,...input.privateOpenProjectNames].every(
    name => typeof name === "string" && name.length > 0 &&
      name.trim() === name && Buffer.byteLength(name,"utf8") <= INBOX_AI_MAX_NAME_BYTES &&
      !/[\u0000-\u001f\u007f]/u.test(name),
  );
}

const INBOX_AI_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["action","targetName","reason"],
  properties: {
    action: {type: "string",enum:["keep","area","project"]},
    targetName: {type:["string","null"]},
    reason: {type:"string"},
  },
} as const;

function parseInboxAIChoice(
  text: string, input: InboxOpenAIOnlyInput,
): InboxOpenAIOnlyChoice | null {
  if (!text || Buffer.byteLength(text,"utf8") > INBOX_AI_MAX_OUTPUT_BYTES) return null;
  let value: unknown;
  try { value = JSON.parse(text); } catch { return null; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string,unknown>;
  if (Object.keys(item).sort().join(",") !== "action,reason,targetName" ||
      !["keep","area","project"].includes(String(item.action)) ||
      typeof item.reason !== "string" || item.reason.length > 240 ||
      /[\u0000-\u001f\u007f]/u.test(item.reason)) return null;
  const action = item.action as InboxOpenAIOnlyChoice["action"];
  if (action === "keep")
    return item.targetName === null ? {action,targetName:null,reason:item.reason} : null;
  if (typeof item.targetName !== "string") return null;
  // A name is accepted ONLY when unique in the entire actor-private allowlist.
  // Distinct IDs sharing the same name cannot be disambiguated by AI.
  const allNames = [...input.privateAreaNames,...input.privateOpenProjectNames];
  if (allNames.filter(name => name === item.targetName).length !== 1) return null;
  const authorizedNames = action === "area" ? input.privateAreaNames
    : input.privateOpenProjectNames;
  if (!authorizedNames.includes(item.targetName)) return null;
  return {action,targetName:item.targetName,reason:item.reason};
}

/**
 * Caller-owned AbortSignal + independent ~8s cap. A failed OpenAI call returns
 * null; the caller's ONLY fallback is its local deterministic rule engine.
 * This function intentionally never calls completeServerAI().
 */
export async function completeInboxOpenAIOnly(
  input: InboxOpenAIOnlyInput,
  callerSignal: AbortSignal,
): Promise<InboxOpenAIOnlyChoice | null> {
  if (!validInboxAIInput(input) || !(callerSignal instanceof AbortSignal) ||
      callerSignal.aborted) return null;
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) return null;
  const signal = AbortSignal.any([callerSignal,AbortSignal.timeout(INBOX_AI_TIMEOUT_MS)]);
  if (signal.aborted) return null;
  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method:"POST",
      headers: {
        "content-type":"application/json",
        authorization:"Bearer " + key,
      },
      body:JSON.stringify({
        model:process.env.OPENAI_MODEL || "gpt-5-mini",
        input:[
          {role:"system",content:"Classify the task against the listed private Area or open private project NAMES only. Return keep/area/project and an exact supplied targetName, or null for keep. Never invent names. Return only the prescribed JSON."},
          {role:"user",content:JSON.stringify({
            taskTitle:input.taskTitle,
            privateAreaNames:input.privateAreaNames,
            privateOpenProjectNames:input.privateOpenProjectNames,
          })},
        ],
        text:{format:{type:"json_schema",name:"lumi_inbox_choice",strict:true,
          schema:INBOX_AI_RESPONSE_SCHEMA}},
        max_output_tokens:350,
      }),
      signal,
    });
    if (!response.ok || signal.aborted) return null;
    const data = await response.json();
    if (signal.aborted || !data || !Array.isArray(data.output)) return null;
    const message = data.output.flatMap((x: any) =>
      x && Array.isArray(x.content) ? x.content : [])
      .filter((x: any) => x && x.type === "output_text" && typeof x.text === "string")
      .map((x: any) => x.text).join("").trim();
    if (signal.aborted) return null;
    return parseInboxAIChoice(message,input);
  } catch {
    // Do not log provider error bodies: they can include task/Area/project names.
    return null;
  }
}
