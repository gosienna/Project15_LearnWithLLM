import { parseLesson } from "../document/markdown.ts";
import type { TopicRepository } from "../storage/db.ts";
import type {
  CreateOptions,
  LanguageModelAPI,
  LanguageModelSession,
  PromptMessage,
  SearchFn,
  SelectionAnchor,
  ToolDeclaration,
  TopicRecord,
  TurnTrace,
} from "../types.ts";
import { boardIsEmpty, insertNote, stripSelectionMarkers, titleFromHtml } from "../ui/whiteboard.ts";
import { buildPrompt, type BuiltPrompt } from "./system-prompt.ts";
import { createWhiteboardTools } from "./tools.ts";
import { capText, TraceRecorder } from "./trace.ts";

/** How long creating a session may take before the ask gives up. A local model loads well within it. */
export const START_TIMEOUT_MS = 45_000;

export const START_TIMEOUT =
  "The model service did not answer. Reload the page to reconnect.";

/** Shown when a turn ends and the board did not change. */
export const NOTHING_CHANGED = "The model did not change the whiteboard. Ask again, or try a different model.";

const SVG_MARKUP = /<svg\b[\s\S]*?<\/svg>/i;

export function extractBoardSvg(reply: string): string | null {
  const match = SVG_MARKUP.exec(reply);
  if (!match) return null;
  const svg = match[0].replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\'/g, "'");
  return /<svg\b/i.test(svg) ? svg : null;
}

export function replyIsToolDump(reply: string): boolean {
  return /whiteboard_replace_document|```tool_code|whiteboard_set\s*\(/i.test(reply);
}

export function shouldUseEmptyBoardFallback(input: {
  boardWasEmpty: boolean;
  toolSucceeded: boolean;
  aborted: boolean;
  reply: string;
}): boolean {
  if (!input.boardWasEmpty || input.toolSucceeded || input.aborted) return false;
  if (replyIsToolDump(input.reply) && extractBoardSvg(input.reply)) return false;
  if (input.reply.length <= 400) return false;
  return /<[a-z][^>\n]*>/i.test(input.reply);
}

/**
 * The cloud provider's own explanation from a backend error ("Provider ...: <body>"), or null.
 * The backend cuts the body at 300 characters, often mid-JSON, so "message" is matched, not parsed.
 */
export function providerDetail(message: string | undefined): string | null {
  if (!message?.startsWith("Provider ")) return null;
  const inner = /"message"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(message)?.[1];
  const text = inner ? inner.replace(/\\n/g, " ").replace(/\\(.)/g, "$1") : message;
  return text.replace(/\s+/g, " ").trim() || null;
}

export function errorNote(error: unknown): string | null {
  const err = error as { name?: string; message?: string };
  const detail = providerDetail(err?.message);
  switch (err?.name) {
    case "NotAllowedError":
      if (detail) return `The provider rejected the API key: ${detail}`;
      return "This site is not allowed to use the model. Enable it in the extension and reload.";
    case "QuotaExceededError":
      if (detail) return `The provider's rate limit or quota is used up: ${detail}`;
      return "The lesson or the conversation is over the model's limit. Shorten the request.";
    case "InvalidStateError":
      return "The session was lost. Ask again.";
    case "AbortError":
      return null;
    case "NetworkError":
    case "OperationError":
      if (detail) return `The request failed: ${detail}`;
      return "The request failed. Ask again.";
    default:
      return err?.message || "The request failed.";
  }
}

export interface TutorDeps {
  repo: TopicRepository;
  languageModel: () => LanguageModelAPI | null;
  getOpenTopicId: () => string | null;
  onTopic: (topic: TopicRecord) => void;
  /** The trace of an ask, while it runs and once more when it is done. The same object each time. */
  onTrace: (topicId: string, trace: TurnTrace, done: boolean) => void;
  onError: (message: string | null) => void;
  onBusy: (busy: boolean) => void;
  onDownload: (ratio: number | null) => void;
  /** whiteboard_explain ran: show the text next to where the learner pointed. Never saved. */
  onExplain?: (topicId: string, explanation: { text: string; anchor: SelectionAnchor | null }) => void;
  contextTokens?: () => number | undefined;
  modelId?: () => string | null;
  /** The search function when web search is on and the extension offers it; otherwise null. */
  search?: () => SearchFn | null;
}

