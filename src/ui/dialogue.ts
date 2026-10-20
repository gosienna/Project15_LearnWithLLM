import type { DialogueMessage } from "../types.ts";
import type { StreamState } from "../llm/turn.ts";

export interface DialogueHandlers {
  onSend: (text: string) => void;
  onStop: () => void;
}

export interface DialogueView {
  setStatus: (header: string, detail: string) => void;
  setComposerEnabled: (enabled: boolean) => void;
  setBusy: (busy: boolean) => void;
  setError: (message: string | null) => void;
  renderTranscript: (messages: DialogueMessage[], stream: StreamState | null) => void;
  focus: () => void;
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

  composer.addEventListener("submit", (event) => {
    event.preventDefault();
    const text = field.value.trim();
    if (!text || !composerEnabled || busy) return;
    field.value = "";
    handlers.onSend(text);
  });

  field.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    composer.requestSubmit();
  });

  stop.addEventListener("click", () => handlers.onStop());

  host.append(header, transcript, note, composer);

  const appendBubble = (role: "user" | "assistant" | "status", text: string) => {
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
    renderTranscript(messages, stream) {
      transcript.replaceChildren();
      for (const message of messages) appendBubble(message.role, message.content);
      if (stream) {
        if (stream.toolActive && !stream.text) appendBubble("status", "Updating the lesson…");
        else appendBubble("assistant", stream.text || "…");
      }
      transcript.scrollTop = transcript.scrollHeight;
    },
    focus() {
      if (!field.disabled) field.focus();
    },
  };
}
