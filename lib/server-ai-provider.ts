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
