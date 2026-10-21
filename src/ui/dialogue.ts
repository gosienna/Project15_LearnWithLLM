import type { DialogueMessage, RequestInput, TraceEvent, TurnTrace } from "../types.ts";
import type { StreamState } from "../llm/turn.ts";
import type { UiMode } from "./mode.ts";

export interface DialogueHandlers {
  onSend: (text: string) => void;
  onStop: () => void;
}

export interface DialogueView {
  setStatus: (header: string, detail: string) => void;
  setComposerEnabled: (enabled: boolean) => void;
  setBusy: (busy: boolean) => void;
  setError: (message: string | null) => void;
  renderTranscript: (messages: DialogueMessage[], stream: StreamState | null, mode?: UiMode) => void;
  focus: () => void;
  /** The unsent composer text. */
  draft: () => string;
  subscribeDraft: (listener: () => void) => () => void;
}

export function renderDialogue(host: HTMLElement, handlers: DialogueHandlers): DialogueView {
  host.replaceChildren();

  const header = document.createElement("header");
  header.className = "dialogue-header";
  const name = document.createElement("p");
  name.className = "model-name";
  const detail = document.createElement("p");
  detail.className = "model-status";
  header.append(name, detail);

  const transcript = document.createElement("div");
  transcript.className = "transcript";
  transcript.setAttribute("role", "log");
  transcript.setAttribute("aria-live", "polite");

  const note = document.createElement("p");
  note.className = "error-note";
  note.hidden = true;

  const composer = document.createElement("form");
  composer.className = "composer";
  const label = document.createElement("label");
  label.className = "composer-label";
  const field = document.createElement("textarea");
  field.rows = 3;
  field.placeholder = "Type a topic or a question";
  field.setAttribute("aria-label", "Message");
  label.append(field);

  const send = document.createElement("button");
  send.type = "submit";
  send.className = "send";
  send.textContent = "Send";

  const stop = document.createElement("button");
  stop.type = "button";
  stop.className = "stop";
  stop.textContent = "Stop";
  stop.hidden = true;

  composer.append(label, send, stop);

  let composerEnabled = false;
  let busy = false;

  const syncComposer = () => {
    const enabled = composerEnabled && !busy;
    field.disabled = !enabled;
    send.disabled = !enabled;
    send.hidden = busy;
    stop.hidden = !busy;
    stop.disabled = !busy;
  };

  const draftListeners = new Set<() => void>();
  const notifyDraft = () => {
    for (const listener of draftListeners) listener();
  };

  composer.addEventListener("submit", (event) => {
    event.preventDefault();
    const text = field.value.trim();
    if (!text || !composerEnabled || busy) return;
    field.value = "";
    notifyDraft();
    handlers.onSend(text);
  });
  field.addEventListener("input", notifyDraft);

  field.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    composer.requestSubmit();
  });

  stop.addEventListener("click", () => handlers.onStop());

  host.append(header, transcript, note, composer);

  // The transcript is rebuilt on every streamed chunk; remember which trace sections are open.
  const openKeys = new Set<string>(["live"]);

  const appendBubble = (role: "user" | "assistant" | "status", text: string, trace?: HTMLElement) => {
    const bubble = document.createElement("article");
    bubble.className = `bubble bubble-${role}`;
    const who = document.createElement("p");
    who.className = "bubble-role";
    who.textContent = role === "user" ? "You" : "Tutor";
    const body = document.createElement("p");
    body.className = "bubble-body";
    body.textContent = text;
    if (role === "status") {
      bubble.className = "bubble bubble-assistant is-status";
      who.textContent = "Tutor";
    }
    bubble.append(who, body);
    if (trace) bubble.append(trace);
    transcript.append(bubble);
  };

  return {
    setStatus(headerText, detailText) {
      name.textContent = headerText;
      detail.textContent = detailText;
    },
    setComposerEnabled(enabled) {
      composerEnabled = enabled;
      syncComposer();
    },
    setBusy(next) {
      busy = next;
      syncComposer();
    },
    setError(message) {
      note.hidden = !message;
      note.textContent = message ?? "";
    },
    renderTranscript(messages, stream, mode = "clean") {
      const debug = mode === "debug";
      const pinned = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 48;
      const previousTop = transcript.scrollTop;
      transcript.replaceChildren();
      for (const message of messages) {
        if (message.role === "user") {
          appendBubble("user", message.content);
          continue;
        }
        // An empty assistant message is a failed or stopped turn, kept only for its trace.
        if (!debug && !message.content.trim()) continue;
        const trace = debug && message.trace ? renderTrace(message.trace, message.id, openKeys) : undefined;
        appendBubble("assistant", message.content || "(no reply)", trace);
      }
      if (stream) {
        const trace = debug
          ? renderTrace({ modelId: null, startedAt: Date.now(), events: stream.events }, "live", openKeys, true)
          : undefined;
        if (stream.toolActive && !stream.text) appendBubble("status", "Updating the lesson…", trace);
        else appendBubble("assistant", stream.text || "…", trace);
      }
      transcript.scrollTop = pinned ? transcript.scrollHeight : previousTop;
    },
    focus() {
      if (!field.disabled) field.focus();
    },
    draft() {
      return field.value;
    },
    subscribeDraft(listener) {
      draftListeners.add(listener);
      return () => draftListeners.delete(listener);
    },
  };
}

function toolCount(events: TraceEvent[]): number {
  return events.filter((event) => event.kind === "tool").length;
}

