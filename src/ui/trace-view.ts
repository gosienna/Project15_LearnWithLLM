import type { RequestInput, TraceEvent, TurnTrace } from "../types.ts";

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

/** The raw input an ask sent: the new session's initial prompts, then the prompt itself. */
function requestView(request: RequestInput, key: string, openKeys: Set<string>): HTMLElement {
  // Records from before one-shot asks may lack initialPrompts.
  const prompts = request.initialPrompts ?? [];
  const how = `new session · ${prompts.length} initial message${prompts.length === 1 ? "" : "s"}`;
  const details = section(
    key,
    openKeys,
    `Request input · ${how}${request.selection ? " · selection" : ""}${request.edited ? " · edited" : ""}`,
    "trace-detail",
  );
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
  if (request.tools) {
    const tools = document.createElement("p");
    tools.className = "trace-field";
    tools.textContent = `tools · ${request.tools.length}`;
    details.append(tools, codeBlock(request.tools.join("\n")));
  }
  if (request.selection) details.append(valueView("selection", request.selection));
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
    const moved = trace.fallback === "note" ? "Raw reply, put on the board as a note" : "Raw reply, moved to the whiteboard";
    const raw = section(`${key}:raw`, openKeys, `${moved} · ${trace.rawReply.length} chars`, "trace-detail");
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

function quoteOf(trace: TurnTrace): string | null {
  const selection = trace.selection;
  if (!selection) return null;
  const text = selection.quote.exact ? `“${selection.quote.exact.slice(0, 120)}”` : `<${selection.tag}>`;
  return `${selection.kind === "text" ? "Selected" : "Alt+clicked"} ${text} · ${selection.selector}`;
}

/** The Trace tab: every ask of this visit, newest first, with the question and the selection on top. */
export function renderTraceList(pane: HTMLElement, traces: TurnTrace[], openKeys: Set<string>, liveId: string | null): void {
  if (traces.length === 0) {
    const empty = document.createElement("p");
    empty.className = "trace-list-empty";
    empty.textContent = "No asks yet. Start a lesson, or select text on the board and ask about it. Traces are kept until you switch topics or reload.";
    pane.replaceChildren(empty);
    return;
  }
  const list = document.createElement("ol");
  list.className = "trace-list";
  traces.forEach((trace, index) => {
    const key = trace.id ?? `trace-${index}`;
    if (!openKeys.has(`${key}:seen`)) {
      openKeys.add(`${key}:seen`);
      if (index === 0) openKeys.add(key);
    }
    const item = document.createElement("li");
    item.className = `trace-entry${trace.selection ? " has-selection" : ""}`;
    const question = document.createElement("p");
    question.className = "trace-question";
    question.textContent = trace.question ?? "(no question)";
    item.append(question);
    const quote = quoteOf(trace);
    if (quote) {
      const where = document.createElement("p");
      where.className = "trace-selection";
      where.textContent = quote;
      item.append(where);
    }
    item.append(renderTrace(trace, key, openKeys, trace.id === liveId));
    list.append(item);
  });
  const top = pane.scrollTop;
  pane.replaceChildren(list);
  pane.scrollTop = top;
}
