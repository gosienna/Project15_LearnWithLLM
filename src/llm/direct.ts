import Anthropic from "@anthropic-ai/sdk";
import type { CreateOptions, LanguageModelAPI, LanguageModelSession, ModelInfo, PromptMessage, ToolDeclaration } from "../types.ts";

/**
 * A model the page calls itself, with an API key the learner typed in. No extension needed:
 * the request goes from this browser straight to the provider.
 */
export type DirectProvider = "anthropic" | "openai" | "openrouter" | "gemini" | "custom";

export interface DirectConfig {
  provider: DirectProvider;
  apiKey: string;
  model: string;
  /** Custom only: an OpenAI-compatible endpoint, up to and including /v1. */
  baseUrl?: string;
  /** Keep the key after the tab closes (localStorage) instead of only for this tab (sessionStorage). */
  remember: boolean;
}

export interface ProviderPreset {
  label: string;
  /** Where its OpenAI-compatible API lives. Anthropic uses its own SDK. */
  baseUrl: string;
  defaultModel: string;
  keyHint: string;
}

export const PROVIDERS: Record<DirectProvider, ProviderPreset> = {
  anthropic: { label: "Anthropic (Claude)", baseUrl: "https://api.anthropic.com", defaultModel: "claude-opus-5-5", keyHint: "sk-ant-…" },
  openai: { label: "OpenAI", baseUrl: "https://api.openai.com/v1", defaultModel: "", keyHint: "sk-…" },
  openrouter: { label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", defaultModel: "", keyHint: "sk-or-…" },
  gemini: { label: "Google Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", defaultModel: "", keyHint: "AIza…" },
  custom: { label: "Custom (OpenAI-compatible)", baseUrl: "", defaultModel: "", keyHint: "API key" },
};

export const DIRECT_STORAGE_KEY = "learn-with-llm.direct";
export const DIRECT_MODEL_PREFIX = "direct:";

/** What the model list shows for a typed-in key. Context sizes are a guess the provider does not report. */
const DIRECT_CONTEXT_TOKENS = 128_000;
const ANTHROPIC_MAX_TOKENS = 64_000;
/** How many model calls one ask may make while it runs tools. */
const MAX_TOOL_ROUNDS = 40;

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function storages(): { local: StorageLike | null; session: StorageLike | null } {
  const pick = (name: "localStorage" | "sessionStorage") => {
    try {
      return typeof globalThis[name] === "undefined" ? null : globalThis[name];
    } catch {
      return null;
    }
  };
  return { local: pick("localStorage"), session: pick("sessionStorage") };
}

function parseConfig(raw: string | null | undefined): DirectConfig | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<DirectConfig>;
    if (!value || typeof value.apiKey !== "string" || !value.apiKey || typeof value.provider !== "string") return null;
    if (!(value.provider in PROVIDERS)) return null;
    return {
      provider: value.provider,
      apiKey: value.apiKey,
      model: typeof value.model === "string" ? value.model : "",
      ...(typeof value.baseUrl === "string" && value.baseUrl ? { baseUrl: value.baseUrl } : {}),
      remember: value.remember === true,
    };
  } catch {
    return null;
  }
}

/** This tab's key first, then a remembered one. */
export function readDirectConfig(stores = storages()): DirectConfig | null {
  try {
    return parseConfig(stores.session?.getItem(DIRECT_STORAGE_KEY)) ?? parseConfig(stores.local?.getItem(DIRECT_STORAGE_KEY));
  } catch {
    return null;
  }
}

export function writeDirectConfig(config: DirectConfig | null, stores = storages()): void {
  try {
    stores.session?.removeItem(DIRECT_STORAGE_KEY);
    stores.local?.removeItem(DIRECT_STORAGE_KEY);
    if (!config) return;
    (config.remember ? stores.local : stores.session)?.setItem(DIRECT_STORAGE_KEY, JSON.stringify(config));
  } catch {
    // Blocked storage: the key works until reload.
  }
}

export function baseUrlOf(config: Pick<DirectConfig, "provider" | "baseUrl">): string {
  const url = config.provider === "custom" ? config.baseUrl ?? "" : PROVIDERS[config.provider].baseUrl;
  return url.replace(/\/+$/, "");
}

