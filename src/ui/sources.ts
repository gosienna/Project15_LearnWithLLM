import { BOARD_COMPONENTS, type BoardComponent, type BoardSources, type PromptMessage, type SelectionAnchor, type TurnTrace } from "../types.ts";
import type { UiMode } from "./mode.ts";
import {
  releaseRequestEditor,
  renderRequestEditor,
  renderSystemEditor,
  type RequestPreview,
  type SystemPromptState,
} from "./request-editor.ts";
import { renderTraceList } from "./trace-view.ts";

export type SourceTab = "preview" | BoardComponent | "material" | "system" | "request" | "trace";

export const SOURCE_TABS: readonly SourceTab[] = ["preview", ...BOARD_COMPONENTS, "material", "system", "request", "trace"];

const INPUT_TABS: readonly SourceTab[] = ["system", "request", "trace"];

const TAB_LABELS: Record<SourceTab, string> = {
  preview: "Preview",
  html: "HTML",
  css: "CSS",
  js: "JS",
  svg: "SVG",
  json: "JSON",
  material: "Material",
  system: "System prompt",
  request: "Next request",
  trace: "Trace",
};

export interface SourceView {
  tabs: HTMLElement;
  board: HTMLElement;
  pane: HTMLElement;
}

export interface SourceContent extends BoardSources {
  material: string;
}

/** The model input of the open topic. Read lazily: building it costs a prompt build per paint. */
export interface PromptInputs {
  topicId: string;
  system: () => SystemPromptState;
  request: () => RequestPreview;
  onPinSystem: (text: string) => void;
  onUnpinSystem: () => void;
  onSetRequest: (prompts: PromptMessage[] | null) => void;
  /** The prompt the next ask sends, built from the open question and selection. */
  prompt?: () => string;
  selection?: () => SelectionAnchor | null;
  subscribePrompt?: (listener: () => void) => () => void;
  /** This visit's asks, newest first, and the id of the one running. */
  traces?: () => TurnTrace[];
  liveTraceId?: () => string | null;
}

let selected: SourceTab = "preview";
/** What each pane shows now, so a repaint during streaming keeps its scroll position. */
const shown = new WeakMap<HTMLElement, string>();
/** Panes holding an unsaved edit, and for which tab and topic. Repaints leave them alone until it is saved or reverted. */
const dirty = new WeakMap<HTMLElement, string>();
/** Which trace sections are open; the Trace tab is rebuilt on every streamed chunk. */
const traceOpen = new Set<string>();

export function selectedSourceTab(): SourceTab {
  return selected;
}

/**
 * Debug mode: a tab row over the board with each raw source and the model input. The preview
 * iframe is only hidden while another tab is open, so switching tabs never reloads the lesson.
 */
export function renderSources(view: SourceView, content: SourceContent, mode: UiMode, inputs?: PromptInputs): void {
  const debug = mode === "debug";
  const tabs = SOURCE_TABS.filter((id) => inputs || !INPUT_TABS.includes(id));
  const tab: SourceTab = debug && tabs.includes(selected) ? selected : "preview";
  if (tab !== "request") releaseRequestEditor(view.pane);
  view.tabs.hidden = !debug;
  view.board.hidden = tab !== "preview";
  view.pane.hidden = tab === "preview";

  if (!debug || tab === "preview") {
    if (!debug) view.tabs.replaceChildren();
    view.pane.replaceChildren();
    shown.delete(view.pane);
    dirty.delete(view.pane);
    if (!debug) return;
  }

  view.tabs.replaceChildren(
    ...tabs.map((id) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "board-tab";
      button.setAttribute("role", "tab");
      button.setAttribute("aria-selected", id === tab ? "true" : "false");
      const label = document.createElement("span");
      label.textContent = TAB_LABELS[id];
      button.append(label);
      const count = tabCount(id, content, inputs);
      if (count !== undefined) {
        const badge = document.createElement("span");
        badge.className = "board-tab-count";
        badge.textContent = String(count);
        button.append(badge);
      }
      button.addEventListener("click", () => {
        if (id === selected) return;
        selected = id;
        dirty.delete(view.pane);
        renderSources(view, content, mode, inputs);
      });
      return button;
    }),
  );

  if (tab === "preview") return;
  if (tab === "trace") {
    shown.delete(view.pane);
    renderTraceList(view.pane, inputs?.traces?.() ?? [], traceOpen, inputs?.liveTraceId?.() ?? null);
    return;
  }
  if (tab === "system" || tab === "request") {
    renderInputTab(view.pane, tab, inputs!);
    return;
  }

  const text = content[tab];
  const key = `${tab}\u0000${text}`;
  if (shown.get(view.pane) === key) return;
  shown.set(view.pane, key);
  const header = document.createElement("div");
  header.className = "source-header";
  const meta = document.createElement("p");
  meta.className = "source-meta";
  meta.textContent = `${TAB_LABELS[tab]} · ${text.length} characters · read-only`;
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "source-copy";
  copy.textContent = "Copy";
  copy.disabled = !text;
  copy.addEventListener("click", () => {
    void navigator.clipboard?.writeText(text).then(
      () => (copy.textContent = "Copied"),
      () => (copy.textContent = "Copy failed"),
    );
  });
  header.append(meta, copy);

  const pre = document.createElement("pre");
  pre.className = "source-code";
  const code = document.createElement("code");
  code.textContent = text || "(empty)";
  if (!text) pre.classList.add("is-empty");
  pre.append(code);
  view.pane.replaceChildren(header, pre);
}

/** Characters of a source, or the number of traces; nothing for the other tabs. */
function tabCount(id: SourceTab, content: SourceContent, inputs?: PromptInputs): number | undefined {
  if (id === "trace") return inputs?.traces?.().length ?? 0;
  if (id === "preview" || id === "system" || id === "request") return undefined;
  return content[id].length;
}

function renderInputTab(pane: HTMLElement, tab: "system" | "request", inputs: PromptInputs): void {
  const editing = `${tab}\u0000${inputs.topicId}`;
  if (dirty.get(pane) === editing) return;
  dirty.delete(pane);
  const handlers = {
    onDirty: () => dirty.set(pane, editing),
    onDone: () => {
      dirty.delete(pane);
      shown.delete(pane);
    },
  };
  if (tab === "system") {
    const state = inputs.system();
    const key = `system\u0000${inputs.topicId}\u0000${state.pinned}\u0000${state.text}`;
    if (shown.get(pane) === key) return;
    shown.set(pane, key);
    renderSystemEditor(pane, state, { ...handlers, onPin: inputs.onPinSystem, onUnpin: inputs.onUnpinSystem });
    return;
  }
  const preview = inputs.request();
  const key = `request\u0000${inputs.topicId}\u0000${JSON.stringify(preview)}`;
  if (shown.get(pane) === key) return;
  shown.set(pane, key);
  renderRequestEditor(pane, preview, {
    ...handlers,
    onUse: (prompts) => inputs.onSetRequest(prompts),
    onDiscard: () => inputs.onSetRequest(null),
    prompt: inputs.prompt,
    selection: inputs.selection,
    subscribePrompt: inputs.subscribePrompt,
  });
}
