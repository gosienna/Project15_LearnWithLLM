import { BOARD_COMPONENTS, type BoardComponent, type BoardSources, type SelectionAnchor } from "../types.ts";

export const START_HEADING = "What do you want to learn?";
export const SNAPSHOT_TEXT_LIMIT = 8_000;

/** Marks the learner's selection in the source the model reads. The tools strip them on write. */
export const SELECTION_START = "<!-- ▶ LEARNER SELECTION -->";
export const SELECTION_END = "<!-- ◀ END SELECTION -->";

const BRIDGE_SOURCE = "learn-with-llm";

/**
 * Runs inside the sandboxed board. The parent cannot read the frame, so this reports a text
 * selection, or an Alt+clicked element, with postMessage. A plain click still reaches the lesson.
 */
export const SELECTION_BRIDGE = `(() => {
  const CONTEXT = 60, EXACT = 500, OUTER = 1500;
  const post = (type, anchor) => parent.postMessage({ source: "${BRIDGE_SOURCE}", type, anchor }, "*");
  const style = document.createElement("style");
  style.textContent = "[data-ask-highlight]{outline:2px solid #c7781f !important;outline-offset:2px;}";
  document.head.append(style);
  const unmark = () => document.querySelectorAll("[data-ask-highlight]").forEach((el) => el.removeAttribute("data-ask-highlight"));
  const squash = (text) => text.replace(/\\s+/g, " ");
  const clip = (text, n) => (text.length > n ? text.slice(0, n) + "…" : text);
  const step = (el) => {
    let n = 1;
    for (let sib = el.previousElementSibling; sib; sib = sib.previousElementSibling) if (sib.localName === el.localName) n += 1;
    return el.localName + ":nth-of-type(" + n + ")";
  };
  const cssPath = (el) => {
    const steps = [];
    for (let node = el; node && node !== document.documentElement; node = node.parentElement) {
      if (node === document.body) { steps.unshift("body"); break; }
      if (node.id && document.querySelectorAll("#" + CSS.escape(node.id)).length === 1) { steps.unshift("#" + CSS.escape(node.id)); break; }
      steps.unshift(step(node));
    }
    return steps.join(" > ") || "body";
  };
  const anchorFor = (kind, el, exact, prefix, suffix, r) => ({
    kind,
    component: el.closest("#lesson-svg") ? "svg" : "html",
    selector: cssPath(el),
    tag: el.localName,
    quote: { exact: clip(exact.trim(), EXACT), prefix: squash(prefix).slice(-CONTEXT), suffix: squash(suffix).slice(0, CONTEXT) },
    outerHTML: clip(el.outerHTML, OUTER),
    rect: { x: r.left, y: r.top, width: r.width, height: r.height },
  });
  const fromSelection = () => {
    const sel = getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    const exact = squash(range.toString());
    if (!exact.trim()) return null;
    let el = range.commonAncestorContainer;
    if (el.nodeType !== 1) el = el.parentElement;
    if (!el) return null;
    const before = document.createRange();
    before.selectNodeContents(el);
    before.setEnd(range.startContainer, range.startOffset);
    const after = document.createRange();
    after.selectNodeContents(el);
    after.setStart(range.endContainer, range.endOffset);
    return anchorFor("text", el, exact, before.toString(), after.toString(), range.getBoundingClientRect());
  };
  document.addEventListener("mouseup", (event) => {
    if (event.altKey) return;
    setTimeout(() => {
      const anchor = fromSelection();
      unmark();
      if (anchor) post("selection", anchor);
      else post("clear");
    }, 0);
  });
  document.addEventListener("keyup", (event) => {
    if (event.key === "Escape") {
      unmark();
      getSelection()?.removeAllRanges();
      post("clear");
      return;
    }
    if (!event.shiftKey) return;
    const anchor = fromSelection();
    if (anchor) post("selection", anchor);
  });
  document.addEventListener("click", (event) => {
    if (!event.altKey) return;
    const el = event.target instanceof Element ? event.target : null;
    if (!el || el === document.body || el === document.documentElement) return;
    event.preventDefault();
    event.stopPropagation();
    getSelection()?.removeAllRanges();
    unmark();
    const anchor = anchorFor("element", el, squash(el.textContent || ""), "", "", el.getBoundingClientRect());
    el.setAttribute("data-ask-highlight", "");
    post("selection", anchor);
  }, true);
  addEventListener("message", (event) => {
    if (event.source !== parent || !event.data || event.data.source !== "${BRIDGE_SOURCE}") return;
    if (event.data.type === "clear-highlight") {
      unmark();
      getSelection()?.removeAllRanges();
    }
  });
})();`;