function traceSummary(trace: TurnTrace, live: boolean): string {
  const tools = toolCount(trace.events);
  const parts = [live ? "Running" : "Trace", `${tools} tool call${tools === 1 ? "" : "s"}`];
  if (!live && trace.endedAt) parts.push(`${((trace.endedAt - trace.startedAt) / 1000).toFixed(1)} s`);
  if (trace.modelId) parts.push(trace.modelId);
  if (typeof trace.inputUsage === "number") {
    parts.push(`${trace.inputUsage}${typeof trace.inputQuota === "number" ? ` / ${trace.inputQuota}` : ""} tokens`);
  }
  if (trace.fallback) parts.push(`fallback: ${trace.fallback}`);
  if (trace.error) parts.push(trace.error);
  return parts.join(" · ");
}

function section(key: string, openKeys: Set<string>, summary: string, className: string): HTMLDetailsElement {
  const details = document.createElement("details");
  details.className = className;
  details.open = openKeys.has(key);
  details.addEventListener("toggle", () => {
    if (details.open) openKeys.add(key);
    else openKeys.delete(key);
  });
  const label = document.createElement("summary");
  label.textContent = summary;
  details.append(label);
  return details;
}

function codeBlock(text: string): HTMLPreElement {
  const pre = document.createElement("pre");
  pre.className = "trace-code";
  pre.textContent = text;
  return pre;
}

/** A tool value as labelled fields; strings stay raw so html and css read as code, not JSON. */
function valueView(label: string, value: unknown): HTMLElement {
  const box = document.createElement("div");
  box.className = "trace-value";
  const title = document.createElement("p");
  title.className = "trace-label";
  title.textContent = label;
  box.append(title);
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, item] of Object.entries(value)) {
      const field = document.createElement("p");
      field.className = "trace-field";
      field.textContent = key;
      box.append(field, codeBlock(typeof item === "string" ? item : JSON.stringify(item, null, 2) ?? String(item)));
    }
    if (Object.keys(value).length === 0) box.append(codeBlock("{}"));
  } else {
    box.append(codeBlock(typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? String(value)));
  }
  return box;
}

function toolTitle(event: Extract<TraceEvent, { kind: "tool" }>): string {
  const input = event.input as { component?: unknown } | null;
  const target = input && typeof input === "object" && typeof input.component === "string" ? ` ${input.component}` : "";
  const status = event.error ? "failed" : "output" in event ? "ok" : "running";
  const ms = typeof event.ms === "number" ? ` · ${event.ms} ms` : "";
  return `${event.name}${target} · ${status}${ms}`;
}

/** The raw input a turn sent: the new session's initial prompts, then the prompt itself. */
function requestView(request: RequestInput, key: string, openKeys: Set<string>): HTMLElement {
  const prompts = request.initialPrompts ?? [];
  const how = request.newSession ? `new session · ${prompts.length} initial messages` : "reused session · prompt only";
  const details = section(key, openKeys, `Request input · ${how}${request.edited ? " · edited" : ""}`, "trace-detail");
  prompts.forEach((message, index) => {
    const label = document.createElement("p");
    label.className = "trace-field";
    label.textContent = `initialPrompts[${index}] · ${message.role}`;
    details.append(label, codeBlock(message.content));
  });
  const label = document.createElement("p");
  label.className = "trace-field";
  label.textContent = "prompt";
  details.append(label, codeBlock(request.prompt));
  return details;
}

export function renderTrace(trace: TurnTrace, key: string, openKeys: Set<string>, live = false): HTMLElement {
  const root = section(key, openKeys, traceSummary(trace, live), "trace");
  const list = document.createElement("ol");
  list.className = "trace-events";

  let round = 1;
  let afterTool = false;
  const roundMark = () => {
    const mark = document.createElement("li");
    mark.className = "trace-round";
    mark.textContent = `Round ${round}`;
    list.append(mark);
  };
  roundMark();

  trace.events.forEach((event, index) => {
    if (event.kind !== "tool" && afterTool) {
      round += 1;
      roundMark();
    }
    afterTool = event.kind === "tool";
    const item = document.createElement("li");
    item.className = `trace-event trace-${event.kind}`;
    const eventKey = `${key}:${index}`;
    if (event.kind === "text") {
      const title = document.createElement("p");
      title.className = "trace-label";
      title.textContent = "Text";
      item.append(title, codeBlock(event.text));
    } else if (event.kind === "reasoning") {
      const details = section(eventKey, openKeys, `Reasoning · ${event.text.length} chars`, "trace-detail");
      details.append(codeBlock(event.text));
      item.append(details);
    } else {
      const details = section(eventKey, openKeys, toolTitle(event), "trace-detail");
      details.append(valueView("Input", event.input));
      if (event.error) {
        const error = valueView("Error", event.error);
        error.classList.add("is-error");
        details.append(error);
      } else if ("output" in event) {
        details.append(valueView("Output", event.output));
      }
      item.append(details);
    }
    list.append(item);
  });
  if (trace.events.length === 0) {
    const empty = document.createElement("li");
    empty.className = "trace-empty";
    empty.textContent = live ? "Waiting for the model…" : "No events recorded.";
    list.append(empty);
  }
  root.append(list);

  if (trace.rawReply !== undefined) {
    const raw = section(`${key}:raw`, openKeys, `Raw reply, moved to the whiteboard · ${trace.rawReply.length} chars`, "trace-detail");
    raw.append(codeBlock(trace.rawReply));
    root.append(raw);
  }
  if (trace.request) root.append(requestView(trace.request, `${key}:request`, openKeys));
  if (trace.error) {
    const error = document.createElement("p");
    error.className = "trace-error";
    error.textContent = trace.error;
    root.append(error);
  }
  return root;
}
