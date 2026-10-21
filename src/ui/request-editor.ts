import { WHITEBOARD_TOOL_SPECS } from "../llm/tools.ts";
import type { PromptMessage } from "../types.ts";
import { createJsonTreeState, renderJsonTree, type JsonTreeState } from "./json-tree.ts";

export interface SystemPromptState {
  text: string;
  pinned: boolean;
}

export interface RequestPreview {
  newSession: boolean;
  edited: boolean;
  initialPrompts: PromptMessage[];
}

export interface EditorHandlers {
  /** Called on the first change, so repaints leave the editor alone until it is saved or reverted. */
  onDirty: () => void;
  onDone: () => void;
}

const promptWatch = new WeakMap<HTMLElement, () => void>();
const treeState = new WeakMap<HTMLElement, JsonTreeState>();

/** Drop the composer listener when the request tab is no longer showing. */
export function releaseRequestEditor(pane: HTMLElement): void {
  promptWatch.get(pane)?.();
  promptWatch.delete(pane);
}

const ROLES: PromptMessage["role"][] = ["system", "user", "assistant"];

function button(label: string, className: string, onClick: () => void): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button";
  element.className = className;
  element.textContent = label;
  element.addEventListener("click", onClick);
  return element;
}

function note(text: string, className = "editor-note"): HTMLParagraphElement {
  const element = document.createElement("p");
  element.className = className;
  element.textContent = text;
  return element;
}

/** Initial prompts the Prompt API accepts: at least one, known roles, and a system message only first. */
export function validatePrompts(value: unknown): PromptMessage[] | string {
  if (!Array.isArray(value) || value.length === 0) return "Add at least one message.";
  const out: PromptMessage[] = [];
  for (const [index, item] of value.entries()) {
    const message = item as { role?: unknown; content?: unknown };
    if (!message || typeof message !== "object") return `Message ${index + 1} must be an object.`;
    if (!ROLES.includes(message.role as PromptMessage["role"])) {
      return `Message ${index + 1} needs role system, user, or assistant.`;
    }
    if (typeof message.content !== "string") return `Message ${index + 1} needs text content.`;
    if (message.role === "system" && index > 0) return "Only the first message may be a system message.";
    out.push({ role: message.role as PromptMessage["role"], content: message.content });
  }
  return out;
}

export function renderSystemEditor(
  pane: HTMLElement,
  state: SystemPromptState,
  handlers: EditorHandlers & { onPin: (text: string) => void; onUnpin: () => void },
): void {
  const status = note(
    state.pinned
      ? "Pinned to this topic. The board status and stored material no longer update in it."
      : "Automatic. Built from the instructions, the board, and the stored material for each new session.",
    `editor-status${state.pinned ? " is-pinned" : ""}`,
  );
  const field = document.createElement("textarea");
  field.className = "editor-text";
  field.spellcheck = false;
  field.value = state.text;
  field.setAttribute("aria-label", "System prompt");

  const pin = button(state.pinned ? "Save pinned prompt" : "Pin to this topic", "editor-primary", () => {
    handlers.onDone();
    handlers.onPin(field.value);
  });
  pin.disabled = state.pinned;
  const revert = button("Revert edits", "editor-secondary", () => {
    field.value = state.text;
    pin.disabled = state.pinned;
    revert.disabled = true;
    handlers.onDone();
  });
  revert.disabled = true;
  const actions = document.createElement("div");
  actions.className = "editor-actions";
  actions.append(pin, revert);
  if (state.pinned) {
    actions.append(
      button("Unpin, back to automatic", "editor-secondary", () => {
        handlers.onDone();
        handlers.onUnpin();
      }),
    );
  }

  field.addEventListener("input", () => {
    pin.disabled = false;
    revert.disabled = false;
    handlers.onDirty();
  });

  pane.replaceChildren(
    status,
    field,
    actions,
    note(`${state.text.length} characters. Changes apply from the next new session; the next send starts one.`),
  );
}

