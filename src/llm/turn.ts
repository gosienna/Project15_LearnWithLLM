import { parseLesson } from "../document/markdown.ts";
import { replaceDocument } from "../document/ops.ts";
import type { TopicRepository } from "../storage/db.ts";
import type {
  CreateOptions,
  DialogueMessage,
  LanguageModelAPI,
  LanguageModelSession,
  ToolDeclaration,
  TopicRecord,
} from "../types.ts";
import { buildPrompt, estimateTokens } from "./system-prompt.ts";
import { createWhiteboardTools } from "./tools.ts";

export const FALLBACK_ASSISTANT = "I put the lesson on the whiteboard.";

export function shouldUseEmptyBoardFallback(input: {
  boardWasEmpty: boolean;
  toolSucceeded: boolean;
  aborted: boolean;
  reply: string;
}): boolean {
  if (!input.boardWasEmpty || input.toolSucceeded || input.aborted) return false;
  if (input.reply.length <= 400) return false;
  return input.reply.split(/\r?\n/).some((line) => /^# /.test(line));
}

export function errorNote(error: unknown): string | null {
  const err = error as { name?: string; message?: string };
  switch (err?.name) {
    case "NotAllowedError":
      return "The site is not allowed to use the model. Enable it in the Local LLM extension and reload.";
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
  contextTokens?: number;
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

  constructor(private readonly deps: ConversationDeps) {}

  get isBusy(): boolean {
    return this.busy;
  }

  destroySession(): void {
    this.session?.destroy();
    this.session = null;
    this.sessionTopicId = null;
  }

  stop(): void {
    this.abort?.abort();
  }

  cancelForSwitch(): void {
    this.epoch += 1;
    this.stop();
    this.destroySession();
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
        "The page cannot see the local model. Enable this site in the Local LLM extension and reload.",
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

    const boardWasEmpty = topic.documentMarkdown.trim() === "";
    let toolSucceeded = false;
    let toolActive = false;
    const tools = createWhiteboardTools({
      topicId,
      getOpenTopicId: this.deps.getOpenTopicId,
      repo: this.deps.repo,
      onDocument: (saved) => {
        toolSucceeded = true;
        if (alive()) this.deps.onTopic(saved);
      },
      onToolStart: () => {
        toolActive = true;
        if (!alive()) return;
        this.deps.onStream(topicId, { text: reply ? reply : null, toolActive: true });
      },
      onToolEnd: () => {
        toolActive = false;
        if (!alive()) return;
        this.deps.onStream(topicId, { text: reply, toolActive: false });
      },
    });

    let reply = "";
    try {
      const session = await this.ensureSession(model, topic, trimmed, tools, abort.signal, alive);
      if (!alive()) return;
      this.deps.onStream(topicId, { text: "", toolActive });
      for await (const chunk of iterateText(session.promptStreaming(trimmed, { signal: abort.signal }))) {
        if (!alive() || abort.signal.aborted) break;
        reply += chunk;
        this.deps.onStream(topicId, { text: reply, toolActive: false });
      }
      if (!alive()) return;
      if (abort.signal.aborted) throw Object.assign(new Error("Aborted"), { name: "AbortError" });

      let assistant = reply;
      if (
        shouldUseEmptyBoardFallback({
          boardWasEmpty,
          toolSucceeded,
          aborted: false,
          reply,
        })
      ) {
        const replaced = replaceDocument(reply);
        await this.persistMarkdown(topicId, replaced.markdown);
        toolSucceeded = true;
        assistant = FALLBACK_ASSISTANT;
        this.deps.onStream(topicId, { text: assistant, toolActive: false });
      }

      const fresh = await this.deps.repo.get(topicId);
      if (fresh && alive()) {
        fresh.messages.push({
          id: crypto.randomUUID(),
          role: "assistant",
          content: assistant,
          createdAt: Date.now(),
        });
        fresh.updatedAt = Date.now();
        await this.deps.repo.put(fresh);
        this.deps.onTopic(fresh);
        this.deps.onStream(topicId, null);
      }
      if (toolSucceeded) this.destroySession();
    } catch (error) {
      if (!alive()) return;
      this.deps.onStream(topicId, null);
      const note = errorNote(error);
      if (note) this.deps.onError(note);
      if ((error as { name?: string }).name === "InvalidStateError") this.destroySession();
    } finally {
      this.finish(alive);
    }
  }

  private finish(alive: () => boolean): void {
    if (!alive()) return;
    this.busy = false;
    this.abort = null;
    this.deps.onBusy(false);
  }

  private async persistMarkdown(topicId: string, markdown: string): Promise<void> {
    if (this.deps.getOpenTopicId() !== topicId) throw new Error("This topic is no longer open.");
    const topic = await this.deps.repo.get(topicId);
    if (!topic) throw new Error("This topic is no longer open.");
    const lesson = parseLesson(markdown);
    topic.documentMarkdown = markdown;
    topic.title = lesson.title.trim() || "New topic";
    topic.updatedAt = Date.now();
    await this.deps.repo.put(topic);
    this.deps.onTopic(topic);
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
        markdown: topic.documentMarkdown,
        messages: prior,
        contextTokens: this.deps.contextTokens,
        maxFullSections,
      });
      const initialPrompts = [{ role: "system" as const, content: built.system }, ...built.history];
      created = await model.create({
        initialPrompts,
        tools,
        signal,
        monitor: (monitor) => {
          monitor.addEventListener("downloadprogress", (event) => {
            const loaded = (event as Event & { loaded?: number }).loaded;
            if (typeof loaded === "number") this.deps.onDownload(loaded);
          });
        },
      });
      this.session = created;
      this.sessionTopicId = topic.id;

      if (!created.measureInputUsage) return created;
      const assembled = [...initialPrompts.map((message) => message.content), userText].join("\n");
      const measured = await created.measureInputUsage(assembled);
      const quota = created.inputQuota ?? this.deps.contextTokens ?? 8192;
      const limit = Math.max(1, quota - 1500);
      if (measured <= limit) return created;

      created.destroy();
      this.session = null;
      this.sessionTopicId = null;
      const lesson = parseLesson(topic.documentMarkdown);
      const currentCap = maxFullSections ?? lesson.sections.length;
      if (currentCap <= 0 && built.history.length === 0) {
        const oversized = await model.create({ initialPrompts, tools, signal });
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