export interface AskOptions {
  /** Where the learner pointed. Null for the first question and toolbar actions. */
  anchor?: SelectionAnchor | null;
  /** Put a reply that changed nothing onto the board as a note. On by default. */
  note?: boolean;
}

async function* iterateText(source: AsyncIterable<string> | ReadableStream<string>): AsyncGenerator<string> {
  if (source && typeof (source as AsyncIterable<string>)[Symbol.asyncIterator] === "function") {
    yield* source as AsyncIterable<string>;
    return;
  }
  const reader = (source as ReadableStream<string>).getReader();
  try {
    for (;;) {
      const step = await reader.read();
      if (step.done) return;
      if (typeof step.value === "string" && step.value) yield step.value;
    }
  } finally {
    reader.releaseLock();
  }
}

/** Ends with an AbortError as soon as the signal fires, even when the backend never yields again. */
async function* untilAborted<T>(source: AsyncGenerator<T>, signal: AbortSignal): AsyncGenerator<T> {
  const aborted = new Promise<never>((_, reject) => {
    const fail = () => reject(Object.assign(new Error("Aborted"), { name: "AbortError" }));
    if (signal.aborted) fail();
    else signal.addEventListener("abort", fail, { once: true });
  });
  aborted.catch(() => {});
  try {
    for (;;) {
      const step = await Promise.race([source.next(), aborted]);
      if (step.done) return;
      yield step.value;
    }
  } finally {
    void source.return(undefined).catch(() => {});
  }
}

/** The promise, or AbortError when the signal fires first, or TimeoutError after `ms`. */
export function settleWithin<T>(promise: Promise<T>, signal: AbortSignal, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => finish(() => reject(Object.assign(new Error(message), { name: "TimeoutError" }))), ms);
    const onAbort = () => finish(() => reject(Object.assign(new Error("Aborted"), { name: "AbortError" })));
    const finish = (settle: () => void) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      settle();
    };
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

/** A session that arrives after the ask gave up on it is destroyed, so it does not hold a slot. */
function createSession(model: LanguageModelAPI, options: CreateOptions, signal: AbortSignal): Promise<LanguageModelSession> {
  const pending = model.create(options);
  return settleWithin(pending, signal, START_TIMEOUT_MS, START_TIMEOUT).catch((error: unknown) => {
    pending.then((late) => late.destroy(), () => {});
    throw error;
  });
}

/** A reply printed as a fenced block: the code inside the fence. */
export function unfence(reply: string): string {
  const match = /^\s*```[\w-]*\s*\n([\s\S]*?)\n?```\s*$/.exec(reply);
  return match ? match[1]! : reply;
}

function sourcesOf(topic: TopicRecord) {
  return { html: topic.html, css: topic.css, js: topic.js, svg: topic.svg, json: topic.json };
}

/**
 * Answers the learner on the whiteboard. Every ask is its own session with one system prompt and
 * one prompt: no history, and nothing but the board is saved.
 */
export class Tutor {
  private abort: AbortController | null = null;
  private epoch = 0;
  private busy = false;
  /** Initial prompts edited in Debug mode, used once by the topic's next ask. */
  private readonly nextPrompts = new Map<string, PromptMessage[]>();

  constructor(private readonly deps: TutorDeps) {}

  get isBusy(): boolean {
    return this.busy;
  }

  /** Use these initial prompts for the topic's next ask. Null discards them. */
  setNextRequest(topicId: string, prompts: PromptMessage[] | null): void {
    if (prompts) this.nextPrompts.set(topicId, prompts.map((message) => ({ ...message })));
    else this.nextPrompts.delete(topicId);
  }

