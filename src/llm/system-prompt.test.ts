import { describe, expect, it } from "vitest";
import { serializeLesson } from "../document/markdown.ts";
import { buildPrompt, estimateTokens, FIXED_INSTRUCTIONS, WHITEBOARD_PLACEHOLDER } from "./system-prompt.ts";

describe("system prompt", () => {
  it("describes an empty board without the placeholder sentence", () => {
    const { system } = buildPrompt({ markdown: "   ", messages: [] });
    expect(system).toContain("The whiteboard is empty.");
    expect(system).not.toContain(WHITEBOARD_PLACEHOLDER);
    expect(system).not.toContain("The lesson will appear here.");
  });

  it("turns a lesson that exceeds the budget into an outline plus a prefix", () => {
    const sections = [1, 2, 3, 4].map((n) => ({
      id: `part-${n}`,
      level: 2 as const,
      heading: `Part ${n}`,
      body: `TOKEN_${n} ` + "gamma ".repeat(120),
    }));
    const markdown = serializeLesson({ title: "Quadratics", preamble: "", sections });
    const firstOnly = serializeLesson({ title: "Quadratics", preamble: "", sections: [sections[0]] });
    const headerTokens = estimateTokens(`${FIXED_INSTRUCTIONS}\n\n# Learning material\n`);
    const contextTokens = 1500 + headerTokens + estimateTokens(firstOnly) + 120;
    const { system } = buildPrompt({ markdown, messages: [], contextTokens, reservedTokens: 1500 });
    expect(system).toContain("TOKEN_1");
    expect(system).not.toContain("TOKEN_4");
    expect(system).toContain("Omitted section ids:");
    expect(system).toContain("part-4");
    expect(system).toContain("Call whiteboard_read");
    expect(system).not.toContain(WHITEBOARD_PLACEHOLDER);
  });
});
