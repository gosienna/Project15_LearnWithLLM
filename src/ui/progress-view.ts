import type { TraceEvent, TurnTrace } from "../types.ts";

export interface ProgressView {
  element: HTMLElement;
  /** Show the running ask, or hide the card with null. */
  update: (trace: TurnTrace | null) => void;
}

const REASONING_TAIL = 600;
const TEXT_TAIL = 240;

type ToolEvent = Extract<TraceEvent, { kind: "tool" }>;

function queryOf(event: ToolEvent): string {
  const input = event.input as { query?: unknown } | null;
  return input && typeof input === "object" && typeof input.query === "string" ? input.query : "";
}

function componentOf(event: ToolEvent): string {
  const input = event.input as { component?: unknown } | null;
  return input && typeof input === "object" && typeof input.component === "string" ? input.component : "";
}

/** What a tool call does, in the learner's words. */
export function toolLabel(event: ToolEvent): string {
  const component = componentOf(event);
  switch (event.name) {
    case "whiteboard_view":
      return component === "all" ? "Reading every source" : `Reading the ${component || "page"} source`;
    case "whiteboard_set":
      return `Writing the ${component || "page"} source`;
    case "whiteboard_explain":
      return "Writing an explanation";
    case "whiteboard_snapshot":
      return "Reading what the page says";
    case "whiteboard_store_material":
      return "Storing the learning material";
    case "whiteboard_add_image": {
      const input = event.input as { description?: unknown } | null;
      const about = input && typeof input === "object" && typeof input.description === "string" ? input.description.trim() : "";
      return about ? `Saving image: ${about}` : "Saving an image";
    }
    case "whiteboard_remove_image":
      return "Removing an image";
    case "web_search": {
      const query = queryOf(event);
      return query ? `Searching the web: ${query}` : "Searching the web";
    }
    default:
      return event.name;
  }
}

function tail(text: string, limit: number): string {
  const trimmed = text.trim();
  return trimmed.length > limit ? `…${trimmed.slice(-limit)}` : trimmed;
}

function seconds(trace: TurnTrace): string {
  return `${Math.max(0, Math.floor((Date.now() - trace.startedAt) / 1000))} s`;
}

/** Rounds as the model runs them: a new round starts when the model speaks after a tool call. */
function rounds(events: TraceEvent[]): TraceEvent[][] {
  const out: TraceEvent[][] = [[]];
  let afterTool = false;
  for (const event of events) {
    if (event.kind !== "tool" && afterTool) out.push([]);
    afterTool = event.kind === "tool";
    out.at(-1)!.push(event);
  }
  return out;
}

function step(event: TraceEvent, last: boolean): HTMLLIElement {
  const item = document.createElement("li");
  item.className = `progress-step progress-${event.kind}`;
  const label = document.createElement("p");
  label.className = "progress-label";
  if (event.kind === "tool") {
    const state = event.error ? "is-failed" : "output" in event ? "is-done" : "is-running";
    item.classList.add(state);
    label.textContent = toolLabel(event);
    item.append(label);
    if (event.error) {
      const error = document.createElement("p");
      error.className = "progress-error";
      error.textContent = event.error;
      item.append(error);
    }
    return item;
  }
  label.textContent = event.kind === "reasoning" ? (last ? "Thinking…" : "Thought") : "Replying";
  const body = document.createElement("p");
  body.className = "progress-text";
  body.textContent = tail(event.text, event.kind === "reasoning" ? REASONING_TAIL : TEXT_TAIL);
  item.append(label, body);
  return item;
}

/** One line for a running ask: the round, what the model is doing now, and how long it has run. */
export function progressLine(trace: TurnTrace): string {
  const grouped = rounds(trace.events).filter((events) => events.length > 0);
  const last = trace.events.at(-1);
  let doing = trace.request ? "Waiting for the model" : "Starting the model";
  if (last?.kind === "reasoning") doing = "Thinking";
  else if (last?.kind === "text") doing = "Replying";
  else if (last?.kind === "tool") doing = last.error ? `${toolLabel(last)} failed` : "output" in last ? `${toolLabel(last)}, done` : toolLabel(last);
  const parts = grouped.length > 0 ? [`Round ${grouped.length}`, `${doing}…`] : [`${doing}…`];
  parts.push(seconds(trace));
  return parts.join(" · ");
}

/** A small live view of an ask: the model's reasoning and each round of tool calls. */
export function createProgressView(): ProgressView {
  const element = document.createElement("section");
  element.className = "progress";
  element.setAttribute("aria-label", "What the model is doing");
  element.setAttribute("aria-live", "polite");
  element.hidden = true;
  const head = document.createElement("p");
  head.className = "progress-head";
  const list = document.createElement("ol");
  list.className = "progress-rounds";
  element.append(head, list);

  let current: TurnTrace | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  const paintHead = () => {
    if (!current) return;
    const tools = current.events.filter((event) => event.kind === "tool").length;
    const parts = [current.events.length === 0 ? (current.request ? "Waiting for the model" : "Starting the model") : "Working"];
    parts.push(seconds(current));
    if (tools) parts.push(`${tools} tool call${tools === 1 ? "" : "s"}`);
    head.textContent = parts.join(" · ");
  };

  const paint = () => {
    if (!current) return;
    paintHead();
    const pinned = list.scrollHeight - list.scrollTop - list.clientHeight < 24;
    const grouped = rounds(current.events);
    const lastEvent = current.events.at(-1);
    list.replaceChildren(
      ...grouped
        .filter((events) => events.length > 0)
        .map((events, index) => {
          const round = document.createElement("li");
          round.className = "progress-round";
          const title = document.createElement("p");
          title.className = "progress-round-title";
          title.textContent = `Round ${index + 1}`;
          const steps = document.createElement("ol");
          steps.className = "progress-steps";
          steps.append(...events.map((event) => step(event, event === lastEvent)));
          round.append(title, steps);
          return round;
        }),
    );
    if (pinned) list.scrollTop = list.scrollHeight;
  };

  return {
    element,
    update(trace) {
      current = trace;
      element.hidden = !trace;
      if (!trace) {
        if (timer) clearInterval(timer);
        timer = null;
        list.replaceChildren();
        return;
      }
      timer ??= setInterval(paintHead, 1000);
      paint();
    },
  };
}
