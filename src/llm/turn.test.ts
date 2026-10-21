import { describe, expect, it } from "vitest";
import { createEmptyTopic, type TopicRepository } from "../storage/db.ts";
import type { CreateOptions, LanguageModelAPI, LanguageModelSession, TopicRecord } from "../types.ts";
import { extractBoardSvg, FALLBACK_ASSISTANT, shouldUseEmptyBoardFallback, Conversation, type StreamState } from "./turn.ts";

function memoryRepo(initial: TopicRecord[]): TopicRepository & { all(): TopicRecord[] } {
  const map = new Map(initial.map((topic) => [topic.id, structuredClone(topic)]));
  return {
    all: () => [...map.values()],
    async list() {
      return [...map.values()].sort((a, b) => b.updatedAt - a.updatedAt);
    },
    async get(id) {
      const topic = map.get(id);
      return topic ? structuredClone(topic) : undefined;
    },
    async put(topic) {
      map.set(topic.id, structuredClone(topic));
    },
    async delete(id) {
      map.delete(id);
    },
    async mostRecent() {
      const rows = await this.list();
      return rows[0];
    },
  };
}

function lessonReply(): string {
  return `<h1>Photosynthesis</h1>\n<p>${"Plants store energy from light. ".repeat(20)}</p>\n`;
}

describe("empty-board fallback", () => {
  const longLesson = lessonReply();

  it("fires only for an empty board, no successful tool, and an html-shaped reply", () => {
    expect(longLesson.length).toBeGreaterThan(400);
    const base = { boardWasEmpty: true, toolSucceeded: false, aborted: false, reply: longLesson };
    expect(shouldUseEmptyBoardFallback(base)).toBe(true);
    expect(shouldUseEmptyBoardFallback({ ...base, boardWasEmpty: false })).toBe(false);
    expect(shouldUseEmptyBoardFallback({ ...base, toolSucceeded: true })).toBe(false);
    expect(shouldUseEmptyBoardFallback({ ...base, aborted: true })).toBe(false);
    expect(shouldUseEmptyBoardFallback({ ...base, reply: "# Short" })).toBe(false);
    expect(shouldUseEmptyBoardFallback({ ...base, reply: "x".repeat(500) })).toBe(false);
  });

  it("pulls an svg element out of a printed tool call", () => {
    const reply =
      '```tool_code\nwhiteboard_replace_document(content="Here is a circle: `<svg width=\\"100\\" height=\\"100\\">\\n  <circle cx=\\"50\\" cy=\\"50\\" r=\\"40\\" stroke=\\"black\\" stroke-width=\\"2\\" fill=\\"white\\"></circle>\\n</svg>`")\n```';
    const svg = extractBoardSvg(reply);
    expect(svg).toContain('<svg width="100" height="100">');
    expect(svg).toContain('<circle cx="50" cy="50" r="40"');
    expect(shouldUseEmptyBoardFallback({ boardWasEmpty: true, toolSucceeded: false, aborted: false, reply })).toBe(
      false,
    );
  });
});

