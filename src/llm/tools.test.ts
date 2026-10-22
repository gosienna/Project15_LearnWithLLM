// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { createEmptyTopic, type TopicRepository } from "../storage/db.ts";
import type { TopicRecord } from "../types.ts";
import {
  compactResults,
  createWhiteboardTools,
  IMAGE_TOOL_SPECS,
  IMAGES_PER_TOPIC,
  toolSpecs,
  VIEW_ALL_CHAR_LIMIT,
  WEB_SEARCH_TOOL_SPEC,
  WHITEBOARD_TOOL_SPECS,
} from "./tools.ts";

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

describe("image tools", () => {
  const png = () => new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" });
  const encodeImage = async (blob: Blob) => ({ blob: new Blob([blob], { type: "image/webp" }), width: 640, height: 480 });

  function setup(fetchImage: (url: string) => Promise<Blob> = async () => png()) {
    const topic = createEmptyTopic(1);
    const repo = memoryRepo([topic]);
    const fetched: string[] = [];
    const tools = createWhiteboardTools({
      ...hostFor(topic, repo, () => topic.id),
      fetchImage: (url) => (fetched.push(url), fetchImage(url)),
      encodeImage,
    });
    const tool = (name: string) => tools.find((item) => item.name === name)!;
    return { topic, repo, fetched, tool, tools };
  }

  it("are offered only when the host can fetch images", () => {
    const topic = createEmptyTopic(1);
    const plain = createWhiteboardTools(hostFor(topic, memoryRepo([topic]), () => topic.id));
    expect(plain.some((tool) => tool.name === "whiteboard_add_image")).toBe(false);
    expect(setup().tools.slice(-2).map((tool) => tool.name)).toEqual(["whiteboard_add_image", "whiteboard_remove_image"]);
    expect(toolSpecs(true, true)).toEqual([...WHITEBOARD_TOOL_SPECS, WEB_SEARCH_TOOL_SPEC, ...IMAGE_TOOL_SPECS]);
    expect(toolSpecs(false, false)).toBe(WHITEBOARD_TOOL_SPECS);
  });

  it("saves a re-encoded copy, reuses the id for the same url, and lists images in view all", async () => {
    const { repo, fetched, tool } = setup();
    const out = await tool("whiteboard_add_image").execute({ url: "https://img.example/a.jpg", description: " Eiffel Tower ", source_url: "https://site.example/" });
    expect(out).toEqual({ id: "img1", ref: "board-image:img1", cached: true, width: 640, height: 480 });
    const again = await tool("whiteboard_add_image").execute({ url: "https://img.example/a.jpg", description: "again" });
    expect(again).toMatchObject({ id: "img1", existing: true });
    expect(fetched).toEqual(["https://img.example/a.jpg"]);
    const saved = repo.all()[0]!.images!;
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ id: "img1", description: "Eiffel Tower", sourceUrl: "https://site.example/", type: "image/webp", width: 640 });
    expect(saved[0]!.blob).not.toBeNull();
    expect(await tool("whiteboard_view").execute({ component: "all" })).toMatchObject({
      images: [{ id: "img1", description: "Eiffel Tower", url: "https://img.example/a.jpg", cached: true }],
    });
  });

  it("keeps the url when the download fails, numbers new ids, and removes", async () => {
    const denied = Object.assign(new Error("Only images returned by search can be fetched"), { name: "NotAllowedError" });
    const { repo, tool } = setup(async (url) => {
      if (url.includes("bad")) throw denied;
      return png();
    });
    await tool("whiteboard_add_image").execute({ url: "https://img.example/a.jpg", description: "A" });
    const failed = (await tool("whiteboard_add_image").execute({ url: "https://img.example/bad.jpg", description: "B" })) as Record<string, unknown>;
    expect(failed).toMatchObject({ id: "img2", cached: false });
    expect(String(failed.note)).toContain("Only images returned by search can be fetched");
    expect(repo.all()[0]!.images![1]!.blob).toBeNull();
    expect(await tool("whiteboard_remove_image").execute({ id: "board-image:img1" })).toEqual({ removed: "img1", images: 1 });
    expect(await tool("whiteboard_add_image").execute({ url: "https://img.example/c.jpg", description: "C" })).toMatchObject({ id: "img3" });
    await expect(tool("whiteboard_remove_image").execute({ id: "img9" })).rejects.toThrow("There is no image img9");
  });

  it("rejects bad input and caps the topic", async () => {
    const { repo, topic, tool } = setup();
    await expect(tool("whiteboard_add_image").execute({ url: "javascript:alert(1)", description: "x" })).rejects.toThrow("url must be an http or https url.");
    await expect(tool("whiteboard_add_image").execute({ url: "https://img.example/a.jpg", description: " " })).rejects.toThrow("description must be a non-empty string.");
    const full = { ...topic, images: Array.from({ length: IMAGES_PER_TOPIC }, (_, i) => ({ id: `img${i + 1}`, url: `https://img.example/${i}.jpg`, description: "x", blob: null, addedAt: 1 })) };
    await repo.put(full);
    await expect(tool("whiteboard_add_image").execute({ url: "https://img.example/new.jpg", description: "x" })).rejects.toThrow(`already has ${IMAGES_PER_TOPIC} images`);
  });
});

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

  it("asks for images and lists at most five", async () => {
    const topic = createEmptyTopic(1);
    const calls: unknown[][] = [];
    const images = Array.from({ length: 7 }, (_, i) => ({ url: `https://img.example/${i}.jpg`, ...(i === 0 ? { description: "Leaf", sourceUrl: "https://a.example/" } : {}) }));
    const tool = createWhiteboardTools({
      ...hostFor(topic, memoryRepo([topic]), () => topic.id),
      search: async (...args) => (calls.push(args), { ...response, images }),
    }).find((item) => item.name === "web_search")!;
    const out = (await tool.execute({ query: "leaf", include_images: true })) as ReturnType<typeof compactResults>;
    expect(calls).toEqual([["leaf", 5, true]]);
    expect(out.images).toHaveLength(5);
    expect((out.images as unknown[])[0]).toEqual({ n: 1, url: "https://img.example/0.jpg", description: "Leaf", source: "https://a.example/" });
    expect((out.images as unknown[])[1]).toEqual({ n: 2, url: "https://img.example/1.jpg" });
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