export function directModelId(config: Pick<DirectConfig, "provider" | "model">): string {
  return `${DIRECT_MODEL_PREFIX}${config.provider}:${config.model}`;
}

export function isDirectModelId(id: string | null | undefined): boolean {
  return !!id?.startsWith(DIRECT_MODEL_PREFIX);
}

/** The typed-in key as an entry in the System list, or null while it is incomplete. */
export function directModelInfo(config: DirectConfig | null): ModelInfo | null {
  if (!config?.apiKey || !config.model.trim()) return null;
  if (config.provider === "custom" && !baseUrlOf(config)) return null;
  return {
    id: directModelId(config),
    name: config.model,
    backend: "direct",
    provider: PROVIDERS[config.provider].label,
    engine: "your API key",
    default: false,
    input: ["text"],
    output: ["text"],
    contextWindow: DIRECT_CONTEXT_TOKENS,
    inputQuota: DIRECT_CONTEXT_TOKENS,
    maxOutputTokens: config.provider === "anthropic" ? ANTHROPIC_MAX_TOKENS : 0,
    tools: "native",
    price: null,
  };
}

/** Errors named the way the extension names them, so errorNote() explains them the same way. */
function providerError(status: number | undefined, message: string): Error {
  const name =
    status === 401 || status === 403
      ? "NotAllowedError"
      : status === 429
        ? "QuotaExceededError"
        : "NetworkError";
  return Object.assign(new Error(`Provider ${status ?? ""}: ${message}`.replace(" :", ":")), { name });
}

function abortError(): Error {
  return Object.assign(new Error("Aborted"), { name: "AbortError" });
}

function systemText(prompts: PromptMessage[]): string {
  return prompts
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n");
}

function conversation(prompts: PromptMessage[]): { role: "user" | "assistant"; content: string }[] {
  return prompts.filter((message) => message.role !== "system").map((message) => ({ role: message.role as "user" | "assistant", content: message.content }));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function runTool(tools: ToolDeclaration[], name: string, input: unknown): Promise<{ content: string; isError: boolean }> {
  const tool = tools.find((item) => item.name === name);
  if (!tool) return { content: `No tool named ${name}.`, isError: true };
  try {
    const output = await tool.execute(input);
    return { content: typeof output === "string" ? output : JSON.stringify(output ?? null), isError: false };
  } catch (error) {
    return { content: errorText(error), isError: true };
  }
}

interface StreamOptions {
  signal?: AbortSignal;
  onReasoning?: (text: string) => void;
}

/** Models older than Claude 4.6 take a thinking budget, not adaptive thinking; they run without thinking here. */
function adaptiveThinking(model: string): boolean {
  return !/^claude-(3|[a-z]+-4(-[015])?($|-\d{8}|@))/.test(model);
}

/** The models that accept server-side refusal fallbacks in their "default" form. */
function takesFallbacks(model: string): boolean {
  return /^claude-(fable-5-1|opus-5-5|opus-5|sonnet-5-5)$/.test(model);
}

class AnthropicSession implements LanguageModelSession {
  readonly inputQuota = DIRECT_CONTEXT_TOKENS;
  inputUsage?: number;
  private readonly client: Anthropic;
  private readonly destroyed = new AbortController();

  constructor(
    private readonly config: DirectConfig,
    private readonly options: CreateOptions,
  ) {
    this.client = new Anthropic({ apiKey: config.apiKey, dangerouslyAllowBrowser: true });
  }

  promptStreaming(input: string, options: StreamOptions = {}): AsyncIterable<string> {
    return this.run(input, options);
  }

  destroy(): void {
    this.destroyed.abort();
  }

  private async *run(input: string, options: StreamOptions): AsyncGenerator<string> {
    const signal = AbortSignal.any([this.destroyed.signal, ...(options.signal ? [options.signal] : []), ...(this.options.signal ? [this.options.signal] : [])]);
    const model = this.config.model;
    const declared = this.options.tools ?? [];
    const tools: Anthropic.Beta.BetaTool[] = declared.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema as Anthropic.Beta.BetaTool.InputSchema,
      eager_input_streaming: true,
    }));
    const prompts = this.options.initialPrompts ?? [];
    const system = systemText(prompts);
    const messages: Anthropic.Beta.BetaMessageParam[] = [...conversation(prompts), { role: "user", content: input }];
    const thinking = adaptiveThinking(model);
    const fallbacks = takesFallbacks(model);

    for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
      if (signal.aborted) throw abortError();
      let message: Anthropic.Beta.BetaMessage;
      try {
        const stream = this.client.beta.messages.stream(
          {
            model,
            max_tokens: ANTHROPIC_MAX_TOKENS,
            ...(system ? { system } : {}),
            messages,
            ...(tools.length ? { tools } : {}),
            ...(thinking ? { thinking: { type: "adaptive", display: this.options.reasoning ? "summarized" : "omitted" } } : {}),
            ...(fallbacks ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } : {}),
          },
          { signal },
        );
        for await (const event of stream) {
          if (event.type !== "content_block_delta") continue;
          if (event.delta.type === "text_delta") yield event.delta.text;
          else if (event.delta.type === "thinking_delta" && event.delta.thinking) options.onReasoning?.(event.delta.thinking);
        }
        message = await stream.finalMessage();
      } catch (error) {
        if (signal.aborted || error instanceof Anthropic.APIUserAbortError) throw abortError();
        if (error instanceof Anthropic.APIError) throw providerError(error.status, error.message);
        throw error;
      }
      this.inputUsage = message.usage.input_tokens + (message.usage.cache_read_input_tokens ?? 0);

      if (message.stop_reason === "refusal") throw providerError(undefined, "Claude declined this request.");
      if (message.stop_reason === "pause_turn") {
        messages.push({ role: "assistant", content: message.content });
        continue;
      }
      const calls = message.content.filter((block): block is Anthropic.Beta.BetaToolUseBlock => block.type === "tool_use");
      if (calls.length === 0) return;
      if (message.stop_reason === "max_tokens") throw providerError(undefined, "The reply hit max_tokens in the middle of a tool call.");

      messages.push({ role: "assistant", content: message.content });
      const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
      for (const call of calls) {
        if (signal.aborted) throw abortError();
        const result = await runTool(declared, call.name, call.input);
        results.push({ type: "tool_result", tool_use_id: call.id, content: result.content, ...(result.isError ? { is_error: true } : {}) });
      }
      messages.push({ role: "user", content: results });
    }
    throw providerError(undefined, `Stopped after ${MAX_TOOL_ROUNDS} tool rounds.`);
  }
}

