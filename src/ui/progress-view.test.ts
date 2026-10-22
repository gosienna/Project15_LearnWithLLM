// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import type { TurnTrace } from "../types.ts";
import { createProgressView, progressLine, toolLabel } from "./progress-view.ts";

describe("progress view", () => {
  it("shows reasoning and each round of tool calls while an ask runs, and hides when it ends", () => {
    const view = createProgressView();
    expect(view.element.hidden).toBe(true);
    const trace: TurnTrace = { id: "t", modelId: null, startedAt: Date.now(), events: [] };
    view.update(trace);
    expect(view.element.hidden).toBe(false);
    expect(view.element.querySelector(".progress-head")?.textContent).toContain("Starting the model");

    trace.events.push(
      { kind: "reasoning", text: "Plan a title and a diagram." },
      { kind: "tool", name: "whiteboard_view", input: { component: "html" }, output: { source: "" } },
      { kind: "tool", name: "whiteboard_set", input: { component: "svg", source: "<svg/>" }, error: "Too long." },
      { kind: "reasoning", text: "Shorter svg." },
      { kind: "tool", name: "whiteboard_set", input: { component: "svg", source: "<svg/>" } },
    );
    view.update(trace);
    const rounds = [...view.element.querySelectorAll(".progress-round")];
    expect(rounds.map((round) => round.querySelector(".progress-round-title")?.textContent)).toEqual(["Round 1", "Round 2"]);
    const labels = [...view.element.querySelectorAll(".progress-label")].map((label) => label.textContent);
    expect(labels).toEqual(["Thought", "Reading the html source", "Writing the svg source", "Thought", "Writing the svg source"]);
    expect(view.element.querySelector(".progress-text")?.textContent).toBe("Plan a title and a diagram.");
    expect(view.element.querySelector(".is-failed .progress-error")?.textContent).toBe("Too long.");
    expect(view.element.querySelectorAll(".is-running")).toHaveLength(1);
    expect(view.element.querySelector(".progress-head")?.textContent).toContain("3 tool calls");
    expect(progressLine(trace)).toMatch(/^Round 2 · Writing the svg source… · \d+ s$/);

    trace.events.push({ kind: "reasoning", text: "Check the page." });
    view.update(trace);
    expect([...view.element.querySelectorAll(".progress-label")].at(-1)?.textContent).toBe("Thinking…");

    view.update(null);
    expect(view.element.hidden).toBe(true);
  });
});

describe("toolLabel", () => {
  it("names the web search query", () => {
    expect(toolLabel({ kind: "tool", name: "web_search", input: { query: "mars rover" } })).toBe("Searching the web: mars rover");
    expect(toolLabel({ kind: "tool", name: "web_search", input: "{}" })).toBe("Searching the web");
    expect(toolLabel({ kind: "tool", name: "whiteboard_add_image", input: { description: "Eiffel Tower" } })).toBe("Saving image: Eiffel Tower");
    expect(toolLabel({ kind: "tool", name: "whiteboard_add_image", input: {} })).toBe("Saving an image");
  });
});
