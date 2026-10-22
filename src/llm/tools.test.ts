// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { createEmptyTopic, type TopicRepository } from "../storage/db.ts";
import type { TopicRecord } from "../types.ts";
import { compactResults, createWhiteboardTools, toolSpecs, VIEW_ALL_CHAR_LIMIT, WEB_SEARCH_TOOL_SPEC, WHITEBOARD_TOOL_SPECS } from "./tools.ts";

function memoryRepo(initial: TopicRecord[]): TopicRepository & { all(): TopicRecord[] } {
  const map = new Map(initial.map((topic) => [topic.id, structuredClone(topic)]));
  return {
    all: () => [...map.values()],
    async list() {
      return [...map.values()];
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
      return (await this.list())[0];
    },
  };
}

function hostFor(topic: TopicRecord, repo: TopicRepository, openId: () => string | null) {
  return {
    topicId: topic.id,
    getOpenTopicId: openId,
    repo,
    onDocument: () => {},
  };
}

describe("web_search tool", () => {
  const response = {
    query: "q",
    provider: "google" as const,
    note: "No Tavily API key; results from Google",
    results: [{ title: "T", url: "https://a.example/", snippet: "x".repeat(400), score: null }],
  };

  it("is offered only when the host can search", () => {
    const topic = createEmptyTopic(1);
    const repo = memoryRepo([topic]);
    expect(createWhiteboardTools(hostFor(topic, repo, () => topic.id)).some((tool) => tool.name === "web_search")).toBe(false);
    const tools = createWhiteboardTools({ ...hostFor(topic, repo, () => topic.id), search: async () => response });
    expect(tools.at(-1)?.name).toBe("web_search");
    expect(toolSpecs(true)).toEqual([...WHITEBOARD_TOOL_SPECS, WEB_SEARCH_TOOL_SPEC]);
    expect(toolSpecs(false)).toBe(WHITEBOARD_TOOL_SPECS);
  });

  it("returns numbered results with short snippets", async () => {
    const topic = createEmptyTopic(1);
    const calls: [string, number][] = [];
    const tool = createWhiteboardTools({
      ...hostFor(topic, memoryRepo([topic]), () => topic.id),
      search: async (query, max) => (calls.push([query, max]), response),
    }).find((item) => item.name === "web_search")!;
    const out = (await tool.execute('{"query":" photosynthesis ","max_results":20}')) as ReturnType<typeof compactResults>;
    expect(calls).toEqual([["photosynthesis", 10]]);
    expect(out).toEqual({
      query: "q",
      provider: "google",
      note: "No Tavily API key; results from Google",
      results: [{ n: 1, title: "T", url: "https://a.example/", snippet: `${"x".repeat(300)}…` }],
    });
  });

  it("explains a site the extension does not allow", async () => {
    const topic = createEmptyTopic(1);
    const denied = Object.assign(new Error("Web search is not enabled for this site"), { name: "NotAllowedError" });
    const tool = createWhiteboardTools({
      ...hostFor(topic, memoryRepo([topic]), () => topic.id),
      search: async () => {
        throw denied;
      },
    }).find((item) => item.name === "web_search")!;
    await expect(tool.execute({ query: "x" })).rejects.toThrow("Web search is not available: Web search is not enabled for this site");
    await expect(tool.execute({ query: " " })).rejects.toThrow("query must be a non-empty string.");
  });
});

