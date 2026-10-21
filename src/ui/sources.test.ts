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
      request: () => ({ newSession: true, edited: false, initialPrompts: [{ role: "system" as const, content: system.text }] }),
      onPinSystem: () => {},
      onUnpinSystem: () => {},
      onSetRequest: () => {},
    };
    renderSources(v, content, "debug", inputs);
    const tabs = [...v.tabs.querySelectorAll<HTMLButtonElement>(".board-tab")];
    expect(tabs.at(-2)?.textContent).toBe("System prompt");
    expect(tabs.at(-1)?.textContent).toBe("Next request");
    tabs.at(-2)!.click();
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
});
