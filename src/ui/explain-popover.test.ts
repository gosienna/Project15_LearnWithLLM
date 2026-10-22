// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import type { SelectionAnchor } from "../types.ts";
import { renderExplainPopover } from "./explain-popover.ts";

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
  const popover = renderExplainPopover(host);
  const panel = host.querySelector<HTMLElement>(".explain-popover")!;
  return { host, popover, panel };
}

describe("explain popover", () => {
  it("shows the explanation as text, one paragraph per block", () => {
    const { popover, panel } = setup();
    expect(panel.hidden).toBe(true);
    popover.show("A green <b>pigment</b>.\n\nIt absorbs light.", anchor);
    expect(popover.isOpen()).toBe(true);
    const paragraphs = [...panel.querySelectorAll(".explain-body p")].map((p) => p.textContent);
    expect(paragraphs).toEqual(["A green <b>pigment</b>.", "It absorbs light."]);
    expect(panel.querySelector("b")).toBeNull();
  });

  it("closes with the × button and with hide", () => {
    const { popover, panel } = setup();
    popover.show("A green pigment.", anchor);
    panel.querySelector<HTMLButtonElement>(".explain-close")!.click();
    expect(panel.hidden).toBe(true);
    expect(panel.querySelector(".explain-body")?.childElementCount).toBe(0);

    popover.show("Again.", null);
    expect(popover.isOpen()).toBe(true);
    popover.hide();
    expect(popover.isOpen()).toBe(false);
  });
  it("moves with a drag on its header, but not from the × button", () => {
    const { host, popover, panel } = setup();
    Object.defineProperty(host, "clientWidth", { value: 800 });
    Object.defineProperty(host, "clientHeight", { value: 600 });
    popover.show("A green pigment.", null);
    panel.style.left = "0px";
    panel.style.top = "0px";
    const head = panel.querySelector<HTMLElement>(".explain-head")!;
    const pointer = (type: string, x: number, y: number, target: Element = head) =>
      target.dispatchEvent(new PointerEvent(type, { bubbles: true, button: 0, pointerId: 1, clientX: x, clientY: y }));

    pointer("pointerdown", 10, 10);
    pointer("pointermove", 110, 60);
    pointer("pointerup", 110, 60);
    expect(panel.style.left).toBe("100px");
    expect(panel.style.top).toBe("50px");

    pointer("pointermove", 300, 300);
    expect(panel.style.left).toBe("100px");

    pointer("pointerdown", 10, 10, panel.querySelector(".explain-close")!);
    pointer("pointermove", 300, 300);
    expect(panel.style.left).toBe("100px");
  });
});
