import type { SelectionAnchor } from "../types.ts";
import type { EditSlice } from "./whiteboard.ts";

export const EDIT_FIELD_LIMIT = 12;

export interface EditChange {
  component: "html" | "svg";
  find: string;
  replace: string;
}

export interface AskHandlers {
  onAsk: (question: string, anchors: SelectionAnchor[]) => void;
  /** Confirm in Edit mode. Only rows the learner changed are included. */
  onEdit?: (changes: EditChange[]) => void;
  onCancel: () => void;
  /** Stop the running ask. The panel's Cancel button turns into Stop while one runs. */
  onStop?: () => void;
  /** The question or the selection changed. */
  onInput?: () => void;
  /** The stored-source slice for each selected element, in the same order. */
  editSlices?: (anchors: SelectionAnchor[]) => EditSlice[];
}

export interface AskPopover {
  show: (selection: SelectionAnchor | readonly SelectionAnchor[]) => void;
  hide: () => void;
  isOpen: () => boolean;
  anchors: () => SelectionAnchor[];
  /** The first selected element, or null when the panel is closed. */
  anchor: () => SelectionAnchor | null;
  question: () => string;
  /** True when the ask field or an edit field has been changed. */
  hasDraft: () => boolean;
  setEnabled: (enabled: boolean) => void;
  setBusy: (busy: boolean) => void;
  /** A line under the question: progress, or why the ask or edit failed. Null clears it. */
  setStatus: (text: string | null) => void;
}

const GAP = 8;
const WIDTH = 320;
const QUOTE_LIMIT = 140;

/**
 * Put a floating panel in `host` under the rect, or above it when there is no room below.
 * No rect pins it to the top-right corner.
 */
export function placeNear(panel: HTMLElement, host: HTMLElement, rect: SelectionAnchor["rect"] | null, maxWidth = WIDTH): void {
  const width = Math.min(maxWidth, Math.max(0, host.clientWidth - GAP * 2));
  panel.style.width = `${width}px`;
  const height = panel.offsetHeight;
  const maxLeft = Math.max(GAP, host.clientWidth - width - GAP);
  if (!rect) {
    panel.style.left = `${maxLeft}px`;
    panel.style.top = `${GAP}px`;
    return;
  }
  const left = Math.min(Math.max(GAP, rect.x), maxLeft);
  let top = rect.y + rect.height + GAP;
  if (top + height > host.clientHeight - GAP) top = rect.y - height - GAP;
  top = Math.max(GAP, Math.min(top, Math.max(GAP, host.clientHeight - height - GAP)));
  panel.style.left = `${left}px`;
  panel.style.top = `${top}px`;
}

function unionRect(anchors: readonly SelectionAnchor[]): SelectionAnchor["rect"] | null {
  if (anchors.length === 0) return null;
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (const anchor of anchors) {
    x1 = Math.min(x1, anchor.rect.x);
    y1 = Math.min(y1, anchor.rect.y);
    x2 = Math.max(x2, anchor.rect.x + anchor.rect.width);
    y2 = Math.max(y2, anchor.rect.y + anchor.rect.height);
  }
  return { x: x1, y: y1, width: Math.max(0, x2 - x1), height: Math.max(0, y2 - y1) };
}

function quoteText(anchors: readonly SelectionAnchor[]): string {
  if (anchors.length === 1) {
    const text = anchors[0]!.quote.exact || `<${anchors[0]!.tag}>`;
    return text.length > QUOTE_LIMIT ? `${text.slice(0, QUOTE_LIMIT)}…` : text;
  }
  const tags = anchors.slice(0, 8).map((anchor) => anchor.tag).join(", ");
  return `${anchors.length} selected: ${tags}`;
}

function anchorKey(anchor: SelectionAnchor): string {
  return `${anchor.kind}\0${anchor.component}\0${anchor.selector}\0${anchor.quote.exact}`;
}

interface EditRow {
  key: string;
  component: "html" | "svg";
  tag: string;
  find: string;
  value: string;
  error?: string;
  note?: string;
}

