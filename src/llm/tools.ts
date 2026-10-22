import type { TopicRepository } from "../storage/db.ts";
import {
  BOARD_COMPONENTS,
  type BoardComponent,
  type BoardSources,
  type SearchFn,
  type SearchResponse,
  type SelectionAnchor,
  type ToolDeclaration,
  type TopicRecord,
} from "../types.ts";
import { insertHtml, snapshotBoard, stripSelectionMarkers, titleFromHtml } from "../ui/whiteboard.ts";

export const SOURCE_CHAR_LIMIT = 200_000;
export const VIEW_ALL_CHAR_LIMIT = 24_000;
export const EXPLAIN_CHAR_LIMIT = 4_000;

export interface ToolHost {
  topicId: string;
  getOpenTopicId: () => string | null;
  repo: TopicRepository;
  onDocument: (topic: TopicRecord) => void;
  /** Where the learner pointed for this ask; whiteboard_insert places new html after it. */
  anchor?: SelectionAnchor | null;
  /** whiteboard_explain: show text next to the selection without saving anything. */
  onExplain?: (text: string) => void;
  onToolStart?: (name: string, input: unknown) => void;
  onToolEnd?: (name: string, outcome: { output: unknown } | { error: string }) => void;
  /** Set when web search is on: web_search is offered and calls it. */
  search?: SearchFn;
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

function wrap(host: ToolHost, name: string, run: (input: unknown) => Promise<unknown>): ToolDeclaration["execute"] {
  return async (input: unknown) => {
    host.onToolStart?.(name, input);
    try {
      const output = await run(input);
      host.onToolEnd?.(name, { output });
      return output;
    } catch (error) {
      host.onToolEnd?.(name, { error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  };
}

/** Name, description, and schema sent with the session. Handlers stay in the app. */
export interface ModelToolInput {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const WHITEBOARD_TOOL_SPECS: ModelToolInput[] = [
  {
    name: "whiteboard_view",
    description:
      "Read one whiteboard source before editing it. Pass component html, css, js, svg, or json. Pass all only when you need every source and they are short.",
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
  },
  {
    name: "whiteboard_set",
    description:
      "Replace one whiteboard source: html, css, js, svg, or json. Use this to create the page or to rewrite most of one component; to add or change a part, use whiteboard_insert or whiteboard_edit. For svg, source is one raw <svg> element with width and height in pixels, not a sentence. json must be a JSON string, or empty when there is no data.",
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
  },
  {
    name: "whiteboard_insert",
    description:
      "Add new html to the page without rewriting it, such as a <section> with an example or an exercise. Pass only the new html. It goes right after the learner's selection, or at the end of the page when there is none.",
    inputSchema: {
      type: "object",
      properties: {
        html: {
          type: "string",
          description: "The new html fragment.",
        },
      },
      required: ["html"],
    },
  },
  {
    name: "whiteboard_edit",
    description:
      "Change part of one source without rewriting it. find is exact text that appears once in that source; replace is what takes its place. Use this for a few words or lines.",
    inputSchema: {
      type: "object",
      properties: {
        component: {
          type: "string",
          description: `One of ${COMPONENT_LIST}.`,
        },
        find: {
          type: "string",
          description: "Exact text from the source, long enough to appear only once.",
        },
        replace: {
          type: "string",
          description: "The text that replaces it.",
        },
      },
      required: ["component", "find", "replace"],
    },
  },
  {
    name: "whiteboard_explain",
    description:
      "Show a short plain-text explanation in a floating box next to the learner's selection, without changing the page. The learner closes it, and it is not saved. Use it to define a word or clarify the selected spot; use whiteboard_insert when the answer belongs in the lesson.",
    inputSchema: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "The explanation as plain text. Separate paragraphs with a blank line.",
        },
      },
      required: ["text"],
    },
  },
  {
    name: "whiteboard_snapshot",
    description:
      "Read the visible text of the current page, including the SVG labels. Call this to see what the learner sees. This does not save anything.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "whiteboard_store_material",
    description:
      "Save a markdown document of what the page teaches. Call this only when the learner asks to store the learning material. Do not change html, css, js, svg, or json.",
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
  },
];

export const WEB_SEARCH_TOOL_SPEC: ModelToolInput = {
  name: "web_search",
  description:
    "Search the web for current facts or things you are unsure of. Returns results with title, url, and snippet. Put the urls you use in a Sources list on the whiteboard.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "The search query." },
      max_results: { type: "integer", minimum: 1, maximum: 10, description: "How many results, 5 by default." },
    },
    required: ["query"],
  },
};

export const WHITEBOARD_TOOL_INFO = WHITEBOARD_TOOL_SPECS.map(({ name, description }) => ({ name, description }));

/** The tool specs an ask sends: the whiteboard tools, plus web_search when it is on. */
export function toolSpecs(webSearch: boolean): ModelToolInput[] {
  return webSearch ? [...WHITEBOARD_TOOL_SPECS, WEB_SEARCH_TOOL_SPEC] : WHITEBOARD_TOOL_SPECS;
}

export const SNIPPET_CHAR_LIMIT = 300;

/** Search results as the model reads them: short snippets, numbered for citing. */
export function compactResults(response: SearchResponse): Record<string, unknown> {
  return {
    query: response.query,
    provider: response.provider,
    ...(response.note ? { note: response.note } : {}),
    results: response.results.map((result, index) => ({
      n: index + 1,
      title: result.title,
      url: result.url,
      snippet: result.snippet.length > SNIPPET_CHAR_LIMIT ? `${result.snippet.slice(0, SNIPPET_CHAR_LIMIT)}…` : result.snippet,
    })),
  };
}

