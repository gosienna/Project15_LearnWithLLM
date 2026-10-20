import { parseLesson } from "../document/markdown.ts";
import { deleteSection, insertSection, readSection, replaceDocument, replaceSection } from "../document/ops.ts";
import type { TopicRepository } from "../storage/db.ts";
import type { ToolDeclaration, TopicRecord } from "../types.ts";

export interface ToolHost {
  topicId: string;
  getOpenTopicId: () => string | null;
  repo: TopicRepository;
  onDocument: (topic: TopicRecord) => void;
  onToolStart?: () => void;
  onToolEnd?: () => void;
}

function asObject(input: unknown): Record<string, unknown> {
  let value = input;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      throw new Error("Tool input must be an object.");
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Tool input must be an object.");
  }
  return value as Record<string, unknown>;
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${name} must be a string.`);
  return value;
}

async function saveMarkdown(host: ToolHost, markdown: string): Promise<TopicRecord> {
  if (host.getOpenTopicId() !== host.topicId) throw new Error("This topic is no longer open.");
  const topic = await host.repo.get(host.topicId);
  if (!topic) throw new Error("This topic is no longer open.");
  if (host.getOpenTopicId() !== host.topicId) throw new Error("This topic is no longer open.");
  const lesson = parseLesson(markdown);
  topic.documentMarkdown = markdown;
  topic.title = lesson.title.trim() || "New topic";
  topic.updatedAt = Date.now();
  await host.repo.put(topic);
  host.onDocument(topic);
  return topic;
}

function wrap(host: ToolHost, run: (input: unknown) => Promise<unknown>): ToolDeclaration["execute"] {
  return async (input: unknown) => {
    host.onToolStart?.();
    try {
      return await run(input);
    } finally {
      host.onToolEnd?.();
    }
  };
}

export function createWhiteboardTools(host: ToolHost): ToolDeclaration[] {
  return [
    {
      name: "whiteboard_read",
      description:
        "Read the lesson. Call this before editing when the system message lists section ids that were omitted, or when you need the current body of one section.",
      inputSchema: {
        type: "object",
        properties: {
          sectionId: {
            type: "string",
            description: "Section to return. Omit for the title and the list of section ids and headings.",
          },
        },
      },
      execute: wrap(host, async (input) => {
        if (host.getOpenTopicId() !== host.topicId) throw new Error("This topic is no longer open.");
        const topic = await host.repo.get(host.topicId);
        if (!topic) throw new Error("This topic is no longer open.");
        const args = input === undefined ? {} : asObject(input);
        return readSection(topic.documentMarkdown, optionalString(args.sectionId, "sectionId"));
      }),
    },
    {
      name: "whiteboard_replace_document",
      description:
        "Replace the entire lesson. Use this for the first lesson on an empty board, or when the learner asks to start the lesson over.",
      inputSchema: {
        type: "object",
        properties: {
          markdown: {
            type: "string",
            description: "Full lesson in markdown. Start with a single # title. Use ## headings for sections.",
          },
        },
        required: ["markdown"],
      },
      execute: wrap(host, async (input) => {
        const args = asObject(input);
        if (typeof args.markdown !== "string") throw new Error("markdown must be a string.");
        const replaced = replaceDocument(args.markdown);
        await saveMarkdown(host, replaced.markdown);
        return { title: replaced.title, sections: replaced.sections.slice(0, 80) };
      }),
    },
    {
      name: "whiteboard_replace_section",
      description:
        "Replace one section's heading and body. Use this for corrections and expansions of a part that already exists.",
      inputSchema: {
        type: "object",
        properties: {
          sectionId: { type: "string" },
          heading: { type: "string" },
          body: { type: "string", description: "Markdown body, without the heading line." },
        },
        required: ["sectionId", "body"],
      },
      execute: wrap(host, async (input) => {
        const args = asObject(input);
        if (typeof args.sectionId !== "string") throw new Error("sectionId must be a string.");
        if (typeof args.body !== "string") throw new Error("body must be a string.");
        const topic = await host.repo.get(host.topicId);
        if (!topic || host.getOpenTopicId() !== host.topicId) throw new Error("This topic is no longer open.");
        const markdown = replaceSection(topic.documentMarkdown, {
          sectionId: args.sectionId,
          body: args.body,
          heading: optionalString(args.heading, "heading"),
        });
        const saved = await saveMarkdown(host, markdown);
        const lesson = parseLesson(saved.documentMarkdown);
        const section = lesson.sections.find((item) => item.id === args.sectionId);
        if (!section) throw new Error(`Unknown section "${args.sectionId}".`);
        return { id: section.id, heading: section.heading };
      }),
    },
    {
      name: "whiteboard_insert_section",
      description: "Add a section. Use this when the learner wants new material kept on the board.",
      inputSchema: {
        type: "object",
        properties: {
          afterSectionId: {
            type: "string",
            description: "Insert after this section. Omit to insert after the title.",
          },
          heading: { type: "string" },
          body: { type: "string" },
          level: { type: "integer", description: "2 or 3. Default 2." },
        },
        required: ["heading", "body"],
      },
      execute: wrap(host, async (input) => {
        const args = asObject(input);
        if (typeof args.heading !== "string") throw new Error("heading must be a string.");
        if (typeof args.body !== "string") throw new Error("body must be a string.");
        if (args.level !== undefined && args.level !== 2 && args.level !== 3) {
          throw new Error("level must be 2 or 3.");
        }
        const topic = await host.repo.get(host.topicId);
        if (!topic || host.getOpenTopicId() !== host.topicId) throw new Error("This topic is no longer open.");
        const inserted = insertSection(topic.documentMarkdown, {
          heading: args.heading,
          body: args.body,
          afterSectionId: optionalString(args.afterSectionId, "afterSectionId"),
          level: args.level as 2 | 3 | undefined,
        });
        await saveMarkdown(host, inserted.markdown);
        return { id: inserted.id, heading: inserted.heading, afterSectionId: inserted.afterSectionId };
      }),
    },
    {
      name: "whiteboard_delete_section",
      description: "Remove one section. Use this only when the learner asks to remove material.",
      inputSchema: {
        type: "object",
        properties: {
          sectionId: { type: "string" },
        },
        required: ["sectionId"],
      },
      execute: wrap(host, async (input) => {
        const args = asObject(input);
        if (typeof args.sectionId !== "string") throw new Error("sectionId must be a string.");
        const topic = await host.repo.get(host.topicId);
        if (!topic || host.getOpenTopicId() !== host.topicId) throw new Error("This topic is no longer open.");
        const removed = deleteSection(topic.documentMarkdown, args.sectionId);
        await saveMarkdown(host, removed.markdown);
        return { deleted: removed.deleted, sections: removed.sections };
      }),
    },
  ];
}
