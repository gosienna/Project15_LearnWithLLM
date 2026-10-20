export interface TopicRecord {
  id: string;
  title: string;
  documentMarkdown: string;
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

export interface LocalLlmNamespace {
  info(): Promise<LocalLlmInfo>;
  version?: string;
}
