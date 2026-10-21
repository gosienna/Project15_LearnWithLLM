// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import type { DialogueMessage } from "../types.ts";
import { renderDialogue } from "./dialogue.ts";

const messages: DialogueMessage[] = [
  { id: "u1", role: "user", content: "Teach me fractions", createdAt: 1 },
  {
    id: "a1",
    role: "assistant",
    content: "I put the lesson on the whiteboard.",
    createdAt: 2,
    trace: {
      modelId: "local:test",
      startedAt: 0,
      endedAt: 1500,
      rawReply: "<h1>Fractions</h1>",
      fallback: "html",
      events: [
        { kind: "reasoning", text: "Start with halves." },
        { kind: "text", text: "Drawing." },
        { kind: "tool", name: "whiteboard_set", input: { component: "html", source: "<h1>Fractions</h1>" }, output: { characters: 18 }, ms: 4 },
        { kind: "text", text: "Done." },
      ],
    },
  },
  { id: "u2", role: "user", content: "Stop", createdAt: 3 },
  {
    id: "a2",
    role: "assistant",
    content: "",
    createdAt: 4,
    trace: { modelId: null, startedAt: 0, endedAt: 1, events: [], error: "Stopped" },
  },
];

function setup() {
  const host = document.createElement("div");
  document.body.append(host);
  const view = renderDialogue(host, { onSend: () => {}, onStop: () => {} });
  return { host, view };
}

describe("dialogue modes", () => {
  it("clean mode hides traces and empty turns", () => {
    const { host, view } = setup();
    view.renderTranscript(messages, null, "clean");
    expect(host.querySelectorAll(".bubble")).toHaveLength(3);
    expect(host.querySelector(".trace")).toBeNull();
    expect(host.textContent).not.toContain("Stopped");
  });

  it("debug mode shows rounds, tool calls, reasoning, the raw reply, and failed turns", () => {
    const { host, view } = setup();
    view.renderTranscript(messages, null, "debug");
    expect(host.querySelectorAll(".bubble")).toHaveLength(4);
    const trace = host.querySelector(".trace");
    expect(trace?.querySelector("summary")?.textContent).toContain("1 tool call");
    expect(trace?.querySelectorAll(".trace-round")).toHaveLength(2);
    expect(trace?.querySelector(".trace-tool summary")?.textContent).toBe("whiteboard_set html · ok · 4 ms");
    expect(trace?.querySelector(".trace-reasoning")?.textContent).toContain("Start with halves.");
    expect(trace?.textContent).toContain("Raw reply, moved to the whiteboard");
    expect(host.textContent).toContain("Stopped");
  });

  it("keeps an opened trace open across re-renders", () => {
    const { host, view } = setup();
    view.renderTranscript(messages, null, "debug");
    const trace = host.querySelector<HTMLDetailsElement>(".trace");
    trace!.open = true;
    trace!.dispatchEvent(new Event("toggle"));
    view.renderTranscript(messages, null, "debug");
    expect(host.querySelector<HTMLDetailsElement>(".trace")?.open).toBe(true);
  });

  it("shows the live trace while streaming in debug mode", () => {
    const { host, view } = setup();
    view.renderTranscript([], { text: null, toolActive: true, events: [{ kind: "tool", name: "whiteboard_view", input: { component: "css" } }] }, "debug");
    expect(host.textContent).toContain("Updating the lesson…");
    expect(host.querySelector(".trace summary")?.textContent).toContain("Running");
    expect(host.querySelector(".trace-tool summary")?.textContent).toBe("whiteboard_view css · running");
  });
});
