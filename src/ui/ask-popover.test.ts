// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import type { SelectionAnchor } from "../types.ts";
import { renderAskPopover } from "./ask-popover.ts";

const anchor: SelectionAnchor = {
  kind: "text",
  component: "html",
  selector: "body > p:nth-of-type(1)",
  tag: "p",
  quote: { exact: "chlorophyll", prefix: "", suffix: "" },
  outerHTML: "<p>chlorophyll</p>",
  rect: { x: 40, y: 30, width: 60, height: 16 },
};

function setup() {
  const host = document.createElement("div");
  document.body.append(host);
  const asked: [string, SelectionAnchor][] = [];
  let cancelled = 0;
  let stopped = 0;
  const popover = renderAskPopover(host, {
    onAsk: (question, at) => asked.push([question, at]),
    onCancel: () => (cancelled += 1),
    onStop: () => (stopped += 1),
  });
  const panel = host.querySelector<HTMLFormElement>(".ask-popover")!;
  const field = panel.querySelector("textarea")!;
  return { host, popover, panel, field, asked, cancelled: () => cancelled, stopped: () => stopped };
}

describe("ask popover", () => {
  it("opens on a selection with its quote and sends the question with the anchor", () => {
    const { popover, panel, field, asked, host } = setup();
    expect(panel.hidden).toBe(true);
    popover.show(anchor);
    expect(panel.hidden).toBe(false);
    expect(panel.querySelector(".ask-quote")?.textContent).toBe("chlorophyll");
    field.value = "What is it?";
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(asked).toEqual([["What is it?", anchor]]);
    expect(popover.question()).toBe("What is it?");
    host.remove();
  });

  it("does not ask while busy or disabled, and Escape cancels", () => {
    const { popover, panel, field, asked, cancelled, host } = setup();
    popover.show(anchor);
    field.value = "Why?";
    popover.setEnabled(false);
    panel.requestSubmit();
    expect(asked).toEqual([]);
    popover.setEnabled(true);
    popover.setBusy(true);
    panel.requestSubmit();
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(asked).toEqual([]);
    expect(panel.hidden).toBe(false);
    popover.setBusy(false);
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(panel.hidden).toBe(true);
    expect(cancelled()).toBe(1);
    expect(popover.anchor()).toBeNull();
    expect(popover.question()).toBe("");
    host.remove();
  });

  it("turns Cancel into Stop while an ask runs", () => {
    const { popover, panel, stopped, cancelled, host } = setup();
    popover.show(anchor);
    popover.setBusy(true);
    const button = panel.querySelector<HTMLButtonElement>(".ask-cancel")!;
    expect(button.textContent).toBe("Stop");
    expect(button.disabled).toBe(false);
    button.click();
    expect(stopped()).toBe(1);
    expect(cancelled()).toBe(0);
    expect(panel.hidden).toBe(false);
    popover.setBusy(false);
    expect(button.textContent).toBe("Cancel");
    host.remove();
  });

  it("closes on an outside click only when nothing is typed", () => {
    const { popover, panel, field, host } = setup();
    popover.show(anchor);
    field.value = "Half typed";
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(panel.hidden).toBe(false);
    field.value = "";
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(panel.hidden).toBe(true);
    host.remove();
  });
});
