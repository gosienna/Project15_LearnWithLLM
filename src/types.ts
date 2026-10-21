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
}

export interface DialogueMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
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
}

export interface LanguageModelSession {
  promptStreaming(
    input: string,
    options?: { signal?: AbortSignal },
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
