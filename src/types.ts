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
  /** The old chat, kept so earlier records still load. Asks are not saved. */
  messages: DialogueMessage[];
  createdAt: number;
  updatedAt: number;
  /** A whole system prompt pinned in Debug mode. Set, it replaces the one built from the board. */
  systemPrompt?: string;
  /** Pictures saved with whiteboard_add_image; the page shows them as board-image:ID. Absent on records saved before v3. */
  images?: BoardImage[];
}

/** A picture stored with the topic, so the board keeps it when the original link goes away. */
export interface BoardImage {
  /** img1, img2, …; the page refers to it as board-image:ID. */
  id: string;
  /** Where it was found. */
  url: string;
  description: string;
  /** The page the picture appears on, when the search said. */
  sourceUrl?: string;
  /** The cached copy; null when the download failed, and the board uses url instead. */
  blob: Blob | null;
  type?: string;
  width?: number;
  height?: number;
  addedAt: number;
}

export const BOARD_IMAGE_PREFIX = "board-image:";

export interface DialogueMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
  /** What happened during an assistant turn. Older records only; nothing writes messages now. */
  trace?: TurnTrace;
}

/** One step of an assistant turn, in the order it happened. */
export type TraceEvent =
  | { kind: "text"; text: string }
  | { kind: "reasoning"; text: string }
  | { kind: "tool"; name: string; input: unknown; output?: unknown; error?: string; ms?: number };

/** Where on the whiteboard the learner pointed: a text range or a whole element. */
export interface SelectionAnchor {
  kind: "text" | "element";
  /** Inside #lesson-svg it is svg; anywhere else on the page it is html. */
  component: "html" | "svg";
  /** A CSS path from body or #lesson-svg, as the live page resolves it. */
  selector: string;
  tag: string;
  /** The selected text with some text on each side, so the spot is found even when the selector is not. */
  quote: { exact: string; prefix: string; suffix: string };
  /** The live element, capped. */
  outerHTML: string;
  /** In the board frame's viewport, for placing the question panel. */
  rect: { x: number; y: number; width: number; height: number };
}

/** A selection stored as one anchor, or as a list. Older records are a single object. */
export function selectionList(value: SelectionAnchor | readonly SelectionAnchor[] | null | undefined): SelectionAnchor[] {
  if (!value) return [];
  if ("kind" in value) return [value];
  return [...value];
}

/** The raw input of one ask. Every ask creates a new session. */
export interface RequestInput {
  /** The messages the session was created with: the system prompt, or an edited list. */
  initialPrompts: PromptMessage[];
  prompt: string;
  /** The names of the tools the session was created with. Absent in records from before they were kept. */
  tools?: string[];
  /** One anchor in records from before box selection, or the list from a later ask. */
  selection?: SelectionAnchor | SelectionAnchor[];
  /** The initial prompts came from the Debug editor instead of the topic. */
  edited?: boolean;
}

export interface TurnTrace {
  id?: string;
  modelId: string | null;
  /** The learner's question and where they pointed, for the Trace tab. */
  question?: string;
  /** One anchor in records from before box selection, or the list from a later ask. */
  selection?: SelectionAnchor | SelectionAnchor[];
  startedAt: number;
  endedAt?: number;
  events: TraceEvent[];
  /** The streamed reply, kept only when a fallback moved it onto the whiteboard. */
  rawReply?: string;
  fallback?: "html" | "svg" | "note";
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

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  score: number | null;
}

/** An image from search with includeImages: Tavily's images, or Google's Images tab. */
export interface ImageResult {
  url: string;
  description?: string;
  /** The page the image appears on, when known. */
  sourceUrl?: string;
  thumbnail?: string;
  width?: number;
  height?: number;
}

/** localLLM.search(): Tavily, or a Google results page when Tavily is not usable. */
export interface SearchResponse {
  query: string;
  provider: "tavily" | "google";
  results: SearchResult[];
  /** Only when images were asked for, and only from extensions that support it. */
  images?: ImageResult[];
  /** Why the Google fallback was used. */
  note?: string;
}

export type SearchFn = (query: string, maxResults: number, includeImages?: boolean) => Promise<SearchResponse>;

/** Download an image found by search, through the extension (pages can't, because of CORS). */
export type FetchImageFn = (url: string) => Promise<Blob>;

export interface LocalLlmNamespace {
  info(): Promise<LocalLlmInfo>;
  models?: () => Promise<ModelInfo[]>;
  version?: string;
  /** Web search, when the learner allowed it for this site in the extension. Newer extensions only. */
  search?: (query: string, options?: { maxResults?: number; includeImages?: boolean }) => Promise<SearchResponse>;
  /** Download an image returned by search(). Newer extensions only. */
  fetchImage?: (url: string) => Promise<{ url: string; type: string; blob: Blob }>;
}
