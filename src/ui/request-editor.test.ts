// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import type { PromptMessage } from "../types.ts";
import { renderRequestEditor, renderSystemEditor, validatePrompts } from "./request-editor.ts";

describe("initial prompt validation", () => {
  it("accepts a system message first and rejects one later", () => {
    expect(validatePrompts([{ role: "system", content: "S" }, { role: "user", content: "U" }])).toEqual([
      { role: "system", content: "S" },
      { role: "user", content: "U" },
    ]);
    expect(validatePrompts([{ role: "user", content: "U" }, { role: "system", content: "S" }])).toBe(
      "Only the first message may be a system message.",
    );
    expect(validatePrompts([])).toBe("Add at least one message.");
    expect(validatePrompts([{ role: "tool", content: "x" }])).toContain("role");
    expect(validatePrompts([{ role: "user", content: 3 }])).toContain("text content");
  });
});

describe("prompt editors", () => {
  const noop = { onDirty: () => {}, onDone: () => {} };

  it("pins an edited system prompt", () => {
    const pane = document.createElement("section");
    const pinned: string[] = [];
    renderSystemEditor(pane, { text: "Automatic.", pinned: false }, { ...noop, onPin: (text) => pinned.push(text), onUnpin: () => {} });
    const field = pane.querySelector("textarea")!;
    field.value = "My own prompt.";
    field.dispatchEvent(new Event("input"));
    pane.querySelector<HTMLButtonElement>(".editor-primary")!.click();
    expect(pinned).toEqual(["My own prompt."]);
  });

  it("edits a message and refuses an invalid request", () => {
    const pane = document.createElement("section");
    const used: PromptMessage[][] = [];
    let dirty = 0;
    renderRequestEditor(
      pane,
      { newSession: false, edited: false, initialPrompts: [{ role: "system", content: "S" }, { role: "user", content: "U" }] },
      { onDirty: () => (dirty += 1), onDone: () => {}, onUse: (prompts) => used.push(prompts), onDiscard: () => {} },
    );
    expect(pane.textContent).toContain("The session is reused");
    const texts = pane.querySelectorAll<HTMLTextAreaElement>(".request-text");
    texts[1]!.value = "Edited user turn";
    texts[1]!.dispatchEvent(new Event("input"));
    expect(dirty).toBe(1);
    expect(pane.querySelector<HTMLTextAreaElement>(".request-json")!.value).toContain("Edited user turn");

    const role = pane.querySelectorAll<HTMLSelectElement>("select")[1]!;
    role.value = "system";
    role.dispatchEvent(new Event("change"));
    pane.querySelector<HTMLButtonElement>(".editor-primary")!.click();
    expect(used).toEqual([]);
    expect(pane.querySelector(".editor-error")?.textContent).toBe("Only the first message may be a system message.");

    role.value = "user";
    role.dispatchEvent(new Event("change"));
    pane.querySelector<HTMLButtonElement>(".editor-primary")!.click();
    expect(used).toEqual([[{ role: "system", content: "S" }, { role: "user", content: "Edited user turn" }]]);
  });

  it("shows the composer text and the tool declarations in the raw JSON", () => {
    const pane = document.createElement("section");
    document.body.append(pane);
    let draft = "What is a cell?";
    const listeners = new Set<() => void>();
    renderRequestEditor(
      pane,
      { newSession: true, edited: false, initialPrompts: [{ role: "system", content: "Teach with the whiteboard." }] },
      {
        ...noop,
        onUse: () => {},
        onDiscard: () => {},
        prompt: () => draft,
        subscribePrompt: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
    );
    const json = () => JSON.parse(pane.querySelector<HTMLTextAreaElement>(".request-json")!.value) as {
      prompt: string;
      tools: { name: string; description: string; inputSchema: { properties?: Record<string, unknown> } }[];
    };
    expect(json().prompt).toBe("What is a cell?");
    const view = json().tools.find((tool) => tool.name === "whiteboard_view");
    expect(view?.description).toContain("whiteboard source");
    expect(view?.inputSchema.properties).toHaveProperty("component");
    expect(json().tools.map((tool) => tool.name)).toEqual([
      "whiteboard_view",
      "whiteboard_set",
      "whiteboard_snapshot",
      "whiteboard_store_material",
    ]);

    const tool = pane.querySelector<HTMLDetailsElement>('[data-path="tools[0]"]')!;
    expect(tool.open).toBe(false);
    expect(tool.querySelector("summary")?.textContent).toContain("whiteboard_view");
    tool.open = true;
    tool.dispatchEvent(new Event("toggle"));
    expect(tool.textContent).toContain("inputSchema");

    const prompts = pane.querySelector<HTMLDetailsElement>('[data-path="initialPrompts"]')!;
    prompts.open = false;
    prompts.dispatchEvent(new Event("toggle"));
    draft = "Draw the membrane.";
    for (const listener of listeners) listener();
    expect(json().prompt).toBe("Draw the membrane.");
    expect(pane.querySelector('[data-path="prompt"]')?.textContent).toContain("Draw the membrane.");
    expect(pane.querySelector<HTMLDetailsElement>('[data-path="tools[0]"]')!.open).toBe(true);
    expect(pane.querySelector<HTMLDetailsElement>('[data-path="initialPrompts"]')!.open).toBe(false);
    pane.remove();
  });
});