interface ChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ChatToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

interface ChatChunk {
  choices?: {
    delta?: {
      content?: string | null;
      reasoning?: string | null;
      reasoning_content?: string | null;
      tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[];
    };
    finish_reason?: string | null;
  }[];
  usage?: { prompt_tokens?: number } | null;
  error?: { message?: string };
}

/** Server-sent events from a fetch body, one data payload at a time. */
async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const step = await reader.read();
      if (step.done) break;
      buffer += decoder.decode(step.value, { stream: true });
      let end: number;
      while ((end = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, end).replace(/\r$/, "");
        buffer = buffer.slice(end + 1);
        if (line.startsWith("data:")) yield line.slice(5).trim();
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** OpenAI, OpenRouter, Gemini, or any server with an OpenAI-style /chat/completions. */
class ChatCompletionsSession implements LanguageModelSession {
  readonly inputQuota = DIRECT_CONTEXT_TOKENS;
  inputUsage?: number;
  private readonly destroyed = new AbortController();

  constructor(
    private readonly config: DirectConfig,
    private readonly options: CreateOptions,
  ) {}

  promptStreaming(input: string, options: StreamOptions = {}): AsyncIterable<string> {
    return this.run(input, options);
  }

  destroy(): void {
    this.destroyed.abort();
  }

  private async *run(input: string, options: StreamOptions): AsyncGenerator<string> {
    const signal = AbortSignal.any([this.destroyed.signal, ...(options.signal ? [options.signal] : []), ...(this.options.signal ? [this.options.signal] : [])]);
    const declared = this.options.tools ?? [];
    const tools = declared.map((tool) => ({
      type: "function" as const,
      function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
    }));
    const messages: ChatMessage[] = [...(this.options.initialPrompts ?? []).map((message) => ({ ...message })), { role: "user", content: input }];

    for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
      if (signal.aborted) throw abortError();
      let response: Response;
      try {
        response = await fetch(`${baseUrlOf(this.config)}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${this.config.apiKey}` },
          body: JSON.stringify({
            model: this.config.model,
            messages,
            stream: true,
            ...(tools.length ? { tools } : {}),
          }),
          signal,
        });
      } catch (error) {
        if (signal.aborted) throw abortError();
        throw providerError(undefined, `${errorText(error)} (the provider may not allow requests from web pages)`);
      }
      if (!response.ok || !response.body) throw providerError(response.status, (await response.text().catch(() => "")).slice(0, 300));

      let text = "";
      let finish: string | null = null;
      const calls: ChatToolCall[] = [];
      try {
        for await (const data of sseData(response.body)) {
          if (data === "[DONE]") break;
          let chunk: ChatChunk;
          try {
            chunk = JSON.parse(data) as ChatChunk;
          } catch {
            continue;
          }
          if (chunk.error) throw providerError(response.status, chunk.error.message ?? data.slice(0, 300));
          if (typeof chunk.usage?.prompt_tokens === "number") this.inputUsage = chunk.usage.prompt_tokens;
          const choice = chunk.choices?.[0];
          if (!choice) continue;
          const delta = choice.delta ?? {};
          const reasoning = delta.reasoning ?? delta.reasoning_content;
          if (reasoning) options.onReasoning?.(reasoning);
          if (delta.content) {
            text += delta.content;
            yield delta.content;
          }
          for (const part of delta.tool_calls ?? []) {
            const call = (calls[part.index] ??= { id: "", type: "function", function: { name: "", arguments: "" } });
            if (part.id) call.id = part.id;
            if (part.function?.name) call.function.name += part.function.name;
            if (part.function?.arguments) call.function.arguments += part.function.arguments;
          }
          if (choice.finish_reason) finish = choice.finish_reason;
        }
      } catch (error) {
        if (signal.aborted) throw abortError();
        throw error;
      }

      const made = calls.filter(Boolean);
      if (made.length === 0) return;
      if (finish === "length") throw providerError(undefined, "The reply hit the output limit in the middle of a tool call.");
      made.forEach((call, index) => {
        if (!call.id) call.id = `call_${round}_${index}`;
      });
      messages.push({ role: "assistant", content: text || null, tool_calls: made });
      for (const call of made) {
        if (signal.aborted) throw abortError();
        let args: unknown;
        try {
          args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
        } catch {
          messages.push({ role: "tool", tool_call_id: call.id, content: "The arguments were not valid JSON. Call the tool again." });
          continue;
        }
        const result = await runTool(declared, call.function.name, args);
        messages.push({ role: "tool", tool_call_id: call.id, content: result.isError ? `Error: ${result.content}` : result.content });
      }
    }
    throw providerError(undefined, `Stopped after ${MAX_TOOL_ROUNDS} tool rounds.`);
  }
}

