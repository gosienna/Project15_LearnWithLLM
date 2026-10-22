// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { createEmptyTopic, type TopicRepository } from "../storage/db.ts";
import type { CreateOptions, LanguageModelAPI, LanguageModelSession, SelectionAnchor, TopicRecord, TurnTrace } from "../types.ts";
import {
  errorNote,
  extractBoardSvg,
  NOTHING_CHANGED,
  shouldUseEmptyBoardFallback,
  START_TIMEOUT,
  START_TIMEOUT_MS,
  Tutor,
  unfence,
  type TutorDeps,
} from "./turn.ts";

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

/** A model whose sessions run `script` for each prompt. Records every create and destroy. */
function scriptedModel(
  script: (options: CreateOptions, input: string, promptOptions?: { signal?: AbortSignal; onReasoning?: (text: string) => void }) => AsyncGenerator<string>,
  extra: Partial<LanguageModelSession> = {},
) {
  const creates: CreateOptions[] = [];
  const prompts: string[] = [];
  let destroyed = 0;
  const model: LanguageModelAPI = {
    async availability() {
      return "available";
    },
    async create(options) {
      creates.push(options ?? {});
      return {
        promptStreaming(input, promptOptions) {
          prompts.push(input);
          return script(options ?? {}, input, promptOptions);
        },
        destroy() {
          destroyed += 1;
        },
        ...extra,
      };
    },
  };
  return { model, creates, prompts, destroyed: () => destroyed };
}

function tutorFor(topic: TopicRecord, model: LanguageModelAPI, overrides: Partial<TutorDeps> = {}) {
  const repo = memoryRepo([topic]);
  const errors: (string | null)[] = [];
  const traces: { trace: TurnTrace; done: boolean }[] = [];
  const tutor = new Tutor({
    repo,
    languageModel: () => model,
    getOpenTopicId: () => topic.id,
    onTopic: () => {},
    onTrace: (_id, trace, done) => traces.push({ trace, done }),
    onError: (message) => errors.push(message),
    onBusy: () => {},
    onDownload: () => {},
    ...overrides,
  });
  return { tutor, repo, errors, traces };
}

async function callTool(options: CreateOptions, name: string, input: unknown): Promise<unknown> {
  const tool = options.tools?.find((item) => item.name === name);
  if (!tool) throw new Error(`missing ${name}`);
  return tool.execute(input);
}

const anchor: SelectionAnchor = {
  kind: "text",
  component: "html",
  selector: "body > p:nth-of-type(1)",
  tag: "p",
  quote: { exact: "chlorophyll", prefix: "Leaves hold ", suffix: "." },
  outerHTML: "<p>Leaves hold chlorophyll.</p>",
  rect: { x: 0, y: 0, width: 10, height: 10 },
};

describe("fitting a lesson to the model quota", () => {
  it("cuts the prompt until Gemini's session accepts it", async () => {
    const topic = {
      ...createEmptyTopic(11),
      materialMarkdown: ["# Cells", ...Array.from({ length: 6 }, (_, n) => `## Part ${n}\n\n${"mitochondria ".repeat(400)}`)].join("\n\n"),
    };
    const creates: CreateOptions[] = [];
    const model: LanguageModelAPI = {
      async availability() {
        return "available";
      },
      async create(options) {
        creates.push(options ?? {});
        const system = options?.initialPrompts?.[0]?.content ?? "";
        if (system.length > 8000) throw Object.assign(new Error("Initial prompts exceed the context window"), { name: "QuotaExceededError" });
        return {
          inputQuota: 2500,
          async measureInputUsage(input: string) {
            return Math.ceil(input.length / 4);
          },
          promptStreaming() {
            return (async function* () {
              yield "On the board.";
            })();
          },
          destroy() {},
        };
      },
    };
    const { tutor, errors } = tutorFor(topic, model, { contextTokens: () => 1_048_576, modelId: () => "gemini:gemini-3.8-flash" });

    await tutor.ask(topic.id, "Teach me cells");

    expect(errors.some((message) => message?.includes("over the model's limit"))).toBe(false);
    const system = creates.at(-1)?.initialPrompts?.[0]?.content ?? "";
    expect(Math.ceil(`${system}\nTeach me cells`.length / 4)).toBeLessThanOrEqual(1000);
    expect(creates.length).toBeGreaterThan(1);
  });
});

