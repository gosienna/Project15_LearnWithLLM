import type { SelectionAnchor } from "../types.ts";

export interface AskHandlers {
  onAsk: (question: string, anchor: SelectionAnchor) => void;
  onCancel: () => void;
  /** The question or the selection changed. */
  onInput?: () => void;
}

export interface AskPopover {
  show: (anchor: SelectionAnchor) => void;
  hide: () => void;
  isOpen: () => boolean;
  anchor: () => SelectionAnchor | null;
  question: () => string;
  setEnabled: (enabled: boolean) => void;
  setBusy: (busy: boolean) => void;
  /** A line under the question: progress, or why the ask failed. Null clears it. */
  setStatus: (text: string | null) => void;
}

const GAP = 8;
const WIDTH = 320;
const QUOTE_LIMIT = 140;

function quoteText(anchor: SelectionAnchor): string {
  const text = anchor.quote.exact || `<${anchor.tag}>`;
  return text.length > QUOTE_LIMIT ? `${text.slice(0, QUOTE_LIMIT)}…` : text;
}

/** The panel for a question about one spot on the board, placed next to that spot. */
export function renderAskPopover(host: HTMLElement, handlers: AskHandlers): AskPopover {
  const panel = document.createElement("form");
  panel.className = "ask-popover";
  panel.hidden = true;
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "Ask about the selection");

  const quote = document.createElement("blockquote");
  quote.className = "ask-quote";
  const field = document.createElement("textarea");
  field.className = "ask-field";
  field.rows = 2;
  field.placeholder = "Ask about this…";
  field.setAttribute("aria-label", "Question about the selection");
  const status = document.createElement("p");
  status.className = "ask-status";
  status.hidden = true;
  const ask = document.createElement("button");
  ask.type = "submit";
  ask.className = "ask-go";
  ask.textContent = "Ask";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "ask-cancel";
  cancel.textContent = "Cancel";
  const actions = document.createElement("div");
  actions.className = "ask-actions";
  actions.append(cancel, ask);
  panel.append(quote, field, status, actions);
  host.append(panel);

  let current: SelectionAnchor | null = null;
  let enabled = true;
  let busy = false;

  const sync = () => {
    field.disabled = busy;
    ask.disabled = busy || !enabled;
    cancel.disabled = busy;
  };

  const place = (anchor: SelectionAnchor) => {
    const width = Math.min(WIDTH, Math.max(0, host.clientWidth - GAP * 2));
    panel.style.width = `${width}px`;
    const height = panel.offsetHeight;
    const maxLeft = Math.max(GAP, host.clientWidth - width - GAP);
    const left = Math.min(Math.max(GAP, anchor.rect.x), maxLeft);
    let top = anchor.rect.y + anchor.rect.height + GAP;
    if (top + height > host.clientHeight - GAP) top = anchor.rect.y - height - GAP;
    top = Math.max(GAP, Math.min(top, Math.max(GAP, host.clientHeight - height - GAP)));
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
  };

  const view: AskPopover = {
    show(anchor) {
      if (busy) return;
      const moved = current?.selector !== anchor.selector || current?.quote.exact !== anchor.quote.exact;
      current = anchor;
      quote.textContent = quoteText(anchor);
      quote.dataset.kind = anchor.kind;
      if (moved) view.setStatus(null);
      panel.hidden = false;
      place(anchor);
      field.focus();
      handlers.onInput?.();
    },
    hide() {
      if (panel.hidden) return;
      panel.hidden = true;
      current = null;
      field.value = "";
      view.setStatus(null);
      handlers.onInput?.();
    },
    isOpen: () => !panel.hidden,
    anchor: () => current,
    question: () => field.value,
    setEnabled(next) {
      enabled = next;
      sync();
    },
    setBusy(next) {
      busy = next;
      sync();
    },
    setStatus(text) {
      status.hidden = !text;
      status.textContent = text ?? "";
      if (current && !panel.hidden) place(current);
    },
  };

  const cancelNow = () => {
    if (busy) return;
    view.hide();
    handlers.onCancel();
  };

  panel.addEventListener("submit", (event) => {
    event.preventDefault();
    const question = field.value.trim();
    if (!question || !current || ask.disabled) return;
    handlers.onAsk(question, current);
  });
  field.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      cancelNow();
      return;
    }
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    panel.requestSubmit();
  });
  field.addEventListener("input", () => handlers.onInput?.());
  cancel.addEventListener("click", cancelNow);
  // A click elsewhere in the app closes an empty panel; a typed question stays until Cancel or Escape.
  document.addEventListener("mousedown", (event) => {
    if (panel.hidden || panel.contains(event.target as Node) || field.value.trim()) return;
    cancelNow();
  });

  sync();
  return view;
}
