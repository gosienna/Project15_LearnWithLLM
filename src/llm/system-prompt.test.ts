// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { serializeLesson } from "../document/markdown.ts";
import type { SelectionAnchor } from "../types.ts";
import { emptyBoard, SELECTION_END, SELECTION_START } from "../ui/whiteboard.ts";
import { buildPrompt, estimateTokens, INSTRUCTIONS, sourceWindow, WEB_SEARCH_INSTRUCTIONS, whiteboardPreface } from "./system-prompt.ts";

function anchor(overrides: Partial<SelectionAnchor> = {}): SelectionAnchor {
  return {
    kind: "text",
    component: "html",
    selector: "body > p:nth-of-type(1)",
    tag: "p",
    quote: { exact: "chlorophyll", prefix: "Leaves hold ", suffix: " in their cells." },
    outerHTML: "<p>Leaves hold chlorophyll in their cells.</p>",
    rect: { x: 10, y: 20, width: 80, height: 16 },
    ...overrides,
  };
}

describe("system prompt", () => {
  it("describes an empty board and sends the question as it is", () => {
    const { system, prompt } = buildPrompt({ sources: emptyBoard(), materialMarkdown: "   ", question: "Teach me cells" });
    expect(system.startsWith(INSTRUCTIONS)).toBe(true);
    expect(system).toContain("The whiteboard is empty.");
    expect(system).toContain("lessonData");
    expect(system).not.toContain("# Stored learning material");
    expect(prompt).toBe("Teach me cells");
  });

  it("reports source lengths and does not inline the page without a selection", () => {
    const sources = { ...emptyBoard(), html: "<h1>Photosynthesis</h1><p>Leaves.</p>" };
    const { system, prompt } = buildPrompt({ sources, materialMarkdown: "", question: "Summarize" });
    expect(system).toContain(`html: ${sources.html.length} characters`);
    expect(system).not.toContain("Leaves.");
    expect(prompt).toBe("Summarize");
  });

  it("puts the selection, the marked source, and the question in the prompt", () => {
    const sources = { ...emptyBoard(), html: "<h1>Photosynthesis</h1><p>Leaves hold chlorophyll in their cells.</p><p>Roots.</p>" };
    const { system, prompt } = buildPrompt({ sources, materialMarkdown: "", question: "What is this?", anchor: anchor() });
    expect(system).not.toContain("chlorophyll");
    expect(prompt).toContain("# Selection");
    expect(prompt).toContain("selector: body > p:nth-of-type(1)");
    expect(prompt).toContain("…Leaves hold [[chlorophyll]] in their cells.…");
    expect(prompt).toContain(`${SELECTION_START}<p>Leaves hold chlorophyll in their cells.</p>${SELECTION_END}<p>Roots.</p>`);
    expect(prompt.trim().endsWith("# Question\nWhat is this?")).toBe(true);
  });

  it("says so when the selector is not in the stored source", () => {
    const sources = { ...emptyBoard(), html: "<div id='app'></div>" };
    const { prompt } = buildPrompt({
      sources,
      materialMarkdown: "",
      question: "Why?",
      anchor: anchor({ selector: "#app > button:nth-of-type(2)", tag: "button" }),
    });
    expect(prompt).toContain("did not match the stored source");
    expect(prompt).not.toContain(SELECTION_START);
  });

  it("marks an svg element inside the svg source", () => {
    const sources = { ...emptyBoard(), html: "<p>Text</p>", svg: '<svg width="10" height="10"><rect></rect><text>Sun</text></svg>' };
    const { prompt } = buildPrompt({
      sources,
      materialMarkdown: "",
      question: "Explain",
      anchor: anchor({ component: "svg", selector: "#lesson-svg > svg:nth-of-type(1) > text:nth-of-type(1)", tag: "text" }),
    });
    expect(prompt).toContain("# Source: svg");
    expect(prompt).toContain(`${SELECTION_START}<text>Sun</text>${SELECTION_END}`);
    expect(prompt).not.toContain("<p>Text</p>");
  });

  it("keeps a window of a long source around the selection", () => {
    const text = `${"a".repeat(5000)}${SELECTION_START}X${SELECTION_END}${"b".repeat(5000)}`;
    const window = sourceWindow(text, 1000);
    expect(window).toContain(`${SELECTION_START}X${SELECTION_END}`);
    expect(window).toContain("characters before");
    expect(window).toContain("characters after");
    expect(window.length).toBeLessThan(1100);
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
    const contextTokens = 1500 + estimateTokens(header) + estimateTokens(firstOnly) + 120;
    const { system } = buildPrompt({
      sources: emptyBoard(),
      materialMarkdown: markdown,
      question: "Go on",
      contextTokens,
      reservedTokens: 1500,
    });
    expect(system).toContain("TOKEN_1");
    expect(system).not.toContain("TOKEN_4");
    expect(system).toContain("Omitted section ids:");
    expect(system).toContain("part-4");
    expect(system).toContain("shortened to fit the context window");
  });

  it("uses a pinned system prompt as it is and still builds the selection prompt", () => {
    const sources = { ...emptyBoard(), html: "<p>Leaves hold chlorophyll in their cells.</p>" };
    const { system, prompt } = buildPrompt({
      sources,
      materialMarkdown: "",
      question: "Why green?",
      anchor: anchor(),
      systemOverride: "You are a pirate tutor.",
    });
    expect(system).toBe("You are a pirate tutor.");
    expect(prompt).toContain(SELECTION_START);
  });
});

describe("web search instructions", () => {
  it("come right after the instructions only when the ask offers web_search", () => {
    expect(whiteboardPreface("The whiteboard is empty.", false, true)).toContain(`${INSTRUCTIONS}\n\n${WEB_SEARCH_INSTRUCTIONS}\n\n# Whiteboard`);
    expect(whiteboardPreface("The whiteboard is empty.", false)).not.toContain("# Web search");
  });

  it("follow the switch in a pinned system prompt", () => {
    const base = { sources: emptyBoard(), materialMarkdown: "", question: "Q", systemOverride: "You are a pirate tutor." };
    expect(buildPrompt({ ...base, webSearch: true }).system).toBe(`You are a pirate tutor.\n\n${WEB_SEARCH_INSTRUCTIONS}`);
    expect(buildPrompt({ ...base, webSearch: false }).system).toBe("You are a pirate tutor.");
    const copied = whiteboardPreface("The whiteboard is empty.", false, true);
    expect(buildPrompt({ ...base, systemOverride: copied, webSearch: false }).system).not.toContain("# Web search");
    expect(buildPrompt({ ...base, systemOverride: copied, webSearch: true }).system.split("# Web search")).toHaveLength(2);
  });
});