describe("conversation", () => {
  it("puts a tool write into the next session's system message", async () => {
    const topic = createEmptyTopic(1);
    const repo = memoryRepo([topic]);
    const creates: CreateOptions[] = [];
    const source = "<h1>Photosynthesis</h1><p>Leaves capture sunlight.</p>";
    let openId = topic.id;
    const model: LanguageModelAPI = {
      async availability() {
        return "available";
      },
      async create(options) {
        creates.push(options ?? {});
        const session: LanguageModelSession = {
          async *promptStreaming() {
            if (creates.length === 1) {
              const tool = options?.tools?.find((item) => item.name === "whiteboard_set");
              if (!tool) throw new Error("missing set tool");
              await tool.execute({
                component: "html",
                source,
              });
            }
            yield "On the board.";
          },
          destroy() {},
          async measureInputUsage() {
            return 12;
          },
          inputUsage: 12,
          inputQuota: 8192,
        };
        return session;
      },
    };

    const conversation = new Conversation({
      repo,
      languageModel: () => model,
      modelId: () => "anthropic:haiku",
      getOpenTopicId: () => openId,
      onTopic: () => {},
      onStream: () => {},
      onError: () => {},
      onBusy: () => {},
      onDownload: () => {},
    });

    await conversation.send(topic.id, "Teach me photosynthesis");
    await conversation.send(topic.id, "What should I remember?");

    expect(creates).toHaveLength(2);
    expect(creates[0]?.model).toBe("anthropic:haiku");
    expect(creates[1]?.model).toBe("anthropic:haiku");
    const first = creates[0]?.initialPrompts?.[0]?.content ?? "";
    const second = creates[1]?.initialPrompts?.[0]?.content ?? "";
    expect(first).toContain("The whiteboard is empty.");
    expect(second).toContain(`html: ${source.length} characters`);
    expect(second).not.toContain("Leaves capture sunlight.");
    const stored = repo.all().find((item) => item.id === topic.id);
    expect(stored?.html).toContain("Leaves capture sunlight.");
    expect(stored?.messages.map((message) => message.content)).toEqual([
      "Teach me photosynthesis",
      "On the board.",
      "What should I remember?",
      "On the board.",
    ]);
  });

  it("moves an empty-board lesson out of the chat and into the document", async () => {
    const topic = createEmptyTopic(2);
    const repo = memoryRepo([topic]);
    const reply = lessonReply();
    const model: LanguageModelAPI = {
      async availability() {
        return "available";
      },
      async create() {
        const session: LanguageModelSession = {
          async *promptStreaming() {
            yield reply;
          },
          destroy() {},
          async measureInputUsage() {
            return 20;
          },
          inputQuota: 8192,
        };
        return session;
      },
    };
    const conversation = new Conversation({
      repo,
      languageModel: () => model,
      getOpenTopicId: () => topic.id,
      onTopic: () => {},
      onStream: () => {},
      onError: () => {},
      onBusy: () => {},
      onDownload: () => {},
    });

    await conversation.send(topic.id, "Teach me photosynthesis");
    const stored = repo.all()[0];
    expect(stored?.html).toContain("Plants store energy from light.");
    expect(stored?.messages.at(-1)?.content).toBe(FALLBACK_ASSISTANT);
    expect(stored?.title).toBe("Photosynthesis");
  });

  it("puts an svg printed as a tool call onto the whiteboard", async () => {
    const topic = createEmptyTopic(3);
    const repo = memoryRepo([topic]);
    const reply =
      '```tool_code\nwhiteboard_replace_document(content="`<svg width=\\"100\\" height=\\"100\\"><circle cx=\\"50\\" cy=\\"50\\" r=\\"40\\" stroke=\\"black\\" fill=\\"white\\"></circle></svg>`")\n```';
    const model: LanguageModelAPI = {
      async availability() {
        return "available";
      },
      async create() {
        const session: LanguageModelSession = {
          async *promptStreaming() {
            yield reply;
          },
          destroy() {},
        };
        return session;
      },
    };
    const conversation = new Conversation({
      repo,
      languageModel: () => model,
      getOpenTopicId: () => topic.id,
      onTopic: () => {},
      onStream: () => {},
      onError: () => {},
      onBusy: () => {},
      onDownload: () => {},
    });

    await conversation.send(topic.id, "Draw a circle");
    const stored = repo.all()[0];
    expect(stored?.svg).toContain("<circle");
    expect(stored?.svg).toContain('width="100"');
    expect(stored?.html).toBe("");
    expect(stored?.messages.at(-1)?.content).toBe(FALLBACK_ASSISTANT);
  });

  it("records each round, tool calls, and reasoning in the stored trace", async () => {
    const topic = createEmptyTopic(4);
    const repo = memoryRepo([topic]);
    const model: LanguageModelAPI = {
      async availability() {
        return "available";
      },
      async create(options) {
        expect(options?.reasoning).toBe(true);
        const session: LanguageModelSession = {
          async *promptStreaming(_input, promptOptions) {
            promptOptions?.onReasoning?.("Start with a title.");
            yield "Drawing ";
            yield "now.";
            const tool = options?.tools?.find((item) => item.name === "whiteboard_set");
            await tool?.execute({ component: "html", source: "<h1>Cells</h1>" });
            yield "Done.";
          },
          destroy() {},
          inputUsage: 300,
          inputQuota: 8192,
        };
        return session;
      },
    };
    const streams: (StreamState | null)[] = [];
    const conversation = new Conversation({
      repo,
      languageModel: () => model,
      modelId: () => "local:test",
      getOpenTopicId: () => topic.id,
      onTopic: () => {},
      onStream: (_id, state) => streams.push(state && structuredClone(state)),
      onError: () => {},
      onBusy: () => {},
      onDownload: () => {},
    });

    await conversation.send(topic.id, "Teach me cells");
    const message = repo.all()[0]?.messages.at(-1);
    expect(message?.content).toBe("Drawing now.Done.");
    expect(message?.trace?.modelId).toBe("local:test");
    expect(message?.trace?.request?.newSession).toBe(true);
    expect(message?.trace?.request?.initialPrompts?.[0]?.content).toContain("The whiteboard is empty.");
    expect(message?.trace?.request?.prompt).toBe("Teach me cells");
    expect(message?.trace?.inputUsage).toBe(300);
    expect(message?.trace?.events.map((event) => event.kind)).toEqual(["reasoning", "text", "tool", "text"]);
    const tool = message?.trace?.events[2];
    expect(tool?.kind === "tool" && tool.output).toEqual({ component: "html", characters: 14, title: "Cells" });
    expect(streams.some((state) => state?.toolActive && state.events.at(-1)?.kind === "tool")).toBe(true);
  });

  it("keeps the raw reply in the trace when the fallback replaces it", async () => {
    const topic = createEmptyTopic(5);
    const repo = memoryRepo([topic]);
    const reply = lessonReply();
    const model: LanguageModelAPI = {
      async availability() {
        return "available";
      },
      async create() {
        return {
          async *promptStreaming() {
            yield reply;
          },
          destroy() {},
        };
      },
    };
    const conversation = new Conversation({
      repo,
      languageModel: () => model,
      getOpenTopicId: () => topic.id,
      onTopic: () => {},
      onStream: () => {},
      onError: () => {},
      onBusy: () => {},
      onDownload: () => {},
    });

    await conversation.send(topic.id, "Teach me photosynthesis");
    const message = repo.all()[0]?.messages.at(-1);
    expect(message?.content).toBe(FALLBACK_ASSISTANT);
    expect(message?.trace?.rawReply).toBe(reply);
    expect(message?.trace?.fallback).toBe("html");
  });

  it("saves a stopped turn as an empty message that stays out of the next prompt", async () => {
    const topic = createEmptyTopic(6);
    const repo = memoryRepo([topic]);
    const creates: CreateOptions[] = [];
    let conversation: Conversation;
    const model: LanguageModelAPI = {
      async availability() {
        return "available";
      },
      async create(options) {
        creates.push(options ?? {});
        return {
          async *promptStreaming(_input, promptOptions) {
            if (creates.length === 1) {
              yield "Partial";
              conversation.stop();
              if (promptOptions?.signal?.aborted) return;
            }
            yield "Fine.";
          },
          destroy() {},
        };
      },
    };
    conversation = new Conversation({
      repo,
      languageModel: () => model,
      getOpenTopicId: () => topic.id,
      onTopic: () => {},
      onStream: () => {},
      onError: () => {},
      onBusy: () => {},
      onDownload: () => {},
    });

    await conversation.send(topic.id, "First");
    const stopped = repo.all()[0]?.messages.at(-1);
    expect(stopped?.role).toBe("assistant");
    expect(stopped?.content).toBe("");
    expect(stopped?.trace?.error).toBe("Stopped");
    expect(stopped?.trace?.events).toEqual([{ kind: "text", text: "Partial" }]);

    conversation.destroySession();
    await conversation.send(topic.id, "Second");
    const history = creates[1]?.initialPrompts?.slice(1) ?? [];
    expect(history.map((message) => message.content)).toEqual(["First"]);
  });

  it("uses a pinned system prompt and sends an edited request once, in a new session", async () => {
    const topic = { ...createEmptyTopic(7), systemPrompt: "Pinned instructions." };
    const repo = memoryRepo([topic]);
    const creates: CreateOptions[] = [];
    const model: LanguageModelAPI = {
      async availability() {
        return "available";
      },
      async create(options) {
        creates.push(options ?? {});
        return {
          async *promptStreaming() {
            yield "Ok.";
          },
          destroy() {},
        };
      },
    };
    const conversation = new Conversation({
      repo,
      languageModel: () => model,
      getOpenTopicId: () => topic.id,
      onTopic: () => {},
      onStream: () => {},
      onError: () => {},
      onBusy: () => {},
      onDownload: () => {},
    });

    expect(conversation.previewSystem(topic)).toEqual({ text: "Pinned instructions.", pinned: true });
    await conversation.send(topic.id, "One");
    expect(creates[0]?.initialPrompts?.[0]?.content).toBe("Pinned instructions.");

    const stored = repo.all()[0]!;
    expect(conversation.previewRequest(stored).newSession).toBe(false);
    const edited = [
      { role: "system" as const, content: "Edited system." },
      { role: "user" as const, content: "Pretend I asked about cells." },
    ];
    conversation.setNextRequest(topic.id, edited);
    expect(conversation.previewRequest(stored)).toEqual({ newSession: true, edited: true, initialPrompts: edited });
    await conversation.send(topic.id, "Two");
    expect(creates).toHaveLength(2);
    expect(creates[1]?.initialPrompts).toEqual(edited);
    const trace = repo.all()[0]?.messages.at(-1)?.trace;
    expect(trace?.request).toEqual({ newSession: true, initialPrompts: edited, prompt: "Two", edited: true });

    await conversation.send(topic.id, "Three");
    expect(creates).toHaveLength(2);
    expect(repo.all()[0]?.messages.at(-1)?.trace?.request).toEqual({ newSession: false, prompt: "Three" });
    expect(conversation.previewRequest(repo.all()[0]!).edited).toBe(false);
  });
});