describe("whiteboard tools", () => {
  it("sets, views, and snapshots one component", async () => {
    const topic = createEmptyTopic(1);
    const repo = memoryRepo([topic]);
    const tools = createWhiteboardTools(hostFor(topic, repo, () => topic.id));
    expect(tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }))).toEqual(WHITEBOARD_TOOL_SPECS);
    const set = tools.find((tool) => tool.name === "whiteboard_set");
    const view = tools.find((tool) => tool.name === "whiteboard_view");
    const snapshot = tools.find((tool) => tool.name === "whiteboard_snapshot");
    if (!set || !view || !snapshot) throw new Error("missing tool");

    const written = await set.execute({
      component: "html",
      source: "<h1>Cells</h1><p>Visible lesson</p>",
    });
    expect(written).toMatchObject({ component: "html", title: "Cells" });
    await set.execute({ component: "svg", source: "<svg><text>Diagram</text></svg>" });
    await set.execute({ component: "json", source: '{"step":1}' });

    expect(await view.execute({ component: "json" })).toEqual({ component: "json", source: '{"step":1}' });
    const shot = (await snapshot.execute({})) as { text: string; characters: { html: number } };
    expect(shot.text).toContain("Visible lesson");
    expect(shot.text).toContain("Diagram");
    expect(shot.characters.html).toBeGreaterThan(0);
    expect(repo.all()[0]?.title).toBe("Cells");
  });

  it("rejects invalid json and leaves the stored value unchanged", async () => {
    const topic = createEmptyTopic(1);
    topic.json = '{"ok":true}';
    const repo = memoryRepo([topic]);
    const set = createWhiteboardTools(hostFor(topic, repo, () => topic.id)).find((tool) => tool.name === "whiteboard_set");
    if (!set) throw new Error("missing set tool");
    await expect(set.execute({ component: "json", source: "{nope" })).rejects.toThrow(/json/i);
    expect(repo.all()[0]?.json).toBe('{"ok":true}');
  });

  it("returns lengths when every source together is too long", async () => {
    const topic = createEmptyTopic(1);
    topic.html = "h".repeat(VIEW_ALL_CHAR_LIMIT + 1);
    const repo = memoryRepo([topic]);
    const view = createWhiteboardTools(hostFor(topic, repo, () => topic.id)).find((tool) => tool.name === "whiteboard_view");
    if (!view) throw new Error("missing view tool");
    const result = await view.execute({ component: "all" });
    expect(result).toMatchObject({ truncated: true });
    expect(JSON.stringify(result)).not.toContain("hhh");
  });

  it("stores markdown without changing the page", async () => {
    const topic = createEmptyTopic(1);
    topic.html = "<h1>Keep</h1>";
    const repo = memoryRepo([topic]);
    const store = createWhiteboardTools(hostFor(topic, repo, () => topic.id)).find(
      (tool) => tool.name === "whiteboard_store_material",
    );
    if (!store) throw new Error("missing store tool");
    await store.execute({ markdown: "# Cells\n\nA cell has a membrane.\n" });
    const saved = repo.all()[0];
    expect(saved?.materialMarkdown).toContain("membrane");
    expect(saved?.html).toBe("<h1>Keep</h1>");
  });

  it("refuses to write after the topic is closed", async () => {
    const topic = createEmptyTopic(1);
    const repo = memoryRepo([topic]);
    const set = createWhiteboardTools(hostFor(topic, repo, () => "other")).find((tool) => tool.name === "whiteboard_set");
    if (!set) throw new Error("missing set tool");
    await expect(set.execute({ component: "css", source: "p{color:red}" })).rejects.toThrow(/no longer open/);
    expect(repo.all()[0]?.css).toBe("");
  });

  it("reports each call's name, input, and outcome to the host", async () => {
    const topic = createEmptyTopic(9);
    const repo = memoryRepo([topic]);
    const calls: unknown[] = [];
    const tools = createWhiteboardTools({
      ...hostFor(topic, repo, () => topic.id),
      onToolStart: (name, input) => calls.push(["start", name, input]),
      onToolEnd: (name, outcome) => calls.push(["end", name, outcome]),
    });
    const set = tools.find((tool) => tool.name === "whiteboard_set")!;
    await set.execute({ component: "css", source: "h1 {}" });
    await expect(set.execute({ component: "json", source: "{" })).rejects.toThrow();
    expect(calls).toEqual([
      ["start", "whiteboard_set", { component: "css", source: "h1 {}" }],
      ["end", "whiteboard_set", { output: { component: "css", characters: 5 } }],
      ["start", "whiteboard_set", { component: "json", source: "{" }],
      ["end", "whiteboard_set", { error: "json must be empty or a JSON string." }],
    ]);
  });

  it("inserts new html after the selection without rewriting the page", async () => {
    const topic = { ...createEmptyTopic(20), html: "<h1>C++</h1><section><h2>5. Functions</h2><p>Body</p></section><section><h2>6. Loops</h2></section>" };
    const repo = memoryRepo([topic]);
    const anchor = {
      kind: "element" as const,
      component: "html" as const,
      selector: "body > section:nth-of-type(1) > h2:nth-of-type(1)",
      tag: "h2",
      quote: { exact: "5. Functions", prefix: "", suffix: "" },
      outerHTML: "<h2>5. Functions</h2>",
      rect: { x: 0, y: 0, width: 0, height: 0 },
    };
    const insert = createWhiteboardTools({ ...hostFor(topic, repo, () => topic.id), anchor }).find((tool) => tool.name === "whiteboard_insert")!;
    const result = (await insert.execute({ html: "<section><h2>Try it</h2><!-- ▶ LEARNER SELECTION --></section>" })) as { placed: string };
    expect(result.placed).toBe("after selection");
    const html = repo.all()[0]!.html;
    expect(html).toContain("<h2>5. Functions</h2><section><h2>Try it</h2></section><p>Body</p>");
    expect(html).toContain("<h2>6. Loops</h2>");
    expect(html).not.toContain("LEARNER SELECTION");

    const atEnd = createWhiteboardTools(hostFor(topic, repo, () => topic.id)).find((tool) => tool.name === "whiteboard_insert")!;
    expect(await atEnd.execute({ html: "<p>Last</p>" })).toMatchObject({ placed: "at the end" });
    expect(repo.all()[0]!.html.endsWith("<p>Last</p>")).toBe(true);
    await expect(atEnd.execute({ html: "  " })).rejects.toThrow("non-empty");
  });

  it("edits one exact piece of a source", async () => {
    const topic = { ...createEmptyTopic(21), html: "<h1>Old</h1><p>a</p><p>a</p>", json: '{"n":1}' };
    const repo = memoryRepo([topic]);
    const edit = createWhiteboardTools(hostFor(topic, repo, () => topic.id)).find((tool) => tool.name === "whiteboard_edit")!;
    await edit.execute({ component: "html", find: "<h1>Old</h1>", replace: "<h1>New</h1>" });
    expect(repo.all()[0]!.html).toBe("<h1>New</h1><p>a</p><p>a</p>");
    expect(repo.all()[0]!.title).toBe("New");
    await expect(edit.execute({ component: "html", find: "<p>a</p>", replace: "" })).rejects.toThrow("more than once");
    await expect(edit.execute({ component: "html", find: "<p>z</p>", replace: "" })).rejects.toThrow("does not appear");
    await expect(edit.execute({ component: "json", find: "1}", replace: "1" })).rejects.toThrow("does not parse");
  });
  it("explains without saving anything", async () => {
    const topic = { ...createEmptyTopic(9), html: "<p>Leaves hold chlorophyll.</p>" };
    const repo = memoryRepo([topic]);
    let open: string | null = topic.id;
    const shown: string[] = [];
    const tools = createWhiteboardTools({ ...hostFor(topic, repo, () => open), onExplain: (text) => shown.push(text) });
    const explain = tools.find((tool) => tool.name === "whiteboard_explain");
    if (!explain) throw new Error("missing tool");

    expect(await explain.execute({ text: "  A green pigment.\n\nIt absorbs light. " })).toEqual({
      shown: true,
      saved: false,
      characters: 35,
    });
    expect(shown).toEqual(["A green pigment.\n\nIt absorbs light."]);
    expect(repo.all()[0]).toEqual(topic);

    await expect(explain.execute({ text: "   " })).rejects.toThrow("text is empty.");
    await expect(explain.execute({ text: 3 })).rejects.toThrow("text must be a string.");
    open = null;
    await expect(explain.execute({ text: "Late." })).rejects.toThrow("no longer open");
    expect(shown).toHaveLength(1);
  });
});
