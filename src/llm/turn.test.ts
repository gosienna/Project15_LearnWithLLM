import { describe, expect, it } from "vitest";
import { createEmptyTopic, type TopicRepository } from "../storage/db.ts";
import type { CreateOptions, LanguageModelAPI, LanguageModelSession, TopicRecord } from "../types.ts";
import { FALLBACK_ASSISTANT, shouldUseEmptyBoardFallback, Conversation } from "./turn.ts";

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
  return `# Photosynthesis\n\n## Overview\n\n${"Plants store energy from light. ".repeat(20)}\n`;
}

describe("empty-board fallback", () => {
  const longLesson = lessonReply();

  it("fires only for an empty board, no successful tool, and a lesson-shaped reply", () => {
    expect(longLesson.length).toBeGreaterThan(400);
    const base = { boardWasEmpty: true, toolSucceeded: false, aborted: false, reply: longLesson };
    expect(shouldUseEmptyBoardFallback(base)).toBe(true);
    expect(shouldUseEmptyBoardFallback({ ...base, boardWasEmpty: false })).toBe(false);
    expect(shouldUseEmptyBoardFallback({ ...base, toolSucceeded: true })).toBe(false);
    expect(shouldUseEmptyBoardFallback({ ...base, aborted: true })).toBe(false);
    expect(shouldUseEmptyBoardFallback({ ...base, reply: "# Short" })).toBe(false);
    expect(shouldUseEmptyBoardFallback({ ...base, reply: "x".repeat(500) })).toBe(false);
  });
});

describe("conversation", () => {
  it("puts a tool write into the next session's system message", async () => {
    const topic = createEmptyTopic(1);
    const repo = memoryRepo([topic]);
    const creates: CreateOptions[] = [];
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
              const tool = options?.tools?.find((item) => item.name === "whiteboard_replace_document");
              if (!tool) throw new Error("missing replace tool");
              await tool.execute({
                markdown: "# Photosynthesis\n\n## Overview\n\nLeaves capture sunlight.\n",
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
    const first = creates[0]?.initialPrompts?.[0]?.content ?? "";
    const second = creates[1]?.initialPrompts?.[0]?.content ?? "";
    expect(first).toContain("The whiteboard is empty.");
    expect(second).toContain("Leaves capture sunlight.");
    const stored = repo.all().find((item) => item.id === topic.id);
    expect(stored?.documentMarkdown).toContain("Leaves capture sunlight.");
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
    expect(stored?.documentMarkdown).toContain("Plants store energy from light.");
    expect(stored?.messages.at(-1)?.content).toBe(FALLBACK_ASSISTANT);
    expect(stored?.title).toBe("Photosynthesis");
  });
});
