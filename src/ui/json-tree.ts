/** Which nodes the learner opened or closed. Defaults stay until they toggle one. */
export interface JsonTreeState {
  opened: Set<string>;
  closed: Set<string>;
}

export function createJsonTreeState(): JsonTreeState {
  return { opened: new Set(), closed: new Set() };
}

const LONG_STRING = 80;

function defaultOpen(path: string): boolean {
  if (path === "initialPrompts" || path === "tools") return true;
  return /^initialPrompts\[\d+\]$/.test(path);
}

function isOpen(state: JsonTreeState, path: string): boolean {
  if (state.opened.has(path)) return true;
  if (state.closed.has(path)) return false;
  return defaultOpen(path);
}

function joinPath(parent: string, key: string): string {
  if (!parent) return key;
  if (key.startsWith("[")) return `${parent}${key}`;
  return `${parent}.${key}`;
}

function preview(text: string): string {
  const one = text.replace(/\s+/g, " ").trim();
  if (one.length <= 48) return one;
  return `${one.slice(0, 48)}…`;
}

function isLongString(value: unknown): value is string {
  return typeof value === "string" && (value.length > LONG_STRING || value.includes("\n"));
}

function metaFor(value: unknown): string {
  if (Array.isArray(value)) return String(value.length);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.name === "string") return record.name;
    if (typeof record.role === "string") return record.role;
    return `${Object.keys(record).length} fields`;
  }
  if (typeof value === "string") return `${value.length} chars`;
  return "";
}

function leaf(path: string, key: string, value: unknown): HTMLElement {
  const row = document.createElement("div");
  row.className = "json-leaf";
  row.dataset.path = path;
  const name = document.createElement("span");
  name.className = "json-key";
  name.textContent = key;
  const text = document.createElement("span");
  if (value === null) {
    text.className = "json-null";
    text.textContent = "null";
  } else if (typeof value === "string") {
    text.className = "json-string";
    text.textContent = JSON.stringify(value);
  } else if (typeof value === "number") {
    text.className = "json-number";
    text.textContent = String(value);
  } else if (typeof value === "boolean") {
    text.className = "json-bool";
    text.textContent = String(value);
  } else {
    text.className = "json-null";
    text.textContent = String(value);
  }
  row.append(name, text);
  return row;
}

function node(path: string, key: string, value: unknown, state: JsonTreeState): HTMLElement {
  const collapsible = (value !== null && typeof value === "object") || isLongString(value);
  if (!collapsible) return leaf(path, key, value);

  const details = document.createElement("details");
  details.className = "json-node";
  details.dataset.path = path;
  details.open = isOpen(state, path);
  const summary = document.createElement("summary");
  const name = document.createElement("span");
  name.className = "json-key";
  name.textContent = key;
  const meta = document.createElement("span");
  meta.className = "json-meta";
  meta.textContent = isLongString(value) ? `"${preview(value)}"` : metaFor(value);
  summary.append(name, meta);
  details.append(summary);

  const body = document.createElement("div");
  body.className = "json-children";
  if (isLongString(value)) {
    const block = document.createElement("pre");
    block.className = "json-block";
    block.textContent = value;
    body.append(block);
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => body.append(node(joinPath(path, `[${index}]`), `[${index}]`, item, state)));
  } else {
    for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
      body.append(node(joinPath(path, childKey), childKey, child, state));
    }
  }
  details.append(body);
  details.addEventListener("toggle", () => {
    if (details.open) {
      state.closed.delete(path);
      if (!defaultOpen(path)) state.opened.add(path);
      else state.opened.delete(path);
    } else {
      state.opened.delete(path);
      if (defaultOpen(path)) state.closed.add(path);
      else state.closed.delete(path);
    }
  });
  return details;
}

/** A collapsible view of one JSON value. Object and array members, and long strings, each toggle on their own. */
export function renderJsonTree(host: HTMLElement, value: unknown, state: JsonTreeState): void {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    host.replaceChildren(
      ...Object.entries(value as Record<string, unknown>).map(([key, item]) => node(key, key, item, state)),
    );
    return;
  }
  host.replaceChildren(node("", "", value, state));
}