/** The panel for a question or an edit of the current selection, placed next to that spot. */
export function renderAskPopover(host: HTMLElement, handlers: AskHandlers): AskPopover {
  const panel = document.createElement("form");
  panel.className = "ask-popover";
  panel.hidden = true;
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "Ask or edit the selection");

  const modes = document.createElement("div");
  modes.className = "ask-modes";
  modes.setAttribute("role", "tablist");
  const askTab = document.createElement("button");
  askTab.type = "button";
  askTab.className = "ask-mode is-active";
  askTab.textContent = "Ask";
  askTab.setAttribute("role", "tab");
  const editTab = document.createElement("button");
  editTab.type = "button";
  editTab.className = "ask-mode";
  editTab.textContent = "Edit";
  editTab.setAttribute("role", "tab");
  modes.append(askTab, editTab);

  const quote = document.createElement("blockquote");
  quote.className = "ask-quote";
  const field = document.createElement("textarea");
  field.className = "ask-field";
  field.rows = 2;
  field.placeholder = "Ask about this…";
  field.setAttribute("aria-label", "Question about the selection");
  const edits = document.createElement("div");
  edits.className = "ask-edits";
  edits.hidden = true;
  const extra = document.createElement("p");
  extra.className = "ask-extra";
  extra.hidden = true;
  const status = document.createElement("p");
  status.className = "ask-status";
  status.hidden = true;
  const go = document.createElement("button");
  go.type = "submit";
  go.className = "ask-go";
  go.textContent = "Ask";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "ask-cancel";
  cancel.textContent = "Cancel";
  const actions = document.createElement("div");
  actions.className = "ask-actions";
  actions.append(cancel, go);
  panel.append(modes, quote, field, edits, extra, status, actions);
  host.append(panel);

  let current: SelectionAnchor[] = [];
  let rows: EditRow[] = [];
  let mode: "ask" | "edit" = "ask";
  let enabled = true;
  let busy = false;

  const editable = () => rows.some((row) => !row.error);

  const sync = () => {
    const editing = mode === "edit";
    askTab.classList.toggle("is-active", !editing);
    editTab.classList.toggle("is-active", editing);
    askTab.setAttribute("aria-selected", editing ? "false" : "true");
    editTab.setAttribute("aria-selected", editing ? "true" : "false");
    askTab.disabled = busy;
    editTab.disabled = busy;
    field.hidden = editing;
    field.disabled = busy;
    edits.hidden = !editing;
    extra.hidden = !editing || current.length <= EDIT_FIELD_LIMIT;
    go.textContent = editing ? "Confirm" : "Ask";
    go.disabled = busy || !enabled || (editing && !editable());
    cancel.textContent = busy ? "Stop" : "Cancel";
    cancel.classList.toggle("is-stop", busy);
    for (const area of edits.querySelectorAll("textarea")) area.disabled = busy;
  };

  const place = () => placeNear(panel, host, unionRect(current));

  const paintEdits = () => {
    edits.replaceChildren();
    for (const row of rows) {
      const block = document.createElement("label");
      block.className = "ask-edit";
      const tag = document.createElement("span");
      tag.className = "ask-edit-tag";
      tag.textContent = `${row.tag} · ${row.component.toUpperCase()}`;
      const area = document.createElement("textarea");
      area.className = "ask-field";
      area.rows = 3;
      area.value = row.value;
      area.disabled = busy || !!row.error;
      area.setAttribute("aria-label", `Edit ${row.tag}`);
      area.addEventListener("input", () => {
        row.value = area.value;
        handlers.onInput?.();
      });
      block.append(tag, area);
      if (row.note) {
        const note = document.createElement("span");
        note.className = "ask-edit-note";
        note.textContent = row.note;
        block.append(note);
      }
      if (row.error) {
        const error = document.createElement("span");
        error.className = "ask-edit-error";
        error.textContent = row.error;
        block.append(error);
      }
      edits.append(block);
    }
    const leftOut = current.length - EDIT_FIELD_LIMIT;
    extra.textContent = leftOut > 0 ? `${leftOut} more are included when you ask, and left out of Edit.` : "";
  };

  const refreshRows = (anchors: SelectionAnchor[]) => {
    const slices = handlers.editSlices?.(anchors) ?? [];
    const previous = new Map(rows.map((row) => [row.key, row]));
    rows = anchors.slice(0, EDIT_FIELD_LIMIT).map((anchor, index) => {
      const key = anchorKey(anchor);
      const old = previous.get(key);
      if (old && old.value !== old.find) return { ...old, tag: anchor.tag };
      const slice = slices[index] ?? { component: anchor.component, find: "", error: "This selection can't be edited." };
      return {
        key,
        component: slice.component,
        tag: anchor.tag,
        find: slice.find,
        value: slice.find,
        error: slice.error,
        note: slice.note,
      };
    });
    paintEdits();
  };

  const view: AskPopover = {
    show(selection) {
      if (busy) return;
      const next = Array.isArray(selection) ? [...selection] : [selection];
      if (next.length === 0) return;
      const moved = next.length !== current.length || next.some((anchor, index) => anchorKey(anchor) !== anchorKey(current[index]!));
      current = next;
      quote.textContent = quoteText(current);
      quote.dataset.kind = current.length === 1 ? current[0]!.kind : "many";
      refreshRows(current);
      if (moved) view.setStatus(null);
      panel.hidden = false;
      sync();
      place();
      if (mode === "edit") edits.querySelector("textarea")?.focus();
      else field.focus();
      handlers.onInput?.();
    },
    hide() {
      if (panel.hidden) return;
      panel.hidden = true;
      current = [];
      rows = [];
      field.value = "";
      mode = "ask";
      paintEdits();
      sync();
      view.setStatus(null);
      handlers.onInput?.();
    },
    isOpen: () => !panel.hidden,
    anchors: () => current.map((anchor) => ({ ...anchor, quote: { ...anchor.quote }, rect: { ...anchor.rect } })),
    anchor: () => current[0] ?? null,
    question: () => field.value,
    hasDraft: () => field.value.trim().length > 0 || rows.some((row) => row.value !== row.find),
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
      if (current.length && !panel.hidden) place();
    },
  };

  const setMode = (next: "ask" | "edit") => {
    if (busy || mode === next) return;
    mode = next;
    if (next === "edit") refreshRows(current);
    sync();
    place();
    if (next === "edit") edits.querySelector("textarea")?.focus();
    else field.focus();
    handlers.onInput?.();
  };

  const cancelNow = () => {
    if (busy) return;
    view.hide();
    handlers.onCancel();
  };

  askTab.addEventListener("click", () => setMode("ask"));
  editTab.addEventListener("click", () => setMode("edit"));
  panel.addEventListener("submit", (event) => {
    event.preventDefault();
    if (go.disabled || current.length === 0) return;
    if (mode === "edit") {
      const changes = rows
        .filter((row) => !row.error && row.value !== row.find)
        .map((row) => ({ component: row.component, find: row.find, replace: row.value }));
      if (changes.length === 0) return;
      handlers.onEdit?.(changes);
      return;
    }
    const question = field.value.trim();
    if (!question) return;
    handlers.onAsk(question, view.anchors());
  });
  panel.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      cancelNow();
      return;
    }
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
    if (!(event.target instanceof HTMLTextAreaElement)) return;
    event.preventDefault();
    panel.requestSubmit();
  }, true);
  field.addEventListener("input", () => handlers.onInput?.());
  cancel.addEventListener("click", () => {
    if (busy) handlers.onStop?.();
    else cancelNow();
  });
  // A click elsewhere in the app closes an empty panel; a typed question or edit stays until Cancel or Escape.
  document.addEventListener("mousedown", (event) => {
    if (panel.hidden || panel.contains(event.target as Node) || view.hasDraft()) return;
    cancelNow();
  });

  sync();
  return view;
}