  private build(topic: TopicRecord, question: string, anchor: SelectionAnchor | null, maxFullSections?: number): BuiltPrompt {
    return buildPrompt({
      webSearch: !!this.deps.search?.(),
      sources: sourcesOf(topic),
      materialMarkdown: topic.materialMarkdown,
      question,
      anchor,
      contextTokens: this.deps.contextTokens?.(),
      maxFullSections,
      systemOverride: topic.systemPrompt,
    });
  }

  /** The system prompt every ask on this topic starts from: the pinned one or the automatic one. */
  previewSystem(topic: TopicRecord): { text: string; pinned: boolean } {
    if (topic.systemPrompt !== undefined) return { text: topic.systemPrompt, pinned: true };
    return { text: this.build(topic, "", null).system, pinned: false };
  }

  /** The initial prompts the topic's next ask creates its session with. */
  previewRequest(topic: TopicRecord): { edited: boolean; initialPrompts: PromptMessage[] } {
    const edited = this.nextPrompts.get(topic.id);
    if (edited) return { edited: true, initialPrompts: edited.map((message) => ({ ...message })) };
    return { edited: false, initialPrompts: [{ role: "system", content: this.build(topic, "", null).system }] };
  }

  /** The prompt the next ask sends for this question and selection. */
  previewPrompt(topic: TopicRecord, question: string, anchor: SelectionAnchor | null): string {
    return this.build(topic, question.trim(), anchor).prompt;
  }

  stop(): void {
    this.abort?.abort();
  }

  cancelForSwitch(): void {
    this.epoch += 1;
    this.stop();
    this.busy = false;
    this.abort = null;
    this.deps.onBusy(false);
  }

