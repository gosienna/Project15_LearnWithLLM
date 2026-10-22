import type { SelectionAnchor } from "../types.ts";
import { placeNear } from "./ask-popover.ts";

export interface ExplainPopover {
  show: (text: string, anchor: SelectionAnchor | null) => void;
  hide: () => void;
  isOpen: () => boolean;
}

/**
 * A short explanation floating next to the spot the learner asked about. It is not part of the
 * board and is not saved; the learner closes it, or the next ask clears it.
 */
export function renderExplainPopover(host: HTMLElement): ExplainPopover {
  const panel = document.createElement("aside");
  panel.className = "explain-popover";
  panel.hidden = true;
  panel.tabIndex = -1;
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "Explanation");

  const head = document.createElement("div");
  head.className = "explain-head";
  const label = document.createElement("span");
  label.className = "explain-label";
  label.textContent = "Explanation";
  const close = document.createElement("button");
  close.type = "button";
  close.className = "explain-close";
  close.textContent = "×";
  close.setAttribute("aria-label", "Close explanation");
  head.append(label, close);
  const body = document.createElement("div");
  body.className = "explain-body";
  panel.append(head, body);
  host.append(panel);

  const view: ExplainPopover = {
    show(text, anchor) {
      const parts = text.split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean);
      body.replaceChildren(
        ...parts.map((part) => {
          const paragraph = document.createElement("p");
          paragraph.textContent = part;
          return paragraph;
        }),
      );
      panel.hidden = false;
      placeNear(panel, host, anchor?.rect ?? null);
    },
    hide() {
      if (panel.hidden) return;
      panel.hidden = true;
      body.replaceChildren();
    },
    isOpen: () => !panel.hidden,
  };

  close.addEventListener("click", () => view.hide());

  // Drag by the header. Pointer capture keeps the moves coming while the pointer is over the board frame.
  let drag: { id: number; dx: number; dy: number } | null = null;
  head.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || close.contains(event.target as Node)) return;
    event.preventDefault();
    drag = { id: event.pointerId, dx: event.clientX - panel.offsetLeft, dy: event.clientY - panel.offsetTop };
    head.setPointerCapture(event.pointerId);
    panel.classList.add("is-dragging");
  });
  head.addEventListener("pointermove", (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    const maxLeft = Math.max(0, host.clientWidth - panel.offsetWidth);
    const maxTop = Math.max(0, host.clientHeight - panel.offsetHeight);
    panel.style.left = `${Math.min(Math.max(0, event.clientX - drag.dx), maxLeft)}px`;
    panel.style.top = `${Math.min(Math.max(0, event.clientY - drag.dy), maxTop)}px`;
  });
  const endDrag = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.id) return;
    drag = null;
    if (head.hasPointerCapture(event.pointerId)) head.releasePointerCapture(event.pointerId);
    panel.classList.remove("is-dragging");
  };
  head.addEventListener("pointerup", endDrag);
  head.addEventListener("pointercancel", endDrag);
  panel.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    view.hide();
  });

  return view;
}