/** A LanguageModel-shaped API that calls the provider from the page with the learner's key. */
export function createDirectLanguageModel(config: DirectConfig): LanguageModelAPI {
  return {
    availability: async () => (directModelInfo(config) ? "available" : "unavailable"),
    create: async (options = {}) => {
      if (options.signal?.aborted) throw abortError();
      return config.provider === "anthropic" ? new AnthropicSession(config, options) : new ChatCompletionsSession(config, options);
    },
  };
}

/** The provider's model ids, for the model field's suggestions. */
export async function listDirectModels(config: Pick<DirectConfig, "provider" | "apiKey" | "baseUrl">): Promise<string[]> {
  if (config.provider === "anthropic") {
    const client = new Anthropic({ apiKey: config.apiKey, dangerouslyAllowBrowser: true });
    const ids: string[] = [];
    try {
      for await (const model of client.models.list()) ids.push(model.id);
    } catch (error) {
      if (error instanceof Anthropic.APIError) throw providerError(error.status, error.message);
      throw error;
    }
    return ids;
  }
  const response = await fetch(`${baseUrlOf(config)}/models`, { headers: { authorization: `Bearer ${config.apiKey}` } });
  if (!response.ok) throw providerError(response.status, (await response.text().catch(() => "")).slice(0, 300));
  const body = (await response.json()) as { data?: { id?: string }[] };
  return (body.data ?? [])
    .map((item) => item.id?.replace(/^models\//, ""))
    .filter((id): id is string => !!id)
    .sort();
}