function webSearchTool(host: ToolHost, search: SearchFn): ToolDeclaration {
  return {
    ...WEB_SEARCH_TOOL_SPEC,
    execute: wrap(host, "web_search", async (input) => {
      const args = asObject(input);
      if (typeof args.query !== "string" || args.query.trim() === "") throw new Error("query must be a non-empty string.");
      const max = Math.min(10, Math.max(1, Math.floor(Number(args.max_results)) || 5));
      try {
        return compactResults(await search(args.query.trim(), max));
      } catch (error) {
        if ((error as { name?: string })?.name === "NotAllowedError") {
          throw new Error(`Web search is not available: ${(error as Error).message}`);
        }
        throw error;
      }
    }),
  };
}

function spec(name: string): ModelToolInput {
  const found = WHITEBOARD_TOOL_SPECS.find((tool) => tool.name === name);
  if (!found) throw new Error(`Missing whiteboard tool ${name}.`);
  return found;
}

export function createWhiteboardTools(host: ToolHost): ToolDeclaration[] {
  const tools = boardTools(host);
  return host.search ? [...tools, webSearchTool(host, host.search)] : tools;
}

function boardTools(host: ToolHost): ToolDeclaration[] {
  return [
    {
      ...spec("whiteboard_view"),
      execute: wrap(host, "whiteboard_view", async (input) => {
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
      ...spec("whiteboard_set"),
      execute: wrap(host, "whiteboard_set", async (input) => {
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
        // The model reads the source with the selection marked; a copied marker must not reach the page.
        const source = stripSelectionMarkers(args.source);
        const topic = await loadTopic(host);
        topic[args.component] = source;
        if (args.component === "html") {
          const title = titleFromHtml(source);
          if (title) topic.title = title;
        }
        await saveTopic(host, topic);
        const result: { component: BoardComponent; characters: number; title?: string } = {
          component: args.component,
          characters: source.length,
        };
        if (args.component === "html") result.title = topic.title;
        return result;
      }),
    },
    {
      ...spec("whiteboard_insert"),
      execute: wrap(host, "whiteboard_insert", async (input) => {
        const args = asObject(input);
        if (typeof args.html !== "string" || args.html.trim() === "") throw new Error("html must be a non-empty string.");
        const topic = await loadTopic(host);
        const inserted = insertHtml(sourcesOf(topic), host.anchor ?? null, stripSelectionMarkers(args.html));
        if (inserted.html.length > SOURCE_CHAR_LIMIT) throw new Error(`html would be longer than ${SOURCE_CHAR_LIMIT} characters.`);
        topic.html = inserted.html;
        const title = titleFromHtml(inserted.html);
        if (title) topic.title = title;
        await saveTopic(host, topic);
        return { placed: inserted.placed, characters: inserted.html.length };
      }),
    },
    {
      ...spec("whiteboard_edit"),
      execute: wrap(host, "whiteboard_edit", async (input) => {
        const args = asObject(input);
        if (typeof args.component !== "string" || !isComponent(args.component)) {
          throw new Error(`component must be ${COMPONENT_LIST}.`);
        }
        if (typeof args.find !== "string" || typeof args.replace !== "string") {
          throw new Error("find and replace must be strings.");
        }
        const find = stripSelectionMarkers(args.find);
        if (!find) throw new Error("find is empty.");
        const topic = await loadTopic(host);
        const current = topic[args.component];
        const at = current.indexOf(find);
        if (at === -1) throw new Error(`find does not appear in ${args.component}. Call whiteboard_view and copy the text exactly.`);
        if (current.indexOf(find, at + 1) !== -1) throw new Error("find appears more than once. Include more of the surrounding text.");
        const source = current.slice(0, at) + stripSelectionMarkers(args.replace) + current.slice(at + find.length);
        if (args.component === "json" && source.trim() !== "") {
          try {
            JSON.parse(source);
          } catch {
            throw new Error("The edit leaves json that does not parse.");
          }
        }
        topic[args.component] = source;
        if (args.component === "html") {
          const title = titleFromHtml(source);
          if (title) topic.title = title;
        }
        await saveTopic(host, topic);
        return { component: args.component, characters: source.length };
      }),
    },
    {
      ...spec("whiteboard_explain"),
      execute: wrap(host, "whiteboard_explain", async (input) => {
        const args = asObject(input);
        if (typeof args.text !== "string") throw new Error("text must be a string.");
        const text = stripSelectionMarkers(args.text).trim();
        if (!text) throw new Error("text is empty.");
        if (text.length > EXPLAIN_CHAR_LIMIT) throw new Error(`text is longer than ${EXPLAIN_CHAR_LIMIT} characters.`);
        if (host.getOpenTopicId() !== host.topicId) throw new Error("This topic is no longer open.");
        host.onExplain?.(text);
        return { shown: true, saved: false, characters: text.length };
      }),
    },
    {
      ...spec("whiteboard_snapshot"),
      execute: wrap(host, "whiteboard_snapshot", async (input) => {
        if (input !== undefined && input !== null) asObject(input);
        const topic = await loadTopic(host);
        return snapshotBoard(sourcesOf(topic));
      }),
    },
    {
      ...spec("whiteboard_store_material"),
      execute: wrap(host, "whiteboard_store_material", async (input) => {
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
