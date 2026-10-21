// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import type { TurnTrace } from "../types.ts";
import { renderTrace } from "./trace-view.ts";

const trace: TurnTrace = {
  modelId: "local:test",
  startedAt: 0,
  endedAt: 1500,
  rawReply: "<h1>Fractions</h1>",
  fallback: "html",
  request: {
    initialPrompts: [{ role: "system", content: "Teach on the whiteboard." }],
    prompt: "# Selection\n…",
    selection: {
      kind: "text",
      component: "html",
      selector: "body > p:nth-of-type(2)",
      tag: "p",
      quote: { exact: "half", prefix: "", suffix: "" },
      outerHTML: "<p>half</p>",
      rect: { x: 0, y: 0, width: 0, height: 0 },
    },
  },
  events: [
    { kind: "reasoning", text: "Start with halves." },
    { kind: "text", text: "Drawing." },
    { kind: "tool", name: "whiteboard_set", input: { component: "html", source: "<h1>Fractions</h1>" }, output: { characters: 18 }, ms: 4 },
    { kind: "text", text: "Done." },
  ],
};

describe("trace view", () => {
  it("shows rounds, tool calls, reasoning, the raw reply, and the selection request", () => {
    const root = renderTrace(trace, "t1", new Set());
    expect(root.querySelector("summary")?.textContent).toContain("1 tool call");
    expect(root.querySelectorAll(".trace-round")).toHaveLength(2);
    expect(root.querySelector(".trace-tool summary")?.textContent).toBe("whiteboard_set html · ok · 4 ms");
    expect(root.querySelector(".trace-reasoning")?.textContent).toContain("Start with halves.");
    expect(root.textContent).toContain("Raw reply, moved to the whiteboard");
    const request = [...root.querySelectorAll(".trace-detail > summary")].find((item) => item.textContent?.startsWith("Request input"));
    expect(request?.textContent).toBe("Request input · new session · 1 initial message · selection");
    expect(root.textContent).toContain("body > p:nth-of-type(2)");
  });

  it("keeps an opened section open across re-renders", () => {
    const openKeys = new Set<string>();
    const first = renderTrace(trace, "t1", openKeys) as HTMLDetailsElement;
    first.open = true;
    first.dispatchEvent(new Event("toggle"));
    expect((renderTrace(trace, "t1", openKeys) as HTMLDetailsElement).open).toBe(true);
  });

  it("shows a running ask and a failed one", () => {
    const live = renderTrace({ modelId: null, startedAt: 0, events: [{ kind: "tool", name: "whiteboard_view", input: { component: "css" } }] }, "live", new Set(), true);
    expect(live.querySelector("summary")?.textContent).toContain("Running");
    expect(live.querySelector(".trace-tool summary")?.textContent).toBe("whiteboard_view css · running");
    const failed = renderTrace({ modelId: null, startedAt: 0, endedAt: 1, events: [], error: "Stopped" }, "f", new Set());
    expect(failed.querySelector(".trace-error")?.textContent).toBe("Stopped");
  });
});