export function renderRequestEditor(
  pane: HTMLElement,
  preview: RequestPreview,
  handlers: EditorHandlers & {
    onUse: (prompts: PromptMessage[]) => void;
    onDiscard: () => void;
    /** The composer text the next send passes as `prompt`. */
    prompt?: () => string;
    subscribePrompt?: (listener: () => void) => () => void;
  },
): void {
  releaseRequestEditor(pane);
  let rows = preview.initialPrompts.map((message) => ({ ...message }));
  const promptText = () => handlers.prompt?.() ?? "";

  const status = note(
    preview.edited
      ? "Edited. The next send starts a new session from these messages, then sends your typed message as the prompt. The edit is used once."
      : preview.newSession
        ? "The next send starts a new session from these messages, then sends your typed message as the prompt."
        : "The session is reused, so the next send sends only your typed message. The session was created from messages like these; use an edited copy to start a new session from it.",
    `editor-status${preview.edited ? " is-pinned" : ""}`,
  );

  const list = document.createElement("ol");
  list.className = "request-messages";
  const error = note("", "editor-error");
  error.hidden = true;

  const use = button(preview.edited ? "Save edits" : "Use for next send", "editor-primary", () => {
    const checked = validatePrompts(rows);
    if (typeof checked === "string") {
      error.textContent = checked;
      error.hidden = false;
      return;
    }
    handlers.onDone();
    handlers.onUse(checked);
  });
  use.disabled = true;
  const discard = button(preview.edited ? "Discard edits" : "Revert edits", "editor-secondary", () => {
    handlers.onDone();
    if (preview.edited) {
      handlers.onDiscard();
      return;
    }
    rows = preview.initialPrompts.map((message) => ({ ...message }));
    drawRows();
    json.value = rawJson();
    paintTree();
    use.disabled = true;
    discard.disabled = true;
    error.hidden = true;
  });
  discard.disabled = !preview.edited;

  const payload = () => ({
    initialPrompts: rows,
    prompt: promptText(),
    tools: WHITEBOARD_TOOL_SPECS,
  });

  const rawJson = () => JSON.stringify(payload(), null, 2);

  const treeHost = document.createElement("div");
  treeHost.className = "json-tree";
  treeHost.setAttribute("aria-label", "Request JSON");
  const openState = treeState.get(pane) ?? createJsonTreeState();
  treeState.set(pane, openState);
  const paintTree = () => renderJsonTree(treeHost, payload(), openState);

  const changed = () => {
    use.disabled = false;
    discard.disabled = false;
    error.hidden = true;
    jsonTouched = false;
    json.value = rawJson();
    paintTree();
    handlers.onDirty();
  };

  function drawRows(): void {
    list.replaceChildren(
      ...rows.map((message, index) => {
        const item = document.createElement("li");
        item.className = "request-message";
        const head = document.createElement("div");
        head.className = "request-message-head";
        const role = document.createElement("select");
        role.setAttribute("aria-label", `Role of message ${index + 1}`);
        for (const value of ROLES) {
          const option = document.createElement("option");
          option.value = value;
          option.textContent = value;
          role.append(option);
        }
        role.value = message.role;
        role.addEventListener("change", () => {
          message.role = role.value as PromptMessage["role"];
          changed();
        });
        const count = note(`initialPrompts[${index}] · ${message.content.length} chars`, "request-message-meta");
        const remove = button("Remove", "editor-link", () => {
          rows.splice(index, 1);
          drawRows();
          changed();
        });
        head.append(role, count, remove);
        const text = document.createElement("textarea");
        text.className = "editor-text request-text";
        text.spellcheck = false;
        text.value = message.content;
        text.rows = Math.min(16, Math.max(2, message.content.split("\n").length));
        text.setAttribute("aria-label", `Content of message ${index + 1}`);
        text.addEventListener("input", () => {
          message.content = text.value;
          count.textContent = `initialPrompts[${index}] · ${text.value.length} chars`;
          changed();
        });
        item.append(head, text);
        return item;
      }),
    );
  }
  drawRows();

  const add = button("Add message", "editor-secondary", () => {
    rows.push({ role: rows.length === 0 ? "system" : "user", content: "" });
    drawRows();
    changed();
  });

  const raw = document.createElement("details");
  raw.className = "request-raw";
  const rawLabel = document.createElement("summary");
  rawLabel.textContent = "Raw JSON";
  paintTree();
  const edit = document.createElement("details");
  edit.className = "request-edit-json";
  const editLabel = document.createElement("summary");
  editLabel.textContent = "Edit JSON";
  const json = document.createElement("textarea");
  json.className = "editor-text request-json";
  json.spellcheck = false;
  json.value = rawJson();
  json.setAttribute("aria-label", "Raw request JSON");
  let jsonTouched = false;
  json.addEventListener("input", () => {
    jsonTouched = true;
    handlers.onDirty();
  });
  const apply = button("Apply JSON", "editor-secondary", () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json.value);
    } catch {
      error.textContent = "The JSON does not parse.";
      error.hidden = false;
      return;
    }
    const checked = validatePrompts((parsed as { initialPrompts?: unknown })?.initialPrompts);
    if (typeof checked === "string") {
      error.textContent = checked;
      error.hidden = false;
      return;
    }
    rows = checked;
    drawRows();
    jsonTouched = false;
    changed();
  });
  edit.append(
    editLabel,
    json,
    note("Only initialPrompts is editable here. prompt is the composer text. tools are the declarations sent with the session."),
    apply,
  );
  raw.append(rawLabel, treeHost, edit);
  if (handlers.subscribePrompt) {
    promptWatch.set(
      pane,
      handlers.subscribePrompt(() => {
        if (!pane.isConnected || jsonTouched) return;
        json.value = rawJson();
        paintTree();
      }),
    );
  }

  const actions = document.createElement("div");
  actions.className = "editor-actions";
  actions.append(use, discard, add);

  pane.replaceChildren(status, list, actions, error, raw);
}