  async ask(topicId: string, question: string, options: AskOptions = {}): Promise<void> {
    const trimmed = question.trim();
    if (!trimmed || this.busy) return;
    const anchor = options.anchor ?? null;
    const epoch = this.epoch;
    const alive = () => epoch === this.epoch;
    const model = this.deps.languageModel();
    if (!model) {
      this.deps.onError("The page cannot see a model. Enable this site in the extension and reload.");
      return;
    }

    this.busy = true;
    this.deps.onBusy(true);
    this.deps.onError(null);
    const abort = new AbortController();
    this.abort = abort;

    const topic = await this.deps.repo.get(topicId);
    if (!topic || !alive()) {
      this.finish(alive);
      return;
    }

    const boardWasEmpty = boardIsEmpty(topic);
    const svgAtStart = topic.svg;
    let toolSucceeded = false;
    let explained = false;
    const recorder = new TraceRecorder(this.deps.modelId?.() ?? null);
    recorder.trace.id = crypto.randomUUID();
    recorder.trace.question = trimmed;
    if (anchor) recorder.trace.selection = anchor;
    const report = () => {
      if (alive()) this.deps.onTrace(topicId, recorder.trace, false);
    };
    report();
    const tools = createWhiteboardTools({
      topicId,
      getOpenTopicId: this.deps.getOpenTopicId,
      repo: this.deps.repo,
      anchor,
      onDocument: (saved) => {
        toolSucceeded = true;
        if (alive()) this.deps.onTopic(saved);
      },
      onExplain: (text) => {
        explained = true;
        if (alive()) this.deps.onExplain?.(topicId, { text, anchor });
      },
      onToolStart: (name, input) => {
        recorder.toolStart(name, input);
        report();
      },
      onToolEnd: (name, outcome) => {
        recorder.toolEnd(name, outcome);
        report();
      },
      search: this.deps.search?.() ?? undefined,
    });

    let reply = "";
    let session: LanguageModelSession | null = null;
    try {
      const edited = this.nextPrompts.get(topicId);
      this.nextPrompts.delete(topicId);
      const created = edited
        ? await this.createEdited(model, topic, trimmed, anchor, edited, tools, abort.signal)
        : await this.createFitted(model, topic, trimmed, anchor, tools, abort.signal, alive);
      session = created.session;
      if (!alive()) return;
      recorder.trace.request = {
        initialPrompts: created.initialPrompts.map((message) => ({ ...message, content: capText(message.content) })),
        prompt: capText(created.prompt),
        tools: tools.map((tool) => tool.name),
        ...(anchor ? { selection: anchor } : {}),
        ...(edited ? { edited: true } : {}),
      };
      report();
      const onReasoning = (text: string) => {
        if (!alive() || abort.signal.aborted) return;
        recorder.addReasoning(text);
        report();
      };
      const stream = iterateText(session.promptStreaming(created.prompt, { signal: abort.signal, onReasoning }));
      for await (const chunk of untilAborted(stream, abort.signal)) {
        if (!alive() || abort.signal.aborted) break;
        reply += chunk;
        recorder.addText(chunk);
        report();
      }
      if (!alive()) return;
      if (abort.signal.aborted) throw Object.assign(new Error("Aborted"), { name: "AbortError" });

      const dumpedSvg = extractBoardSvg(reply);
      if (shouldUseEmptyBoardFallback({ boardWasEmpty, toolSucceeded, aborted: false, reply })) {
        await this.persist(topicId, (fresh) => {
          fresh.html = unfence(reply);
          const title = titleFromHtml(fresh.html);
          if (title) fresh.title = title;
        });
        toolSucceeded = true;
        recorder.trace.rawReply = reply;
        recorder.trace.fallback = "html";
      } else if (dumpedSvg) {
        const current = await this.deps.repo.get(topicId);
        if (current && current.svg === svgAtStart) {
          await this.persist(topicId, (fresh) => {
            fresh.svg = dumpedSvg;
          });
          toolSucceeded = true;
          recorder.trace.rawReply = reply;
          recorder.trace.fallback = "svg";
        }
      } else if (!toolSucceeded && !explained && !boardWasEmpty && options.note !== false && reply.trim() && !replyIsToolDump(reply)) {
        await this.persist(topicId, (fresh) => {
          fresh.html = insertNote(sourcesOf(fresh), anchor, { question: trimmed, reply: stripSelectionMarkers(unfence(reply)).trim() });
        });
        toolSucceeded = true;
        recorder.trace.rawReply = reply;
        recorder.trace.fallback = "note";
      }
      this.measure(recorder, session);
      if (!toolSucceeded && !explained) {
        recorder.trace.error = NOTHING_CHANGED;
        this.deps.onError(NOTHING_CHANGED);
      }
    } catch (error) {
      if (!alive()) return;
      const note = errorNote(error);
      if (note) this.deps.onError(note);
      const err = error as { name?: string; message?: string };
      recorder.trace.error = err?.name === "AbortError" ? "Stopped" : note ?? err?.message ?? "The request failed.";
      this.measure(recorder, session);
    } finally {
      session?.destroy();
      recorder.finish();
      if (alive()) this.deps.onTrace(topicId, recorder.trace, true);
      this.finish(alive);
    }
  }

  private finish(alive: () => boolean): void {
    if (!alive()) return;
    this.busy = false;
    this.abort = null;
    this.deps.onBusy(false);
  }

  private measure(recorder: TraceRecorder, session: LanguageModelSession | null): void {
    if (typeof session?.inputUsage === "number") recorder.trace.inputUsage = session.inputUsage;
    if (typeof session?.inputQuota === "number") recorder.trace.inputQuota = session.inputQuota;
  }

  /** Change the stored topic in place, if it is still the open one. */
  private async persist(topicId: string, change: (topic: TopicRecord) => void): Promise<void> {
    if (this.deps.getOpenTopicId() !== topicId) throw new Error("This topic is no longer open.");
    const topic = await this.deps.repo.get(topicId);
    if (!topic) throw new Error("This topic is no longer open.");
    change(topic);
    topic.updatedAt = Date.now();
    await this.deps.repo.put(topic);
    this.deps.onTopic(topic);
  }