const FRAME_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: https:;";

export function emptyBoard(): BoardSources {
  return { html: "", css: "", js: "", svg: "", json: "" };
}

export function boardIsEmpty(sources: BoardSources): boolean {
  return BOARD_COMPONENTS.every((key) => sources[key].trim() === "");
}

export function lessonDataLiteral(json: string): string {
  if (!json.trim()) return "null";
  try {
    JSON.parse(json);
  } catch {
    return "null";
  }
  return json.replaceAll("<", "\\u003c").replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
}

function escapeStyleClose(css: string): string {
  return css.replace(/<\/style/gi, "<\\/style");
}

function escapeScriptClose(js: string): string {
  return js.replace(/<\/script/gi, "<\\/script");
}

export function assembleBoardDocument(sources: BoardSources): string {
  const svg = sources.svg.trim()
    ? `<div id="lesson-svg">${sources.svg}</div>\n`
    : "";
  const data = escapeScriptClose(`globalThis.lessonData = ${lessonDataLiteral(sources.json)};`);
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}">
<style>
${escapeStyleClose(sources.css)}
</style>
</head>
<body>
${svg}${sources.html}
<script>${data}</script>
<script>${SELECTION_BRIDGE}</script>
<script>
${escapeScriptClose(sources.js)}
</script>
</body>
</html>`;
}

function collapse(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function stripMarkup(markup: string): string {
  const withoutBlocks = markup
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ");
  return collapse(withoutBlocks.replace(/<[^>]+>/g, " "));
}

function visibleText(markup: string, kind: "html" | "svg"): string {
  if (!markup.trim()) return "";
  if (typeof DOMParser === "undefined") return stripMarkup(markup);
  if (kind === "svg") {
    const doc = new DOMParser().parseFromString(markup, "image/svg+xml");
    return collapse(doc.documentElement?.textContent ?? "");
  }
  const doc = new DOMParser().parseFromString(markup, "text/html");
  doc.querySelectorAll("script, style").forEach((node) => node.remove());
  return collapse(doc.body?.textContent ?? "");
}

export function titleFromHtml(html: string): string | null {
  if (!html.trim()) return null;
  if (typeof DOMParser !== "undefined") {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const text = collapse(doc.querySelector("h1")?.textContent ?? "");
    return text || null;
  }
  const match = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
  if (!match) return null;
  const text = collapse(match[1].replace(/<[^>]+>/g, " "));
  return text || null;
}

export function snapshotBoard(sources: BoardSources): {
  text: string;
  characters: Record<BoardComponent, number>;
} {
  const parts = [visibleText(sources.html, "html"), visibleText(sources.svg, "svg")].filter(Boolean);
  let text = parts.join("\n\n");
  if (text.length > SNAPSHOT_TEXT_LIMIT) text = `${text.slice(0, SNAPSHOT_TEXT_LIMIT)}…`;
  return {
    text,
    characters: {
      html: sources.html.length,
      css: sources.css.length,
      js: sources.js.length,
      svg: sources.svg.length,
      json: sources.json.length,
    },
  };
}

/** Where the parsed board keeps the svg, so a selector from the live page resolves the same way. */
interface ParsedBoard {
  doc: Document;
  slot: Element | null;
}

function parseBoard(sources: BoardSources): ParsedBoard | null {
  if (typeof DOMParser === "undefined") return null;
  const slot = sources.svg.trim() ? `<div id="lesson-svg">${sources.svg}</div>` : "";
  const doc = new DOMParser().parseFromString(`<!doctype html><html><head></head><body>${slot}${sources.html}</body></html>`, "text/html");
  return { doc, slot: slot ? doc.body.firstElementChild : null };
}

function findTarget(board: ParsedBoard, selector: string): Element | null {
  try {
    const found = board.doc.querySelector(selector);
    return found && found !== board.doc.body && found !== board.doc.documentElement ? found : null;
  } catch {
    return null;
  }
}

function serialize(board: ParsedBoard, component: "html" | "svg"): string {
  if (component === "svg") return board.slot?.innerHTML ?? "";
  board.slot?.remove();
  return board.doc.body.innerHTML;
}

export interface MarkedSource {
  component: "html" | "svg";
  text: string;
  /** False when the selector found nothing in the stored source, e.g. the lesson script built it. */
  marked: boolean;
}

/** The source the selection lives in, with the selected element between the selection markers. */
export function markSource(sources: BoardSources, anchor: SelectionAnchor): MarkedSource {
  const unmarked: MarkedSource = { component: anchor.component, text: sources[anchor.component], marked: false };
  const board = parseBoard(sources);
  if (!board) return unmarked;
  const target = findTarget(board, anchor.selector);
  if (!target) return unmarked;
  const begin = board.doc.createComment(SELECTION_START.slice(4, -3));
  const end = board.doc.createComment(SELECTION_END.slice(4, -3));
  if (target === board.slot) {
    target.prepend(begin);
    target.append(end);
  } else {
    target.before(begin);
    target.after(end);
  }
  const component = board.slot?.contains(target) ? "svg" : "html";
  return { component, text: serialize(board, component), marked: true };
}

const NOTE_STYLE = "border-left:3px solid #c7781f;background:#fff7ec;padding:8px 12px;margin:12px 0;font-size:0.95em;";
const NOTE_HOST = "p, li, h1, h2, h3, h4, h5, h6, pre, blockquote, figure, table, section, article, div";

function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function paragraphs(text: string): string[] {
  return text.split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean);
}

function noteMarkup(question: string, reply: string, about: string): string {
  const body = paragraphs(reply).map((part) => `<p style="margin:0 0 4px;">${escapeHtml(part)}</p>`).join("");
  return `<aside class="learner-note" data-about="${escapeHtml(about)}" style="${NOTE_STYLE}"><p style="margin:0 0 4px;font-weight:600;">${escapeHtml(question)}</p>${body}</aside>`;
}

/** Removes selection markers the model copied from the source it read. */
export function stripSelectionMarkers(text: string): string {
  return text.replaceAll(SELECTION_START, "").replaceAll(SELECTION_END, "");
}

export interface InsertedHtml {
  html: string;
  /** Where the markup went: after the selected block, under the drawing, or at the end of the page. */
  placed: "after selection" | "under the drawing" | "at the end";
}

/**
 * The html with `markup` placed after the block the learner pointed at. A selection in the svg puts
 * it right under the drawing; no selection, or one not in the source, puts it at the end.
 */
export function insertHtml(sources: BoardSources, anchor: SelectionAnchor | null, markup: string): InsertedHtml {
  const board = parseBoard(sources);
  if (!board) return { html: sources.html.trim() ? `${sources.html}\n${markup}` : markup, placed: "at the end" };
  const holder = board.doc.createElement("div");
  holder.innerHTML = markup;
  const nodes = [...holder.childNodes];
  const target = anchor ? findTarget(board, anchor.selector) : null;
  let placed: InsertedHtml["placed"] = "at the end";
  if (target && board.slot?.contains(target)) {
    board.slot.after(...nodes);
    placed = "under the drawing";
  } else if (target) {
    const block = target.closest(NOTE_HOST) ?? target;
    if (block.localName === "li") block.append(...nodes);
    else block.after(...nodes);
    placed = "after selection";
  } else {
    board.doc.body.append(...nodes);
  }
  return { html: serialize(board, "html"), placed };
}

/** The html with a note answering the learner, placed like `insertHtml`. */
export function insertNote(
  sources: BoardSources,
  anchor: SelectionAnchor | null,
  note: { question: string; reply: string },
): string {
  return insertHtml(sources, anchor, noteMarkup(note.question, note.reply, anchor?.quote.exact.slice(0, 80) ?? "")).html;
}

export interface BoardHandlers {
  /** The learner sent the first question of an empty board. */
  onStart?: (question: string) => void;
  /** A selection in the lesson, or null when the learner cleared it. */
  onSelection?: (anchor: SelectionAnchor | null) => void;
  /** The start field changed. */
  onDraft?: () => void;
}

const rendered = new WeakMap<HTMLElement, string>();
const handlersFor = new WeakMap<HTMLElement, BoardHandlers>();
const listening = new WeakSet<HTMLElement>();

function renderKey(sources: BoardSources): string {
  return BOARD_COMPONENTS.map((key) => sources[key]).join("\0");
}

function text(value: unknown, limit: number): string | null {
  return typeof value === "string" ? value.slice(0, limit) : null;
}

/** The lesson script can post too, so only a well-formed anchor passes, with every string capped. */
export function readAnchor(value: unknown): SelectionAnchor | null {
  const raw = value as Partial<Record<keyof SelectionAnchor, unknown>> | null;
  if (!raw || typeof raw !== "object") return null;
  const quote = raw.quote as Record<string, unknown> | null;
  const rect = raw.rect as Record<string, unknown> | null;
  const selector = text(raw.selector, 600);
  const tag = text(raw.tag, 40);
  const outerHTML = text(raw.outerHTML, 1600);
  if (!selector || !tag || outerHTML === null || !quote || !rect) return null;
  if (raw.kind !== "text" && raw.kind !== "element") return null;
  if (raw.component !== "html" && raw.component !== "svg") return null;
  const exact = text(quote.exact, 600);
  const prefix = text(quote.prefix, 80);
  const suffix = text(quote.suffix, 80);
  if (exact === null || prefix === null || suffix === null) return null;
  const numbers = [rect.x, rect.y, rect.width, rect.height].map((n) => (typeof n === "number" && Number.isFinite(n) ? n : 0));
  return {
    kind: raw.kind,
    component: raw.component,
    selector,
    tag,
    quote: { exact, prefix, suffix },
    outerHTML,
    rect: { x: numbers[0]!, y: numbers[1]!, width: numbers[2]!, height: numbers[3]! },
  };
}

function listen(host: HTMLElement): void {
  if (listening.has(host) || typeof window === "undefined") return;
  listening.add(host);
  window.addEventListener("message", (event) => {
    const frame = host.querySelector<HTMLIFrameElement>(".board-frame");
    if (!frame || event.source !== frame.contentWindow) return;
    const data = event.data as { source?: unknown; type?: unknown; anchor?: unknown } | null;
    if (data?.source !== BRIDGE_SOURCE) return;
    const onSelection = handlersFor.get(host)?.onSelection;
    if (data.type === "clear") onSelection?.(null);
    if (data.type !== "selection") return;
    const anchor = readAnchor(data.anchor);
    if (anchor) onSelection?.(anchor);
  });
}

/** Remove the outline and the text selection inside the board. */
export function clearBoardHighlight(host: HTMLElement): void {
  host
    .querySelector<HTMLIFrameElement>(".board-frame")
    ?.contentWindow?.postMessage({ source: BRIDGE_SOURCE, type: "clear-highlight" }, "*");
}

function startForm(host: HTMLElement): HTMLFormElement {
  const form = document.createElement("form");
  form.className = "board-start";
  const heading = document.createElement("h2");
  heading.textContent = START_HEADING;
  const hint = document.createElement("p");
  hint.className = "board-start-hint";
  hint.textContent = "Name a topic or ask a question. Later, select text on the lesson, or Alt+click a shape, to ask about that spot.";
  const field = document.createElement("textarea");
  field.className = "board-start-field";
  field.rows = 3;
  field.placeholder = "How do vaccines train the immune system?";
  field.setAttribute("aria-label", START_HEADING);
  const go = document.createElement("button");
  go.type = "submit";
  go.className = "board-start-go";
  go.textContent = "Start";
  const status = document.createElement("p");
  status.className = "board-start-status";
  status.hidden = true;
  form.append(heading, hint, field, go, status);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const question = field.value.trim();
    if (!question || go.disabled) return;
    handlersFor.get(host)?.onStart?.(question);
  });
  field.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    form.requestSubmit();
  });
  field.addEventListener("input", () => handlersFor.get(host)?.onDraft?.());
  return form;
}

/** Enable the start form when the model can run, and say so while the first lesson is written. */
export function syncStartForm(host: HTMLElement, state: { enabled: boolean; busy: boolean }): void {
  const form = host.querySelector<HTMLFormElement>(".board-start");
  if (!form) return;
  const field = form.querySelector("textarea")!;
  const go = form.querySelector("button")!;
  const status = form.querySelector<HTMLElement>(".board-start-status")!;
  field.disabled = state.busy || !state.enabled;
  go.disabled = state.busy || !state.enabled;
  status.hidden = !state.busy;
  status.textContent = state.busy ? "Writing the lesson…" : "";
}

/** The unsent text of the start form, or "" when the board has a lesson. */
export function boardDraft(host: HTMLElement): string {
  return host.querySelector<HTMLTextAreaElement>(".board-start-field")?.value ?? "";
}

export function focusStart(host: HTMLElement): void {
  const field = host.querySelector<HTMLTextAreaElement>(".board-start-field");
  if (field && !field.disabled) field.focus();
}

export function renderWhiteboard(host: HTMLElement, sources: BoardSources, handlers?: BoardHandlers): void {
  if (handlers) handlersFor.set(host, handlers);
  listen(host);
  const key = renderKey(sources);
  if (rendered.get(host) === key && host.childElementCount > 0) return;
  rendered.set(host, key);
  host.replaceChildren();
  if (boardIsEmpty(sources)) {
    host.append(startForm(host));
    return;
  }
  const frame = document.createElement("iframe");
  frame.className = "board-frame";
  frame.title = "Whiteboard";
  // Popups let Sources links open in a new tab; the frame still gets no same-origin access.
  frame.setAttribute("sandbox", "allow-scripts allow-popups allow-popups-to-escape-sandbox");
  frame.referrerPolicy = "no-referrer";
  frame.srcdoc = assembleBoardDocument(sources);
  host.append(frame);
}