describe("errorNote", () => {
  it("shows the provider's message for a rate limit, even from a cut-off body", () => {
    const body = '{ "error": { "code": 429, "message": "You exceeded your current quota, please check your plan.\\n* Quota ex';
    const note = errorNote({ name: "QuotaExceededError", message: `Provider rate limit or quota exceeded: ${body}` });
    expect(note).toBe("The provider's rate limit or quota is used up: You exceeded your current quota, please check your plan. * Quota ex");
  });

  it("keeps the lesson-size note for quota errors that are not from the provider", () => {
    expect(errorNote({ name: "QuotaExceededError", message: "The lesson is over the model's limit." })).toBe(
      "The lesson or the conversation is over the model's limit. Shorten the request.",
    );
  });
});

describe("unfence", () => {
  it("takes the code out of a fenced reply and leaves other text alone", () => {
    expect(unfence("```html\n<h1>Hi</h1>\n```")).toBe("<h1>Hi</h1>");
    expect(unfence("  ```\n<p>x</p>```  ")).toBe("<p>x</p>");
    expect(unfence("<h1>Hi</h1>")).toBe("<h1>Hi</h1>");
    expect(unfence("Text ```js\nx\n``` more")).toBe("Text ```js\nx\n``` more");
  });
});

describe("tutor", () => {
  it("offers web_search and its instructions only while search is on", async () => {
    const topic = createEmptyTopic(1);
    const searched: string[] = [];
    const { model, creates } = scriptedModel(async function* (options) {
      if (options.tools?.some((tool) => tool.name === "web_search")) {
        const found = (await callTool(options, "web_search", { query: "latest Mars rover" })) as { results: { url: string }[] };
        await callTool(options, "whiteboard_set", { component: "html", source: `<a href="${found.results[0]!.url}">source</a>` });
      }
      yield "done";
    });
    let on = true;
    const { tutor, repo } = tutorFor(topic, model, {
      search: () =>
        on
          ? async (query) => {
              searched.push(query);
              return { query, provider: "tavily", results: [{ title: "R", url: "https://nasa.example/", snippet: "s", score: 1 }] };
            }
          : null,
    });

    await tutor.ask(topic.id, "What is the latest Mars rover?");
    on = false;
    await tutor.ask(topic.id, "And before that?");

    expect(searched).toEqual(["latest Mars rover"]);
    expect(repo.all()[0]?.html).toContain('<a href="https://nasa.example/">source</a>');
    expect(creates[0]?.initialPrompts?.[0]?.content).toContain("# Web search");
    expect(creates[1]?.tools?.some((tool) => tool.name === "web_search")).toBe(false);
    expect(creates[1]?.initialPrompts?.[0]?.content).not.toContain("# Web search");
  });

  it("records the offered tool names in the trace", async () => {
    const topic = createEmptyTopic(1);
    const { model } = scriptedModel(async function* () {
      yield "done";
    });
    const { tutor, traces } = tutorFor(topic, model, {
      search: () => async (query) => ({ query, provider: "tavily", results: [] }),
    });

    await tutor.ask(topic.id, "What is new?");

    expect(traces.at(-1)?.trace.request?.tools).toContain("web_search");
    expect(traces.at(-1)?.trace.request?.tools).toContain("whiteboard_set");
  });

  it("creates a new session with only a system prompt for every ask and saves only the board", async () => {
    const topic = createEmptyTopic(1);
    const source = "<h1>Photosynthesis</h1><p>Leaves capture sunlight.</p>";
    const { model, creates, prompts, destroyed } = scriptedModel(async function* (options, input) {
      if (input === "Teach me photosynthesis") await callTool(options, "whiteboard_set", { component: "html", source });
      else await callTool(options, "whiteboard_set", { component: "css", source: "p { color: green; }" });
      yield "On the board.";
    });
    const { tutor, repo } = tutorFor(topic, model, { modelId: () => "anthropic:haiku" });

    await tutor.ask(topic.id, "Teach me photosynthesis");
    await tutor.ask(topic.id, "What should I remember?");

    expect(creates).toHaveLength(2);
    expect(destroyed()).toBe(2);
    expect(creates.map((options) => options.model)).toEqual(["anthropic:haiku", "anthropic:haiku"]);
    expect(creates.map((options) => options.initialPrompts?.length)).toEqual([1, 1]);
    expect(creates[0]?.initialPrompts?.[0]?.content).toContain("The whiteboard is empty.");
    expect(creates[1]?.initialPrompts?.[0]?.content).toContain(`html: ${source.length} characters`);
    expect(prompts).toEqual(["Teach me photosynthesis", "What should I remember?"]);
    const stored = repo.all()[0];
    expect(stored?.html).toBe(source);
    expect(stored?.css).toBe("p { color: green; }");
    expect(stored?.messages).toEqual([]);
  });

  it("sends the selection and the marked source as the prompt and strips copied markers on write", async () => {
    const topic = { ...createEmptyTopic(2), html: "<p>Leaves hold chlorophyll.</p><p>Roots.</p>" };
    let seen = "";
    const { model, prompts } = scriptedModel(async function* (options, input) {
      seen = input;
      const start = input.indexOf("<!-- ▶");
      const marked = input.slice(start, input.indexOf("<p>Roots.</p>") + "<p>Roots.</p>".length);
      await callTool(options, "whiteboard_set", { component: "html", source: marked.replace("</p><!--", "</p><aside>A pigment.</aside><!--") });
      yield "Added a note.";
    });
    const { tutor, repo, traces } = tutorFor(topic, model);

    await tutor.ask(topic.id, "What is chlorophyll?", { anchor });

    expect(prompts).toHaveLength(1);
    expect(seen).toContain("# Selection");
    expect(seen).toContain("[[chlorophyll]]");
    expect(seen).toContain("# Question\nWhat is chlorophyll?");
    const html = repo.all()[0]?.html ?? "";
    expect(html).toContain("<aside>A pigment.</aside>");
    expect(html).not.toContain("LEARNER SELECTION");
    const trace = traces.at(-1)?.trace;
    expect(trace?.question).toBe("What is chlorophyll?");
    expect(trace?.selection).toEqual([anchor]);
    expect(trace?.request?.selection).toEqual([anchor]);
    expect(trace?.request?.prompt).toBe(seen);
  });

  it("puts a reply that changed nothing onto the board as a note after the selection", async () => {
    const topic = { ...createEmptyTopic(3), html: "<p>Leaves hold chlorophyll.</p><p>Roots.</p>" };
    const { model } = scriptedModel(async function* () {
      yield "Chlorophyll is the green pigment.\n\nIt absorbs light.";
    });
    const { tutor, repo, traces, errors } = tutorFor(topic, model);

    await tutor.ask(topic.id, "What is chlorophyll?", { anchor });

    const html = repo.all()[0]?.html ?? "";
    const note = html.indexOf('<aside class="learner-note"');
    expect(note).toBeGreaterThan(html.indexOf("Leaves hold chlorophyll."));
    expect(note).toBeLessThan(html.indexOf("Roots."));
    expect(html).toContain("What is chlorophyll?");
    expect(html).toContain("It absorbs light.");
    expect(traces.at(-1)?.trace.fallback).toBe("note");
    expect(errors.at(-1)).toBeNull();
  });

  it("shows an explanation without changing the board or adding a note", async () => {
    const topic = { ...createEmptyTopic(4), html: "<p>Leaves hold chlorophyll.</p><p>Roots.</p>" };
    const { model } = scriptedModel(async function* (options) {
      await callTool(options, "whiteboard_explain", { text: "A green pigment." });
      yield "Chlorophyll is a green pigment.";
    });
    const explained: { topicId: string; text: string; anchor: SelectionAnchor | null }[] = [];
    const { tutor, repo, traces, errors } = tutorFor(topic, model, {
      onExplain: (topicId, { text, anchor: at }) => explained.push({ topicId, text, anchor: at }),
    });

    await tutor.ask(topic.id, "What is chlorophyll?", { anchor });

    expect(explained).toEqual([{ topicId: topic.id, text: "A green pigment.", anchor }]);
    expect(repo.all()[0]?.html).toBe(topic.html);
    expect(traces.at(-1)?.trace.fallback).toBeUndefined();
    expect(traces.at(-1)?.trace.error).toBeUndefined();
    expect(errors.at(-1)).toBeNull();
  });

  it("reports an ask that changed nothing", async () => {
    const topic = { ...createEmptyTopic(4), html: "<p>Leaves.</p>" };
    const { model } = scriptedModel(async function* () {
      yield "";
    });
    const { tutor, repo, errors, traces } = tutorFor(topic, model);

    await tutor.ask(topic.id, "Store it", { note: false });
    expect(repo.all()[0]?.html).toBe("<p>Leaves.</p>");
    expect(errors.at(-1)).toBe(NOTHING_CHANGED);
    expect(traces.at(-1)?.trace.error).toBe(NOTHING_CHANGED);
  });

  it("moves an empty-board lesson printed as text into the html", async () => {
    const topic = createEmptyTopic(5);
    const reply = `\`\`\`html\n${lessonReply()}\`\`\``;
    const { model } = scriptedModel(async function* () {
      yield reply;
    });
    const { tutor, repo, traces } = tutorFor(topic, model);

    await tutor.ask(topic.id, "Teach me photosynthesis");
    const stored = repo.all()[0];
    expect(stored?.html).toContain("Plants store energy from light.");
    expect(stored?.html.startsWith("<h1>Photosynthesis</h1>")).toBe(true);
    expect(stored?.title).toBe("Photosynthesis");
    expect(traces.at(-1)?.trace.rawReply).toBe(reply);
    expect(traces.at(-1)?.trace.fallback).toBe("html");
  });

  it("puts an svg printed as a tool call onto the whiteboard", async () => {
    const topic = createEmptyTopic(6);
    const reply =
      '```tool_code\nwhiteboard_replace_document(content="`<svg width=\\"100\\" height=\\"100\\"><circle cx=\\"50\\" cy=\\"50\\" r=\\"40\\" stroke=\\"black\\" fill=\\"white\\"></circle></svg>`")\n```';
    const { model } = scriptedModel(async function* () {
      yield reply;
    });
    const { tutor, repo } = tutorFor(topic, model);

    await tutor.ask(topic.id, "Draw a circle");
    const stored = repo.all()[0];
    expect(stored?.svg).toContain("<circle");
    expect(stored?.svg).toContain('width="100"');
    expect(stored?.html).toBe("");
  });

  it("records rounds, tool calls, and reasoning, live and when done", async () => {
    const topic = createEmptyTopic(7);
    const { model, creates } = scriptedModel(
      async function* (options, _input, promptOptions) {
        promptOptions?.onReasoning?.("Start with a title.");
        yield "Drawing ";
        yield "now.";
        await callTool(options, "whiteboard_set", { component: "html", source: "<h1>Cells</h1>" });
        yield "Done.";
      },
      { inputUsage: 300, inputQuota: 8192 },
    );
    const { tutor, traces } = tutorFor(topic, model, { modelId: () => "local:test" });

    await tutor.ask(topic.id, "Teach me cells");
    expect(creates[0]?.reasoning).toBe(true);
    const final = traces.at(-1)!;
    expect(final.done).toBe(true);
    expect(traces.slice(0, -1).every((entry) => !entry.done && entry.trace === final.trace)).toBe(true);
    const trace = final.trace;
    expect(trace.id).toBeTruthy();
    expect(trace.modelId).toBe("local:test");
    expect(trace.request?.initialPrompts[0]?.content).toContain("The whiteboard is empty.");
    expect(trace.request?.prompt).toBe("Teach me cells");
    expect(trace.inputUsage).toBe(300);
    expect(trace.events.map((event) => event.kind)).toEqual(["reasoning", "text", "tool", "text"]);
    const tool = trace.events[2];
    expect(tool?.kind === "tool" && tool.output).toEqual({ component: "html", characters: 14, title: "Cells" });
  });

  it("keeps a stopped ask in the trace and ignores an ask while one runs", async () => {
    const topic = { ...createEmptyTopic(8), html: "<p>Leaves.</p>" };
    let tutor: Tutor;
    let second: Promise<void> | undefined;
    const { model, creates } = scriptedModel(async function* (_options, _input, promptOptions) {
      yield "Partial";
      second = tutor.ask(topic.id, "Too soon");
      tutor.stop();
      if (promptOptions?.signal?.aborted) return;
      yield "More";
    });
    const setup = tutorFor(topic, model);
    tutor = setup.tutor;

    await tutor.ask(topic.id, "First");
    await second;
    expect(creates).toHaveLength(1);
    const trace = setup.traces.at(-1)?.trace;
    expect(trace?.error).toBe("Stopped");
    expect(trace?.events).toEqual([{ kind: "text", text: "Partial" }]);
    expect(setup.repo.all()[0]?.html).toBe("<p>Leaves.</p>");
  });

  it("stops at once when the backend never yields again", async () => {
    const topic = { ...createEmptyTopic(10), html: "<p>Leaves.</p>" };
    const { model } = scriptedModel(async function* () {
      yield "Working";
      await new Promise(() => {});
    });
    const { tutor, traces } = tutorFor(topic, model);
    const running = tutor.ask(topic.id, "Add a section");
    await new Promise((resolve) => setTimeout(resolve, 0));
    tutor.stop();
    await running;
    expect(tutor.isBusy).toBe(false);
    expect(traces.at(-1)?.trace.error).toBe("Stopped");
  });

  it("stops, or times out, while the model never finishes starting, and destroys a late session", async () => {
    const topic = { ...createEmptyTopic(11), html: "<p>Leaves.</p>" };
    let destroyed = 0;
    let deliver: (() => void) | undefined;
    const model: LanguageModelAPI = {
      async availability() {
        return "available";
      },
      create() {
        return new Promise<LanguageModelSession>((resolve) => {
          deliver = () =>
            resolve({
              async *promptStreaming() {
                yield "";
              },
              destroy() {
                destroyed += 1;
              },
            });
        });
      },
    };
    const { tutor, traces, errors } = tutorFor(topic, model);

    const stopped = tutor.ask(topic.id, "First");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(traces[0]?.trace.request).toBeUndefined();
    tutor.stop();
    await stopped;
    expect(tutor.isBusy).toBe(false);
    expect(traces.at(-1)?.trace.error).toBe("Stopped");
    deliver?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(destroyed).toBe(1);

    vi.useFakeTimers();
    try {
      const timedOut = tutor.ask(topic.id, "Second");
      await vi.advanceTimersByTimeAsync(START_TIMEOUT_MS + 1);
      await timedOut;
    } finally {
      vi.useRealTimers();
    }
    expect(tutor.isBusy).toBe(false);
    expect(errors.at(-1)).toBe(START_TIMEOUT);
  });

  it("uses a pinned system prompt and sends an edited request once", async () => {
    const topic = { ...createEmptyTopic(9), systemPrompt: "Pinned instructions." };
    const { model, creates } = scriptedModel(async function* (options) {
      await callTool(options, "whiteboard_set", { component: "html", source: "<p>Hi</p>" });
      yield "Ok.";
    });
    const { tutor, traces } = tutorFor(topic, model);

    expect(tutor.previewSystem(topic)).toEqual({ text: "Pinned instructions.", pinned: true });
    await tutor.ask(topic.id, "One");
    expect(creates[0]?.initialPrompts).toEqual([{ role: "system", content: "Pinned instructions." }]);

    const edited = [
      { role: "system" as const, content: "Edited system." },
      { role: "user" as const, content: "Pretend I asked about cells." },
    ];
    tutor.setNextRequest(topic.id, edited);
    expect(tutor.previewRequest(topic)).toEqual({ edited: true, initialPrompts: edited });
    await tutor.ask(topic.id, "Two");
    expect(creates[1]?.initialPrompts).toEqual(edited);
    expect(traces.at(-1)?.trace.request).toMatchObject({ initialPrompts: edited, prompt: "Two", edited: true });

    await tutor.ask(topic.id, "Three");
    expect(creates[2]?.initialPrompts).toEqual([{ role: "system", content: "Pinned instructions." }]);
    expect(tutor.previewRequest(topic).edited).toBe(false);
  });
});
