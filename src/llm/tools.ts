import type { TopicRepository } from "../storage/db.ts";
import { BOARD_COMPONENTS, type BoardComponent, type BoardSources, type ToolDeclaration, type TopicRecord } from "../types.ts";
import { snapshotBoard, titleFromHtml } from "../ui/whiteboard.ts";

export const SOURCE_CHAR_LIMIT = 200_000;
export const VIEW_ALL_CHAR_LIMIT = 24_000;

export interface ToolHost {
  topicId: string;
  getOpenTopicId: () => string | null;
  repo: TopicRepository;
  onDocument: (topic: TopicRecord) => void;
  onToolStart?: () => void;
  onToolEnd?: () => void;
}

const COMPONENT_LIST = BOARD_COMPONENTS.join(", ");

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

function isComponent(value: string): value is BoardComponent {
  return (BOARD_COMPONENTS as readonly string[]).includes(value);
}

function sourcesOf(topic: TopicRecord): BoardSources {
  return {
    html: topic.html,
    css: topic.css,
    js: topic.js,
    svg: topic.svg,
    json: topic.json,
  };
}

function lengths(topic: TopicRecord): Record<BoardComponent, number> {
  return {
    html: topic.html.length,
    css: topic.css.length,
    js: topic.js.length,
    svg: topic.svg.length,
    json: topic.json.length,
  };
}

async function loadTopic(host: ToolHost): Promise<TopicRecord> {
  if (host.getOpenTopicId() !== host.topicId) throw new Error("This topic is no longer open.");
  const topic = await host.repo.get(host.topicId);
  if (!topic || host.getOpenTopicId() !== host.topicId) throw new Error("This topic is no longer open.");
  return topic;
}

async function saveTopic(host: ToolHost, topic: TopicRecord): Promise<void> {
  if (host.getOpenTopicId() !== host.topicId) throw new Error("This topic is no longer open.");
  topic.updatedAt = Date.now();
  await host.repo.put(topic);
  if (host.getOpenTopicId() !== host.topicId) throw new Error("This topic is no longer open.");
  host.onDocument(topic);
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

export const WHITEBOARD_TOOL_INFO: { name: string; description: string }[] = [
  {
    name: "whiteboard_view",
    description:
      "Read one whiteboard source before editing it. Pass component html, css, js, svg, or json. Pass all only when you need every source and they are short.",
  },
  {
    name: "whiteboard_set",
    description:
      "Replace one whiteboard source: html, css, js, svg, or json. Use this to create the page and to change one component. For svg, source is one raw <svg> element with width and height in pixels, not a sentence. json must be a JSON string, or empty when there is no data.",
  },
  {
    name: "whiteboard_snapshot",
    description:
      "Read the visible text of the current page, including the SVG labels. Call this to see what the learner sees. This does not save anything.",
  },
  {
    name: "whiteboard_store_material",
    description:
      "Save a markdown document of what the page teaches. Call this only when the learner asks to store the learning material. Do not change html, css, js, svg, or json.",
  },
];

function toolDescription(name: string): string {
  return WHITEBOARD_TOOL_INFO.find((tool) => tool.name === name)?.description ?? "";
}

export function createWhiteboardTools(host: ToolHost): ToolDeclaration[] {
  return [
    {
      name: "whiteboard_view",
      description: toolDescription("whiteboard_view"),
      inputSchema: {
        type: "object",
        properties: {
          component: {
            type: "string",
            description: `One of ${COMPONENT_LIST}, or all.`,
          },
        },
        required: ["component"],
      },
      execute: wrap(host, async (input) => {
        const args = asObject(input);
        if (typeof args.component !== "string") throw new Error("component must be a string.");
        const topic = await loadTopic(host);
        if (args.component === "all") {
          const size = BOARD_COMPONENTS.reduce((sum, key) => sum + topic[key].length, 0);
          if (size > VIEW_ALL_CHAR_LIMIT) {
            return {
              truncated: true,
              lengths: lengths(topic),
              message: "The sources are too long to return together. Call whiteboard_view for one component.",
            };
          }
          return sourcesOf(topic);
        }
        if (!isComponent(args.component)) {
          throw new Error(`component must be ${COMPONENT_LIST}, or all.`);
        }
        return { component: args.component, source: topic[args.component] };
      }),
    },
    {
      name: "whiteboard_set",
      description: toolDescription("whiteboard_set"),
      inputSchema: {
        type: "object",
        properties: {
          component: {
            type: "string",
            description: `One of ${COMPONENT_LIST}.`,
          },
          source: {
            type: "string",
            description: "The full replacement for that component.",
          },
        },
        required: ["component", "source"],
      },
      execute: wrap(host, async (input) => {
        const args = asObject(input);
        if (typeof args.component !== "string" || !isComponent(args.component)) {
          throw new Error(`component must be ${COMPONENT_LIST}.`);
        }
        if (typeof args.source !== "string") throw new Error("source must be a string.");
        if (args.source.length > SOURCE_CHAR_LIMIT) {
          throw new Error(`${args.component} is longer than ${SOURCE_CHAR_LIMIT} characters.`);
        }
        if (args.component === "json" && args.source.trim() !== "") {
          try {
            JSON.parse(args.source);
          } catch {
            throw new Error("json must be empty or a JSON string.");
          }
        }
        const topic = await loadTopic(host);
        topic[args.component] = args.source;
        if (args.component === "html") {
          const title = titleFromHtml(args.source);
          if (title) topic.title = title;
        }
        await saveTopic(host, topic);
        const result: { component: BoardComponent; characters: number; title?: string } = {
          component: args.component,
          characters: args.source.length,
        };
        if (args.component === "html") result.title = topic.title;
        return result;
      }),
    },
    {
      name: "whiteboard_snapshot",
      description: toolDescription("whiteboard_snapshot"),
      inputSchema: {
        type: "object",
        properties: {},
      },
      execute: wrap(host, async (input) => {
        if (input !== undefined && input !== null) asObject(input);
        const topic = await loadTopic(host);
        return snapshotBoard(sourcesOf(topic));
      }),
    },
    {
      name: "whiteboard_store_material",
      description: toolDescription("whiteboard_store_material"),
      inputSchema: {
        type: "object",
        properties: {
          markdown: {
            type: "string",
            description: "The learning material as markdown.",
          },
        },
        required: ["markdown"],
      },
      execute: wrap(host, async (input) => {
        const args = asObject(input);
        if (typeof args.markdown !== "string") throw new Error("markdown must be a string.");
        if (args.markdown.trim() === "") throw new Error("markdown is empty.");
        if (args.markdown.length > SOURCE_CHAR_LIMIT) {
          throw new Error(`markdown is longer than ${SOURCE_CHAR_LIMIT} characters.`);
        }
        const topic = await loadTopic(host);
        topic.materialMarkdown = args.markdown;
        await saveTopic(host, topic);
        return { stored: true, characters: args.markdown.length };
      }),
    },
  ];
}
