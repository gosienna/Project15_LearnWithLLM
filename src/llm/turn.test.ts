// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { createEmptyTopic, type TopicRepository } from "../storage/db.ts";
import type { CreateOptions, LanguageModelAPI, LanguageModelSession, SelectionAnchor, TopicRecord, TurnTrace } from "../types.ts";
import { extractBoardSvg, NOTHING_CHANGED, shouldUseEmptyBoardFallback, Tutor, type TutorDeps } from "./turn.ts";

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

describe("tutor", () => {
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
    expect(trace?.selection).toEqual(anchor);
    expect(trace?.request?.selection).toEqual(anchor);
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
    const reply = lessonReply();
    const { model } = scriptedModel(async function* () {
      yield reply;
    });
    const { tutor, repo, traces } = tutorFor(topic, model);

    await tutor.ask(topic.id, "Teach me photosynthesis");
    const stored = repo.all()[0];
    expect(stored?.html).toContain("Plants store energy from light.");
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
    expect(traces.at(-1)?.trace.request).toEqual({ initialPrompts: edited, prompt: "Two", edited: true });

    await tutor.ask(topic.id, "Three");
    expect(creates[2]?.initialPrompts).toEqual([{ role: "system", content: "Pinned instructions." }]);
    expect(tutor.previewRequest(topic).edited).toBe(false);
  });
});
