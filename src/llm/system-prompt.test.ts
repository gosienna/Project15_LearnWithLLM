import { describe, expect, it } from "vitest";
import { serializeLesson } from "../document/markdown.ts";
import { emptyBoard } from "../ui/whiteboard.ts";
import { buildPrompt, estimateTokens, whiteboardPreface, WHITEBOARD_PLACEHOLDER } from "./system-prompt.ts";

describe("system prompt", () => {
  it("describes an empty board without the placeholder sentence", () => {
    const { system } = buildPrompt({ sources: emptyBoard(), materialMarkdown: "   ", messages: [] });
    expect(system).toContain("The whiteboard is empty.");
    expect(system).toContain("whiteboard_set");
    expect(system).toContain("lessonData");
    expect(system).not.toContain(WHITEBOARD_PLACEHOLDER);
    expect(system).not.toContain("The lesson will appear here.");
    expect(system).not.toContain("# Stored learning material");
  });

  it("reports source lengths and does not inline the page", () => {
    const sources = { ...emptyBoard(), html: "<h1>Photosynthesis</h1><p>Leaves.</p>" };
    const { system } = buildPrompt({ sources, materialMarkdown: "", messages: [] });
    expect(system).toContain(`html: ${sources.html.length} characters`);
    expect(system).not.toContain("Leaves.");
  });

  it("turns a stored lesson that exceeds the budget into an outline plus a prefix", () => {
    const sections = [1, 2, 3, 4].map((n) => ({
      id: `part-${n}`,
      level: 2 as const,
      heading: `Part ${n}`,
      body: `TOKEN_${n} ` + "gamma ".repeat(120),
    }));
    const markdown = serializeLesson({ title: "Quadratics", preamble: "", sections });
    const firstOnly = serializeLesson({ title: "Quadratics", preamble: "", sections: [sections[0]] });
    const header = whiteboardPreface("The whiteboard is empty.", true);
    const headerTokens = estimateTokens(header);
    const contextTokens = 1500 + headerTokens + estimateTokens(firstOnly) + 120;
    const { system } = buildPrompt({
      sources: emptyBoard(),
      materialMarkdown: markdown,
      messages: [],
      contextTokens,
      reservedTokens: 1500,
    });
    expect(system).toContain("TOKEN_1");
    expect(system).not.toContain("TOKEN_4");
    expect(system).toContain("Omitted section ids:");
    expect(system).toContain("part-4");
    expect(system).toContain("shortened to fit the context window");
    expect(system).not.toContain(WHITEBOARD_PLACEHOLDER);
  });

  it("uses a pinned system prompt as it is and still builds the history", () => {
    const { system, history } = buildPrompt({
      sources: { ...emptyBoard(), html: "<h1>Cells</h1>" },
      materialMarkdown: "",
      messages: [
        { id: "1", role: "user", content: "Hi", createdAt: 1 },
        { id: "2", role: "assistant", content: "", createdAt: 2 },
        { id: "3", role: "assistant", content: "Hello", createdAt: 3 },
      ],
      systemOverride: "You are a pirate tutor.",
    });
    expect(system).toBe("You are a pirate tutor.");
    expect(history).toEqual([
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello" },
    ]);
  });
});
