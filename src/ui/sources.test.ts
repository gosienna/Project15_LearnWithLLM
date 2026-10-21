// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { renderSources, type SourceContent } from "./sources.ts";
import { renderWhiteboard } from "./whiteboard.ts";

const content: SourceContent = { html: "<h1>Hi</h1>", css: "h1 { color: red; }", js: "", svg: "", json: "", material: "" };

function view() {
  const tabs = document.createElement("div");
  const board = document.createElement("article");
  const pane = document.createElement("section");
  document.body.append(tabs, board, pane);
  return { tabs, board, pane };
}

describe("board source tabs", () => {
  it("shows no tabs in clean mode", () => {
    const v = view();
    renderSources(v, content, "clean");
    expect(v.tabs.hidden).toBe(true);
    expect(v.board.hidden).toBe(false);
    expect(v.pane.hidden).toBe(true);
  });

  it("switches to a raw source without rebuilding the preview iframe", () => {
    const v = view();
    renderWhiteboard(v.board, content);
    const frame = v.board.querySelector("iframe");
    renderSources(v, content, "debug");
    const tabs = [...v.tabs.querySelectorAll<HTMLButtonElement>(".board-tab")];
    expect(tabs.map((tab) => tab.firstChild?.textContent)).toEqual(["Preview", "HTML", "CSS", "JS", "SVG", "JSON", "Material"]);
    tabs[2]!.click();
    expect(v.board.hidden).toBe(true);
    expect(v.pane.querySelector(".source-code")?.textContent).toBe("h1 { color: red; }");
    expect(v.board.querySelector("iframe")).toBe(frame);

    v.tabs.querySelectorAll<HTMLButtonElement>(".board-tab")[3]!.click();
    expect(v.pane.querySelector(".source-code")?.textContent).toBe("(empty)");

    renderSources(v, content, "clean");
    expect(v.board.hidden).toBe(false);
    expect(v.board.querySelector("iframe")).toBe(frame);
  });

  it("keeps an unsaved prompt edit through repaints", () => {
    const v = view();
    let system = { text: "Automatic one.", pinned: false };
    const inputs = {
      topicId: "t1",
      system: () => system,
      request: () => ({ edited: false, initialPrompts: [{ role: "system" as const, content: system.text }] }),
      onPinSystem: () => {},
      onUnpinSystem: () => {},
      onSetRequest: () => {},
    };
    renderSources(v, content, "debug", inputs);
    const tabs = [...v.tabs.querySelectorAll<HTMLButtonElement>(".board-tab")];
    expect(tabs.at(-3)?.textContent).toBe("System prompt");
    expect(tabs.at(-2)?.textContent).toBe("Next request");
    expect(tabs.at(-1)?.textContent).toBe("Trace0");
    tabs.at(-3)!.click();
    const field = v.pane.querySelector("textarea")!;
    field.value = "Half-typed";
    field.dispatchEvent(new Event("input"));
    system = { text: "Automatic two.", pinned: false };
    renderSources(v, content, "debug", inputs);
    expect(v.pane.querySelector("textarea")).toBe(field);
    expect(field.value).toBe("Half-typed");

    renderSources(v, content, "debug", { ...inputs, topicId: "t2" });
    expect(v.pane.querySelector("textarea")?.value).toBe("Automatic two.");
    renderSources(v, content, "clean", inputs);
  });

  it("lists this visit's asks, newest first, in the Trace tab", () => {
    const v = view();
    const traces = [
      { id: "b", modelId: null, startedAt: 2, events: [], question: "Why green?", selection: {
        kind: "text" as const, component: "html" as const, selector: "body > p:nth-of-type(1)", tag: "p",
        quote: { exact: "chlorophyll", prefix: "", suffix: "" }, outerHTML: "<p></p>", rect: { x: 0, y: 0, width: 0, height: 0 },
      } },
      { id: "a", modelId: null, startedAt: 1, endedAt: 3, events: [], question: "Teach me leaves" },
    ];
    const inputs = {
      topicId: "t1",
      system: () => ({ text: "S", pinned: false }),
      request: () => ({ edited: false, initialPrompts: [{ role: "system" as const, content: "S" }] }),
      onPinSystem: () => {},
      onUnpinSystem: () => {},
      onSetRequest: () => {},
      traces: () => traces,
      liveTraceId: () => "b",
    };
    renderSources(v, content, "debug", inputs);
    const tabs = [...v.tabs.querySelectorAll<HTMLButtonElement>(".board-tab")];
    expect(tabs.at(-1)?.textContent).toBe("Trace2");
    tabs.at(-1)!.click();
    const entries = [...v.pane.querySelectorAll(".trace-entry")];
    expect(entries.map((entry) => entry.querySelector(".trace-question")?.textContent)).toEqual(["Why green?", "Teach me leaves"]);
    expect(entries[0]?.querySelector(".trace-selection")?.textContent).toContain("“chlorophyll” · body > p:nth-of-type(1)");
    expect(entries[0]?.querySelector(".trace > summary")?.textContent).toContain("Running");
    expect(entries[0]?.querySelector<HTMLDetailsElement>(".trace")?.open).toBe(true);
    expect(entries[1]?.querySelector<HTMLDetailsElement>(".trace")?.open).toBe(false);
    renderSources(v, content, "clean", inputs);
  });
});
