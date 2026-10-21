export const BOARD_COMPONENTS = ["html", "css", "js", "svg", "json"] as const;

export type BoardComponent = (typeof BOARD_COMPONENTS)[number];

export interface BoardSources {
  html: string;
  css: string;
  js: string;
  svg: string;
  json: string;
}

export interface TopicRecord {
  id: string;
  title: string;
  html: string;
  css: string;
  js: string;
  svg: string;
  json: string;
  materialMarkdown: string;
  messages: DialogueMessage[];
  createdAt: number;
  updatedAt: number;
  /** A whole system prompt pinned in Debug mode. Set, it replaces the one built from the board. */
  systemPrompt?: string;
}

export interface DialogueMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
  /** What happened during an assistant turn, for Debug mode. Absent on older records. */
  trace?: TurnTrace;
}

/** One step of an assistant turn, in the order it happened. */
export type TraceEvent =
  | { kind: "text"; text: string }
  | { kind: "reasoning"; text: string }
  | { kind: "tool"; name: string; input: unknown; output?: unknown; error?: string; ms?: number };

/** The raw input of one request. A reused session receives only the prompt. */
export interface RequestInput {
  newSession: boolean;
  /** The messages a new session was created with: system first, then history. */
  initialPrompts?: PromptMessage[];
  prompt: string;
  /** The initial prompts came from the Debug editor instead of the topic. */
  edited?: boolean;
}

export interface TurnTrace {
  modelId: string | null;
  startedAt: number;
  endedAt?: number;
  events: TraceEvent[];
  /** The streamed reply, kept only when the fallback replaced it in the chat. */
  rawReply?: string;
  fallback?: "html" | "svg";
  /** What this turn sent to the model. */
  request?: RequestInput;
  inputUsage?: number;
  inputQuota?: number;
  error?: string;
}

export interface PromptMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface SectionOutline {
  id: string;
  heading: string;
}

export type Availability = "available" | "downloadable" | "downloading" | "unavailable";

export interface ModelParams {
  defaultTopK: number;
  maxTopK: number;
  defaultTemperature: number;
  maxTemperature: number;
}

export interface ToolDeclaration {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: (input: unknown) => Promise<unknown> | unknown;
}

export interface CreateOptions {
  initialPrompts?: PromptMessage[];
  tools?: ToolDeclaration[];
  signal?: AbortSignal;
  monitor?: (monitor: EventTarget) => void;
  temperature?: number;
  topK?: number;
  /** An id from `localLLM.models()`. Omitted, the extension uses its default. */
  model?: string;
  /** Extension only: deliver a reasoning model's thinking to `onReasoning`. */
  reasoning?: boolean;
}

export interface LanguageModelSession {
  promptStreaming(
    input: string,
    options?: { signal?: AbortSignal; onReasoning?: (text: string) => void },
  ): AsyncIterable<string> | ReadableStream<string>;
  destroy(): void;
  measureInputUsage?: (input: string) => Promise<number>;
  inputUsage?: number;
  inputQuota?: number;
}

export interface LanguageModelAPI {
  availability(): Promise<Availability>;
  params?: () => Promise<ModelParams>;
  create(options?: CreateOptions): Promise<LanguageModelSession>;
}

export interface LocalLlmInfo {
  name?: string;
  backend?: string;
  images?: boolean;
  tools?: "native" | "prompted";
  version?: string;
}

export interface ModelPrice {
  input: number;
  output: number;
  cachedInput?: number;
  long?: { above: number; input: number; output: number };
  note?: string;
  asOf?: string;
}

/** A model this site can run now, as `localLLM.models()` reports it. */
export interface ModelInfo {
  id: string;
  name: string;
  backend: string;
  provider: string;
  engine?: string;
  default: boolean;
  input: string[];
  output: string[];
  contextWindow: number;
  inputQuota: number;
  maxOutputTokens: number;
  reasoning?: "hybrid" | "always";
  tools: "native" | "prompted";
  price: ModelPrice | null;
  sizeMB?: number;
  legacy?: boolean;
}

export interface LocalLlmNamespace {
  info(): Promise<LocalLlmInfo>;
  models?: () => Promise<ModelInfo[]>;
  version?: string;
}
