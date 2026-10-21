import type { TraceEvent, TurnTrace } from "../types.ts";

/** Longest string kept in a stored tool input or output. The board tabs show the full sources. */
export const TRACE_TEXT_LIMIT = 20_000;

export function capText(text: string, limit = TRACE_TEXT_LIMIT): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}…(${text.length - limit} more chars)`;
}

/** A copy of a tool value that is safe to store: long strings capped, functions and cycles dropped. */
export function capValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return capText(value);
  if (value === null || typeof value !== "object") return typeof value === "function" ? undefined : value;
  if (depth > 6) return "…";
  if (Array.isArray(value)) return value.map((item) => capValue(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) out[key] = capValue(item, depth + 1);
  return out;
}

/** Collects the steps of one assistant turn in the order they happen. */
export class TraceRecorder {
  readonly trace: TurnTrace;
  /** Tool events still running: their index in `events` and when they started. */
  private readonly started: { index: number; at: number }[] = [];

  constructor(modelId: string | null, now = Date.now()) {
    this.trace = { modelId, startedAt: now, events: [] };
  }

  get events(): TraceEvent[] {
    return this.trace.events;
  }

  addText(text: string): void {
    if (!text) return;
    const last = this.trace.events.at(-1);
    if (last?.kind === "text") last.text += text;
    else this.trace.events.push({ kind: "text", text });
  }

  addReasoning(text: string): void {
    if (!text) return;
    const last = this.trace.events.at(-1);
    if (last?.kind === "reasoning") last.text += text;
    else this.trace.events.push({ kind: "reasoning", text });
  }

  toolStart(name: string, input: unknown, now = Date.now()): void {
    this.trace.events.push({ kind: "tool", name, input: capValue(input) });
    this.started.push({ index: this.trace.events.length - 1, at: now });
  }

  toolEnd(name: string, outcome: { output: unknown } | { error: string }, now = Date.now()): void {
    const open = this.started.findIndex(({ index }) => {
      const event = this.trace.events[index];
      return event?.kind === "tool" && event.name === name;
    });
    if (open === -1) return;
    const [{ index, at }] = this.started.splice(open, 1);
    const event = this.trace.events[index];
    if (event?.kind !== "tool") return;
    event.ms = now - at;
    if ("error" in outcome) event.error = outcome.error;
    else event.output = capValue(outcome.output);
  }

  finish(now = Date.now()): TurnTrace {
    this.trace.endedAt = now;
    return this.trace;
  }
}
