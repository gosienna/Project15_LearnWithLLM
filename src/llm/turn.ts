import { parseLesson } from "../document/markdown.ts";
import type { TopicRepository } from "../storage/db.ts";
import type {
  CreateOptions,
  DialogueMessage,
  LanguageModelAPI,
  LanguageModelSession,
  PromptMessage,
  ToolDeclaration,
  TopicRecord,
  TraceEvent,
} from "../types.ts";
import { boardIsEmpty, titleFromHtml } from "../ui/whiteboard.ts";
import { buildPrompt, estimateTokens } from "./system-prompt.ts";
import { createWhiteboardTools } from "./tools.ts";
import { capText, TraceRecorder } from "./trace.ts";

export const FALLBACK_ASSISTANT = "I put the lesson on the whiteboard.";

const SVG_MARKUP = /<svg\b[\s\S]*?<\/svg>/i;

export function extractBoardSvg(reply: string): string | null {
  const match = SVG_MARKUP.exec(reply);
  if (!match) return null;
  const svg = match[0].replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\'/g, "'");
  return /<svg\b/i.test(svg) ? svg : null;
}

function replyIsToolDump(reply: string): boolean {
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

export function errorNote(error: unknown): string | null {
  const err = error as { name?: string; message?: string };
  switch (err?.name) {
    case "NotAllowedError":
      return "This site is not allowed to use the model. Enable it in the extension and reload.";
    case "QuotaExceededError":
      return "The lesson or the conversation is over the model's limit. Shorten the request.";
    case "InvalidStateError":
      return "The session was lost. The next send creates a new one.";
    case "AbortError":
      return null;
    case "NetworkError":
    case "OperationError":
      return "The request failed. Send again.";
    default:
      return err?.message || "The request failed.";
  }
}

export interface StreamState {
  text: string | null;
  toolActive: boolean;
  /** The turn so far, for Debug mode. */
  events: TraceEvent[];
}

export interface ConversationDeps {
  repo: TopicRepository;
  languageModel: () => LanguageModelAPI | null;
  getOpenTopicId: () => string | null;
  onTopic: (topic: TopicRecord) => void;
  onStream: (topicId: string, stream: StreamState | null) => void;
  onError: (message: string | null) => void;
  onBusy: (busy: boolean) => void;
  onDownload: (ratio: number | null) => void;
  contextTokens?: () => number | undefined;
  modelId?: () => string | null;
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

export class Conversation {
  private session: LanguageModelSession | null = null;
  private sessionTopicId: string | null = null;
  private abort: AbortController | null = null;
  private epoch = 0;
  private busy = false;
  /** The initial prompts of a session created during the current turn, for its trace. */
  private createdPrompts: PromptMessage[] | null = null;
  /** Initial prompts edited in Debug mode, used once by the topic's next send. */
  private readonly nextPrompts = new Map<string, PromptMessage[]>();
  private resetAfterTurn = false;

  constructor(private readonly deps: ConversationDeps) {}

  get isBusy(): boolean {
    return this.busy;
  }

  destroySession(): void {
    this.session?.destroy();
    this.session = null;
    this.sessionTopicId = null;
  }

  /** Use these initial prompts, in a new session, for the topic's next send. Null discards them. */
  setNextRequest(topicId: string, prompts: PromptMessage[] | null): void {
    if (prompts) this.nextPrompts.set(topicId, prompts.map((message) => ({ ...message })));
    else this.nextPrompts.delete(topicId);
  }

  /** Start a new session on the next send, without cutting off a turn that is running. */
  resetSession(): void {
    if (this.busy) this.resetAfterTurn = true;
    else this.destroySession();
  }

  /** The system prompt the topic's next new session gets: the pinned one or the automatic one. */
  previewSystem(topic: TopicRecord): { text: string; pinned: boolean } {
    if (topic.systemPrompt !== undefined) return { text: topic.systemPrompt, pinned: true };
    const built = buildPrompt({
      sources: { html: topic.html, css: topic.css, js: topic.js, svg: topic.svg, json: topic.json },
      materialMarkdown: topic.materialMarkdown,
      messages: [],
      contextTokens: this.deps.contextTokens?.(),
    });
    return { text: built.system, pinned: false };
  }

  /** What the next send on this topic will use, if the learner sends now. */
  previewRequest(topic: TopicRecord): { newSession: boolean; edited: boolean; initialPrompts: PromptMessage[] } {
    const edited = this.nextPrompts.get(topic.id);
    if (edited) return { newSession: true, edited: true, initialPrompts: edited.map((message) => ({ ...message })) };
    const built = buildPrompt({
      sources: { html: topic.html, css: topic.css, js: topic.js, svg: topic.svg, json: topic.json },
      materialMarkdown: topic.materialMarkdown,
      messages: topic.messages,
      contextTokens: this.deps.contextTokens?.(),
      systemOverride: topic.systemPrompt,
    });
    return {
      newSession: !(this.session && this.sessionTopicId === topic.id),
      edited: false,
      initialPrompts: [{ role: "system", content: built.system }, ...built.history],
    };
  }

  stop(): void {
    this.abort?.abort();
  }

  cancelForSwitch(): void {
    this.epoch += 1;
    this.stop();
    this.destroySession();
    this.resetAfterTurn = false;
    this.busy = false;
    this.abort = null;
    this.deps.onBusy(false);
  }

  async send(topicId: string, text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed || this.busy) return;
    const epoch = this.epoch;
    const alive = () => epoch === this.epoch;
    const model = this.deps.languageModel();
    if (!model) {
      this.deps.onError(
        "The page cannot see a model. Enable this site in the extension and reload.",
      );
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

    const userMessage: DialogueMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: trimmed,
      createdAt: Date.now(),
    };
    topic.messages.push(userMessage);
    topic.updatedAt = Date.now();
    await this.deps.repo.put(topic);
    if (!alive()) {
      this.finish(alive);
      return;
    }
    this.deps.onTopic(topic);

    const boardWasEmpty = boardIsEmpty(topic);
    const svgAtStart = topic.svg;
    let toolSucceeded = false;
    let toolActive = false;
    const recorder = new TraceRecorder(this.deps.modelId?.() ?? null);
    const stream = (text: string | null, active: boolean) => {
      if (alive()) this.deps.onStream(topicId, { text, toolActive: active, events: recorder.events });
    };
    const tools = createWhiteboardTools({
      topicId,
      getOpenTopicId: this.deps.getOpenTopicId,
      repo: this.deps.repo,
      onDocument: (saved) => {
        toolSucceeded = true;
        if (alive()) this.deps.onTopic(saved);
      },
      onToolStart: (name, input) => {
        toolActive = true;
        recorder.toolStart(name, input);
        stream(reply ? reply : null, true);
      },
      onToolEnd: (name, outcome) => {
        toolActive = false;
        recorder.toolEnd(name, outcome);
        stream(reply, false);
      },
    });

    let reply = "";
    let session: LanguageModelSession | null = null;
    try {
      this.createdPrompts = null;
      const edited = this.nextPrompts.get(topicId);
      this.nextPrompts.delete(topicId);
      session = edited
        ? await this.createEdited(model, topic.id, edited, tools, abort.signal)
        : await this.ensureSession(model, topic, trimmed, tools, abort.signal, alive);
      if (!alive()) return;
      const sent = this.createdPrompts as PromptMessage[] | null;
      recorder.trace.request = {
        newSession: sent !== null,
        ...(sent ? { initialPrompts: sent.map((message) => ({ ...message, content: capText(message.content) })) } : {}),
        prompt: trimmed,
        ...(edited ? { edited: true } : {}),
      };
      stream("", toolActive);
      const onReasoning = (text: string) => {
        if (!alive() || abort.signal.aborted) return;
        recorder.addReasoning(text);
        stream(reply, toolActive);
      };
      for await (const chunk of iterateText(session.promptStreaming(trimmed, { signal: abort.signal, onReasoning }))) {
        if (!alive() || abort.signal.aborted) break;
        reply += chunk;
        recorder.addText(chunk);
        stream(reply, false);
      }
      if (!alive()) return;
      if (abort.signal.aborted) throw Object.assign(new Error("Aborted"), { name: "AbortError" });

      let assistant = reply;
      const dumpedSvg = extractBoardSvg(reply);
      if (
        shouldUseEmptyBoardFallback({
          boardWasEmpty,
          toolSucceeded,
          aborted: false,
          reply,
        })
      ) {
        await this.persistHtml(topicId, reply);
        toolSucceeded = true;
        assistant = FALLBACK_ASSISTANT;
        recorder.trace.rawReply = reply;
        recorder.trace.fallback = "html";
        stream(assistant, false);
      } else if (dumpedSvg) {
        const current = await this.deps.repo.get(topicId);
        if (current && current.svg === svgAtStart) {
          await this.persistSvg(topicId, dumpedSvg);
          toolSucceeded = true;
          recorder.trace.fallback = "svg";
          if (boardWasEmpty || replyIsToolDump(reply)) {
            assistant = FALLBACK_ASSISTANT;
            recorder.trace.rawReply = reply;
            stream(assistant, false);
          }
        }
      }

      this.measure(recorder, session);
      await this.persistAssistant(topicId, assistant, recorder, alive);
      if (alive()) this.deps.onStream(topicId, null);
      if (toolSucceeded) this.destroySession();
    } catch (error) {
      if (!alive()) return;
      this.deps.onStream(topicId, null);
      const note = errorNote(error);
      if (note) this.deps.onError(note);
      // Keep the failed turn's trace; an empty message is hidden in the chat and the prompt.
      const err = error as { name?: string; message?: string };
      recorder.trace.error = err?.name === "AbortError" ? "Stopped" : note ?? err?.message ?? "The request failed.";
      this.measure(recorder, session);
      await this.persistAssistant(topicId, "", recorder, alive).catch(() => {});
      if (err?.name === "InvalidStateError") this.destroySession();
    } finally {
      this.finish(alive);
    }
  }

  private finish(alive: () => boolean): void {
    if (!alive()) return;
    if (this.resetAfterTurn) {
      this.resetAfterTurn = false;
      this.destroySession();
    }
    this.busy = false;
    this.abort = null;
    this.deps.onBusy(false);
  }

  private measure(recorder: TraceRecorder, session: LanguageModelSession | null): void {
    if (typeof session?.inputUsage === "number") recorder.trace.inputUsage = session.inputUsage;
    if (typeof session?.inputQuota === "number") recorder.trace.inputQuota = session.inputQuota;
  }

  private async persistAssistant(
    topicId: string,
    content: string,
    recorder: TraceRecorder,
    alive: () => boolean,
  ): Promise<void> {
    const fresh = await this.deps.repo.get(topicId);
    if (!fresh || !alive()) return;
    fresh.messages.push({
      id: crypto.randomUUID(),
      role: "assistant",
      content,
      createdAt: Date.now(),
      trace: recorder.finish(),
    });
    fresh.updatedAt = Date.now();
    await this.deps.repo.put(fresh);
    this.deps.onTopic(fresh);
  }

  private async persistSvg(topicId: string, svg: string): Promise<void> {
    if (this.deps.getOpenTopicId() !== topicId) throw new Error("This topic is no longer open.");
    const topic = await this.deps.repo.get(topicId);
    if (!topic) throw new Error("This topic is no longer open.");
    topic.svg = svg;
    topic.updatedAt = Date.now();
    await this.deps.repo.put(topic);
    this.deps.onTopic(topic);
  }

  private async persistHtml(topicId: string, html: string): Promise<void> {
    if (this.deps.getOpenTopicId() !== topicId) throw new Error("This topic is no longer open.");
    const topic = await this.deps.repo.get(topicId);
    if (!topic) throw new Error("This topic is no longer open.");
    topic.html = html;
    const title = titleFromHtml(html);
    if (title) topic.title = title;
    topic.updatedAt = Date.now();
    await this.deps.repo.put(topic);
    this.deps.onTopic(topic);
  }

  /** A new session from initial prompts edited in Debug mode, sent as they are. */
  private async createEdited(
    model: LanguageModelAPI,
    topicId: string,
    initialPrompts: PromptMessage[],
    tools: ToolDeclaration[],
    signal: AbortSignal,
  ): Promise<LanguageModelSession> {
    this.destroySession();
    const modelId = this.deps.modelId?.() ?? null;
    const created = await model.create({
      initialPrompts,
      tools,
      signal,
      reasoning: true,
      ...(modelId ? { model: modelId } : {}),
    });
    this.session = created;
    this.sessionTopicId = topicId;
    this.createdPrompts = initialPrompts;
    return created;
  }

  private async ensureSession(
    model: LanguageModelAPI,
    topic: TopicRecord,
    userText: string,
    tools: ToolDeclaration[],
    signal: AbortSignal,
    alive: () => boolean,
  ): Promise<LanguageModelSession> {
    if (this.session && this.sessionTopicId === topic.id) return this.session;

    this.destroySession();
    const prior = topic.messages.slice(0, -1);
    let maxFullSections: number | undefined;
    let created: LanguageModelSession | null = null;

    for (let attempt = 0; attempt < 5; attempt += 1) {
      if (!alive()) throw Object.assign(new Error("Aborted"), { name: "AbortError" });
      const built = buildPrompt({
        sources: {
          html: topic.html,
          css: topic.css,
          js: topic.js,
          svg: topic.svg,
          json: topic.json,
        },
        materialMarkdown: topic.materialMarkdown,
        messages: prior,
        contextTokens: this.deps.contextTokens?.(),
        maxFullSections,
        systemOverride: topic.systemPrompt,
      });
      const initialPrompts = [{ role: "system" as const, content: built.system }, ...built.history];
      const modelId = this.deps.modelId?.() ?? null;
      created = await model.create({
        initialPrompts,
        tools,
        signal,
        reasoning: true,
        ...(modelId ? { model: modelId } : {}),
        monitor: (monitor) => {
          monitor.addEventListener("downloadprogress", (event) => {
            const loaded = (event as Event & { loaded?: number }).loaded;
            if (typeof loaded === "number") this.deps.onDownload(loaded);
          });
        },
      });
      this.session = created;
      this.sessionTopicId = topic.id;
      this.createdPrompts = initialPrompts;

      if (!created.measureInputUsage) return created;
      const assembled = [...initialPrompts.map((message) => message.content), userText].join("\n");
      const measured = await created.measureInputUsage(assembled);
      const quota = created.inputQuota ?? this.deps.contextTokens?.() ?? 8192;
      const limit = Math.max(1, quota - 1500);
      if (measured <= limit) return created;

      created.destroy();
      this.session = null;
      this.sessionTopicId = null;
      const lesson = parseLesson(topic.materialMarkdown);
      const currentCap = maxFullSections ?? lesson.sections.length;
      if (currentCap <= 0 && built.history.length === 0) {
        const oversized = await model.create({
          initialPrompts,
          tools,
          signal,
          reasoning: true,
          ...(modelId ? { model: modelId } : {}),
        });
        this.session = oversized;
        this.sessionTopicId = topic.id;
        return oversized;
      }
      maxFullSections = Math.floor(currentCap / 2);
      if (estimateTokens(assembled) <= limit && measured > limit) {
        maxFullSections = Math.max(0, (maxFullSections ?? 0) - 1);
      }
    }

    throw Object.assign(new Error("The lesson or the conversation is over the model's limit."), {
      name: "QuotaExceededError",
    });
  }
}

export type { CreateOptions };
