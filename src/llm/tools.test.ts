import { describe, expect, it } from "vitest";
import { createEmptyTopic, type TopicRepository } from "../storage/db.ts";
import type { TopicRecord } from "../types.ts";
import { createWhiteboardTools, VIEW_ALL_CHAR_LIMIT } from "./tools.ts";

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

describe("whiteboard tools", () => {
  it("sets, views, and snapshots one component", async () => {
    const topic = createEmptyTopic(1);
    const repo = memoryRepo([topic]);
    const tools = createWhiteboardTools(hostFor(topic, repo, () => topic.id));
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
});