  private options(tools: ToolDeclaration[], signal: AbortSignal, initialPrompts: PromptMessage[]): CreateOptions {
    const modelId = this.deps.modelId?.() ?? null;
    return { initialPrompts, tools, signal, reasoning: true, ...(modelId ? { model: modelId } : {}) };
  }

  /** A session from initial prompts edited in Debug mode, sent as they are. */
  private async createEdited(
    model: LanguageModelAPI,
    topic: TopicRecord,
    question: string,
    anchor: SelectionAnchor | null,
    initialPrompts: PromptMessage[],
    tools: ToolDeclaration[],
    signal: AbortSignal,
  ): Promise<{ session: LanguageModelSession; initialPrompts: PromptMessage[]; prompt: string }> {
    const { prompt } = this.build(topic, question, anchor);
    const session = await createSession(model, this.options(tools, signal, initialPrompts), signal);
    return { session, initialPrompts, prompt };
  }

  /** A session whose system prompt fits: the stored material is cut down until the model accepts it. */
  private async createFitted(
    model: LanguageModelAPI,
    topic: TopicRecord,
    question: string,
    anchor: SelectionAnchor | null,
    tools: ToolDeclaration[],
    signal: AbortSignal,
    alive: () => boolean,
  ): Promise<{ session: LanguageModelSession; initialPrompts: PromptMessage[]; prompt: string }> {
    let maxFullSections: number | undefined;
    let clipChars: number | undefined;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      if (!alive()) throw Object.assign(new Error("Aborted"), { name: "AbortError" });
      const built = this.build(topic, question, anchor, maxFullSections);
      const system = clipChars === undefined ? built.system : clipText(built.system, clipChars);
      const prompt = clipChars === undefined ? built.prompt : clipText(built.prompt, Math.max(256, Math.floor(clipChars / 4)));
      const initialPrompts: PromptMessage[] = [{ role: "system", content: system }];
      let session: LanguageModelSession;
      try {
        session = await createSession(model, {
          ...this.options(tools, signal, initialPrompts),
          monitor: (monitor) => {
            monitor.addEventListener("downloadprogress", (event) => {
              const loaded = (event as Event & { loaded?: number }).loaded;
              if (typeof loaded === "number") this.deps.onDownload(loaded);
            });
          },
        }, signal);
      } catch (error) {
        if ((error as { name?: string }).name !== "QuotaExceededError") throw error;
        maxFullSections = halveSections(maxFullSections, topic.materialMarkdown);
        clipChars = Math.floor((clipChars ?? system.length) / 2);
        continue;
      }
      const result = { session, initialPrompts, prompt };
      if (!session.measureInputUsage) return result;
      const assembled = `${system}\n${prompt}`;
      const measured = await settleWithin(session.measureInputUsage(assembled), signal, START_TIMEOUT_MS, START_TIMEOUT).catch(
        (error: unknown) => {
          session.destroy();
          throw error;
        },
      );
      const quota = session.inputQuota ?? this.deps.contextTokens?.() ?? 8192;
      // Leave room for the reply. Gemini 3.8 Flash accepts 1,048,576 input tokens; the session quota is that cap, or the user's, whichever is smaller.
      const limit = Math.max(256, quota - 1500);
      if (measured <= limit) return result;
      session.destroy();
      maxFullSections = halveSections(maxFullSections, topic.materialMarkdown);
      const ratio = limit / Math.max(measured, 1);
      clipChars = Math.max(256, Math.floor((clipChars ?? system.length) * ratio));
    }

    throw Object.assign(new Error("The lesson is over the model's limit."), { name: "QuotaExceededError" });
  }
}

function halveSections(maxFullSections: number | undefined, markdown: string): number {
  const current = maxFullSections ?? parseLesson(markdown).sections.length;
  return Math.floor(current / 2);
}

function clipText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const note = "\n\n[truncated to fit the context window]";
  return `${text.slice(0, Math.max(0, maxChars - note.length))}${note}`;
}

export type { CreateOptions };
