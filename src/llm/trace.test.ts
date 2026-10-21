import { describe, expect, it } from "vitest";
import { capText, TRACE_TEXT_LIMIT, TraceRecorder } from "./trace.ts";

describe("trace recorder", () => {
  it("splits text around tool calls and merges consecutive deltas", () => {
    const recorder = new TraceRecorder("local:test", 0);
    recorder.addReasoning("Plan ");
    recorder.addReasoning("the page.");
    recorder.addText("Let me ");
    recorder.addText("draw it.");
    recorder.toolStart("whiteboard_set", { component: "html", source: "<h1>Hi</h1>" }, 10);
    recorder.toolEnd("whiteboard_set", { output: { characters: 11 } }, 25);
    recorder.addText("Done.");
    const trace = recorder.finish(40);
    expect(trace.events).toEqual([
      { kind: "reasoning", text: "Plan the page." },
      { kind: "text", text: "Let me draw it." },
      { kind: "tool", name: "whiteboard_set", input: { component: "html", source: "<h1>Hi</h1>" }, output: { characters: 11 }, ms: 15 },
      { kind: "text", text: "Done." },
    ]);
    expect(trace.endedAt).toBe(40);
  });

  it("records a tool error and caps long strings", () => {
    const recorder = new TraceRecorder(null);
    recorder.toolStart("whiteboard_set", { component: "json", source: "x".repeat(TRACE_TEXT_LIMIT + 5) });
    recorder.toolEnd("whiteboard_set", { error: "json must be empty or a JSON string." });
    const [event] = recorder.events;
    expect(event?.kind === "tool" && event.error).toBe("json must be empty or a JSON string.");
    const source = event?.kind === "tool" ? (event.input as { source: string }).source : "";
    expect(source).toBe(capText("x".repeat(TRACE_TEXT_LIMIT + 5)));
    expect(source.endsWith("…(5 more chars)")).toBe(true);
  });
});
