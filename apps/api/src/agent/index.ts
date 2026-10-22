import Anthropic from "@anthropic-ai/sdk";
import type { ChatRequest, ChatResponse } from "@homerelay/shared";
import type { ApiConfig } from "../config";
import { McpUnavailableError, type McpGateway } from "../gateway";
import { deterministicChat } from "./deterministic";
import { llmChat, type LlmClient } from "./llm";

export interface ChatDeps {
  gw: McpGateway;
  cfg: ApiConfig;
  now: () => Date;
  /** Injectable for tests; defaults to the real Anthropic client built from config. */
  llmClient?: LlmClient;
}

let cached: { key: string; client: Anthropic } | null = null;
function realClient(cfg: ApiConfig): LlmClient {
  if (!cached || cached.key !== cfg.llm.apiKey) cached = { key: cfg.llm.apiKey, client: new Anthropic({ apiKey: cfg.llm.apiKey, timeout: 30_000, maxRetries: 1 }) };
  return cached.client as unknown as LlmClient;
}

/** Routes a chat request to the active agent. The rules agent is the default and the fallback. */
export async function handleChat(deps: ChatDeps, req: ChatRequest): Promise<ChatResponse> {
  const det = () => deterministicChat({ gw: deps.gw, tz: deps.cfg.tz, now: deps.now }, req);
  if (deps.cfg.llm.provider !== "anthropic" && !deps.llmClient) return det();

  try {
    return await llmChat({ gw: deps.gw, tz: deps.cfg.tz, now: deps.now, model: deps.cfg.llm.model, client: deps.llmClient ?? realClient(deps.cfg), documentAccess: deps.cfg.llm.documentAccess }, req);
  } catch (e) {
    if (e instanceof McpUnavailableError) throw e; // the fallback needs the same tool server
    // Provider problem (network, auth, rate limit, timeout). Log the class only: never the key or message content.
    console.error(JSON.stringify({ ts: new Date().toISOString(), level: "warn", msg: "LLM unavailable, using rules agent", error: (e as Error)?.constructor?.name }));
    const r = await det();
    return { ...r, reply: `The language model was unavailable, so the built-in rules agent answered instead. ${r.reply}` };
  }
}
