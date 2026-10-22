import { BOARD_COMPONENTS, type BoardComponent, type BoardSources, type SelectionAnchor } from "../types.ts";
import { BOARD_MODULES } from "./board-modules.ts";

export const START_HEADING = "What do you want to learn?";
export const SNAPSHOT_TEXT_LIMIT = 8_000;

/** Marks the learner's selection in the source the model reads. The tools strip them on write. */
export const SELECTION_START = "<!-- ▶ LEARNER SELECTION -->";
export const SELECTION_END = "<!-- ◀ END SELECTION -->";

const BRIDGE_SOURCE = "learn-with-llm";

/**
 * Runs inside the sandboxed board. The parent cannot read the frame, so this reports a text
 * selection, a clicked picture or other non-text element, or every element inside a drag box,
 * with postMessage. Links and form controls keep their own clicks.
 */
export const SELECTION_BRIDGE = `(() => {
  const CONTEXT = 60, EXACT = 500, OUTER = 1500, DRAG = 4;
  const NON_TEXT = new Set(["img", "picture", "svg", "canvas", "video", "audio", "rect", "circle", "ellipse", "line", "polygon", "polyline", "path", "image", "use"]);
  const post = (type, extra) => parent.postMessage(Object.assign({ source: "${BRIDGE_SOURCE}", type }, extra || {}), "*");
  const style = document.createElement("style");
  style.textContent = "[data-ask-highlight]{outline:2px solid #c7781f !important;outline-offset:2px;}[data-ask-marquee]{position:fixed;z-index:5;border:1px solid #c7781f;background:rgba(199,120,31,.12);pointer-events:none;}";
  document.head.append(style);
  const unmark = () => document.querySelectorAll("[data-ask-highlight]").forEach((el) => el.removeAttribute("data-ask-highlight"));
  const mark = (els) => { unmark(); els.forEach((el) => el.setAttribute("data-ask-highlight", "")); };
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
  const interactive = (el) => !!el.closest("a, button, input, textarea, select, summary, label");
  const nonText = (el) => {
    if (!el || el === document.body || el === document.documentElement) return false;
    if (interactive(el)) return false;
    if (NON_TEXT.has(el.localName)) return true;
    return !(el.textContent || "").trim();
  };
  const intersects = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  const inBox = (rect) => {
    const hits = [];
    document.body.querySelectorAll("*").forEach((el) => {
      if (el.hasAttribute("data-ask-marquee") || el.localName === "script" || el.localName === "style") return;
      if (interactive(el)) return;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return;
      if (!intersects(rect, { left: r.left, top: r.top, right: r.right, bottom: r.bottom })) return;
      hits.push(el);
    });
    return hits.filter((el) => !hits.some((other) => other !== el && el.contains(other)));
  };
  const highlightText = () => {
    const sel = getSelection();
    let el = sel && sel.rangeCount ? sel.getRangeAt(0).commonAncestorContainer : null;
    if (el && el.nodeType !== 1) el = el.parentElement;
    if (el && el !== document.body && el !== document.documentElement) el.setAttribute("data-ask-highlight", "");
  };
  let drag = null;
  let boxGesture = false;
  const endDrag = (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    const state = drag;
    drag = null;
    document.documentElement.style.userSelect = "";
    if (!state.active) return;
    if (state.box) state.box.remove();
    const rect = {
      left: Math.min(state.x, event.clientX),
      top: Math.min(state.y, event.clientY),
      right: Math.max(state.x, event.clientX),
      bottom: Math.max(state.y, event.clientY),
    };
    const hits = inBox(rect);
    boxGesture = true;
    getSelection()?.removeAllRanges();
    if (!hits.length) { unmark(); post("clear"); return; }
    mark(hits);
    post("selection", { anchors: hits.map((el) => anchorFor("element", el, squash(el.textContent || ""), "", "", el.getBoundingClientRect())) });
  };
  document.addEventListener("pointerdown", (event) => {
    if (event.altKey || event.button !== 0) return;
    const el = event.target instanceof Element ? event.target : null;
    if (!el || interactive(el)) return;
    if (el !== document.body && el !== document.documentElement && !nonText(el)) return;
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, active: false, box: null };
  }, true);
  document.addEventListener("pointermove", (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    if (!drag.active && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < DRAG) return;
    if (!drag.active) {
      drag.active = true;
      const box = document.createElement("div");
      box.setAttribute("data-ask-marquee", "");
      document.body.append(box);
      drag.box = box;
      document.documentElement.style.userSelect = "none";
    }
    event.preventDefault();
    drag.box.style.left = Math.min(drag.x, event.clientX) + "px";
    drag.box.style.top = Math.min(drag.y, event.clientY) + "px";
    drag.box.style.width = Math.abs(event.clientX - drag.x) + "px";
    drag.box.style.height = Math.abs(event.clientY - drag.y) + "px";
  }, true);
  document.addEventListener("pointerup", endDrag, true);
  document.addEventListener("pointercancel", endDrag, true);
  document.addEventListener("mouseup", (event) => {
    if (event.altKey) return;
    setTimeout(() => {
      if (boxGesture) { boxGesture = false; return; }
      const anchor = fromSelection();
      unmark();
      if (!anchor) { post("clear"); return; }
      highlightText();
      post("selection", { anchors: [anchor] });
    }, 0);
  });
  document.addEventListener("keyup", (event) => {
    if (event.key === "Escape") {
      if (drag && drag.box) drag.box.remove();
      drag = null;
      document.documentElement.style.userSelect = "";
      unmark();
      getSelection()?.removeAllRanges();
      post("clear");
      return;
    }
    if (!event.shiftKey) return;
    const anchor = fromSelection();
    if (!anchor) return;
    unmark();
    highlightText();
    post("selection", { anchors: [anchor] });
  });
  document.addEventListener("click", (event) => {
    if (boxGesture) { event.preventDefault(); event.stopPropagation(); return; }
    const el = event.target instanceof Element ? event.target : null;
    if (!el || el === document.body || el === document.documentElement) return;
    if (!event.altKey && !nonText(el)) return;
    event.preventDefault();
    event.stopPropagation();
    getSelection()?.removeAllRanges();
    mark([el]);
    boxGesture = true;
    post("selection", { anchors: [anchorFor("element", el, squash(el.textContent || ""), "", "", el.getBoundingClientRect())] });
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
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: https:; font-src data:;";

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

/** What each stored image shows as in the frame, by id: a data: URL of the cached copy, or its original url. */
export type BoardImageSources = Record<string, string>;

const BOARD_IMAGE_REF = /board-image:([A-Za-z0-9_-]+)/g;

/** Swap board-image:ID for the image's src. Unknown ids stay as they are, so the slip is visible. */
export function resolveBoardImages(source: string, images: BoardImageSources): string {
  return source.replace(BOARD_IMAGE_REF, (ref, id: string) => (Object.hasOwn(images, id) ? images[id]! : ref));
}

export function assembleBoardDocument(sources: BoardSources, images: BoardImageSources = {}): string {
  const svgSource = resolveBoardImages(sources.svg, images);
  const svg = svgSource.trim()
    ? `<div id="lesson-svg">${svgSource}</div>\n`
    : "";
  const imagesLiteral = JSON.stringify(images).replaceAll("<", "\\u003c").replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
  const data = escapeScriptClose(`globalThis.lessonData = ${lessonDataLiteral(sources.json)};\nglobalThis.lessonImages = ${imagesLiteral};`);
  // Prefilled modules: their style comes before the lesson css so the lesson can override it.
  const moduleStyles = BOARD_MODULES.map((module) => `<style>${escapeStyleClose(module.style)}</style>\n`).join("");
  const moduleScripts = BOARD_MODULES.map(
    (module) => `<script>${escapeScriptClose(module.script)}</script>\n<script>${escapeScriptClose(module.boot)}</script>\n`,
  ).join("");
  const moduleAfter = BOARD_MODULES.map((module) => `\n<script>${escapeScriptClose(module.after)}</script>`).join("");
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}">
${moduleStyles}<style>
${escapeStyleClose(resolveBoardImages(sources.css, images))}
</style>
</head>
<body>
${svg}${resolveBoardImages(sources.html, images)}
<script>${data}</script>
${moduleScripts}<script>${SELECTION_BRIDGE}</script>
<script>
${escapeScriptClose(sources.js)}
</script>${moduleAfter}
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

/** Every selected element marked in one pass, so a box selection keeps each marker. */
export function markSelections(sources: BoardSources, anchors: readonly SelectionAnchor[]): {
  html: string;
  svg: string;
  matched: boolean[];
} {
  const matched = anchors.map(() => false);
  const board = parseBoard(sources);
  if (!board) return { html: sources.html, svg: sources.svg, matched };
  anchors.forEach((anchor, index) => {
    const target = findTarget(board, anchor.selector);
    if (!target) return;
    matched[index] = true;
    const begin = board.doc.createComment(SELECTION_START.slice(4, -3));
    const end = board.doc.createComment(SELECTION_END.slice(4, -3));
    if (target === board.slot) {
      target.prepend(begin);
      target.append(end);
    } else {
      target.before(begin);
      target.after(end);
    }
  });
  const svg = board.slot?.innerHTML ?? "";
  board.slot?.remove();
  return { html: board.doc.body.innerHTML, svg, matched };
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

export const EDIT_SURROUND_NOTE = "Included surrounding source so the change hits only this spot.";

const SCRIPT_BUILT = "The lesson script may have built this element, so it isn't in the stored source.";
const SPLIT_TAGS = "Tags sit in the middle of this selection, so it isn't one stretch of the stored source.";
const NO_STRETCH = "This element isn't one stretch of the stored source.";

export interface EditSlice {
  component: "html" | "svg";
  /** The exact source substring whiteboard_edit will find. Empty when the spot cannot be edited. */
  find: string;
  /** Why Confirm stays disabled for this row. */
  error?: string;
  /** Set when the field includes source around the selection so the match is unique. */
  note?: string;
}

function indexesOf(source: string, needle: string): number[] {
  const hits: number[] = [];
  if (!needle) return hits;
  let at = 0;
  while ((at = source.indexOf(needle, at)) !== -1) {
    hits.push(at);
    at += needle.length;
  }
  return hits;
}

function collapsedAround(source: string, index: number, length: number): { before: string; after: string } {
  const raw = (text: string) => text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
  return {
    before: raw(source.slice(Math.max(0, index - 240), index)),
    after: raw(source.slice(index + length, index + length + 240)),
  };
}

function pickOccurrence(source: string, exact: string, prefix: string, suffix: string): number {
  const hits = indexesOf(source, exact);
  if (hits.length === 0) return -1;
  let best = hits[0]!;
  let bestScore = -1;
  const wantPrefix = prefix.trim();
  const wantSuffix = suffix.trim();
  for (const hit of hits) {
    const around = collapsedAround(source, hit, exact.length);
    let score = 0;
    if (wantPrefix && around.before.trimEnd().endsWith(wantPrefix)) score += 2;
    else if (wantPrefix && around.before.includes(wantPrefix)) score += 1;
    if (wantSuffix && around.after.trimStart().startsWith(wantSuffix)) score += 2;
    else if (wantSuffix && around.after.includes(wantSuffix)) score += 1;
    if (score > bestScore) {
      bestScore = score;
      best = hit;
    }
  }
  return best;
}

/** If a bound sits inside a tag, move it to the edge of that tag so the field is not a cut tag. */
function outsideTags(source: string, start: number, end: number): { start: number; end: number } {
  const open = source.lastIndexOf("<", start);
  const close = open === -1 ? -1 : source.indexOf(">", open);
  if (open !== -1 && close >= start) start = open;
  const openEnd = source.lastIndexOf("<", Math.max(start, end - 1));
  const closeEnd = openEnd === -1 ? -1 : source.indexOf(">", openEnd);
  if (openEnd !== -1 && openEnd < end && closeEnd >= end - 1) end = closeEnd + 1;
  return { start, end };
}

/** Grow a raw window around index until it occurs once. The exact needle itself sets grew to false. */
function uniqueWindow(source: string, index: number, length: number): { slice: string; grew: boolean } {
  const exact = source.slice(index, index + length);
  if (indexesOf(source, exact).length === 1) return { slice: exact, grew: false };
  let pad = 1;
  let start = index;
  let end = index + length;
  while (true) {
    start = Math.max(0, index - pad);
    end = Math.min(source.length, index + length + pad);
    const slice = source.slice(start, end);
    if (indexesOf(source, slice).length === 1 || (start === 0 && end === source.length)) break;
    pad *= 2;
  }
  const snapped = outsideTags(source, start, end);
  const slice = source.slice(snapped.start, snapped.end);
  if (indexesOf(source, slice).length === 1) return { slice, grew: true };
  return { slice: source.slice(start, end), grew: true };
}

const VOID_TAGS = new Set(["img", "br", "hr", "input", "image", "use", "link", "meta"]);

function expandToTag(source: string, index: number): string | null {
  const start = source.lastIndexOf("<", index);
  if (start < 0 || source[start + 1] === "/") return null;
  const name = /^<([A-Za-z][\w:-]*)/.exec(source.slice(start))?.[1];
  if (!name) return null;
  const openEnd = source.indexOf(">", start);
  if (openEnd < 0) return null;
  const open = source.slice(start, openEnd + 1);
  if (open.endsWith("/>") || VOID_TAGS.has(name.toLowerCase())) return open;
  const openRe = new RegExp(`<${name}\\b[^>]*>`, "gi");
  const closeRe = new RegExp(`</${name}\\s*>`, "gi");
  let depth = 1;
  let cursor = openEnd + 1;
  while (depth > 0 && cursor < source.length) {
    openRe.lastIndex = cursor;
    closeRe.lastIndex = cursor;
    const nextOpen = openRe.exec(source);
    const nextClose = closeRe.exec(source);
    if (!nextClose) return null;
    if (nextOpen && nextOpen.index < nextClose.index) {
      depth += 1;
      cursor = nextOpen.index + nextOpen[0].length;
    } else {
      depth -= 1;
      cursor = nextClose.index + nextClose[0].length;
      if (depth === 0) return source.slice(start, cursor);
    }
  }
  return null;
}

function rawSliceForElement(source: string, el: Element): { slice: string; grew: boolean } | null {
  const parsed = el.outerHTML;
  const parsedHits = indexesOf(source, parsed);
  if (parsedHits.length === 1) return { slice: parsed, grew: false };
  if (parsedHits.length > 1) {
    const same = [...el.ownerDocument.querySelectorAll(el.localName)].filter((node) => node.outerHTML === parsed);
    const at = parsedHits[same.indexOf(el)];
    if (at === undefined) return null;
    return uniqueWindow(source, at, parsed.length);
  }
  for (const name of ["id", "src", "alt", "href"]) {
    const value = el.getAttribute(name);
    if (!value) continue;
    for (const needle of [`${name}="${value}"`, `${name}='${value}'`]) {
      const hits = indexesOf(source, needle);
      if (hits.length !== 1) continue;
      const tag = expandToTag(source, hits[0]!);
      if (!tag) continue;
      const tags = indexesOf(source, tag);
      if (tags.length === 1) return { slice: tag, grew: false };
      return uniqueWindow(source, tags[0]!, tag.length);
    }
  }
  return null;
}

/**
 * The stored-source substring a learner edit replaces. Text uses the selected words when they
 * occur once. A picture or other element uses its stored tag. Nothing here reads the live frame.
 */
export function editSlice(sources: BoardSources, anchor: SelectionAnchor): EditSlice {
  const component = anchor.component;
  const source = sources[component];
  const board = parseBoard(sources);
  const target = board ? findTarget(board, anchor.selector) : null;
  if (anchor.kind === "text" && anchor.quote.exact) {
    const hits = indexesOf(source, anchor.quote.exact);
    if (hits.length === 1) return { component, find: anchor.quote.exact };
    if (hits.length > 1) {
      const at = pickOccurrence(source, anchor.quote.exact, anchor.quote.prefix, anchor.quote.suffix);
      const window = uniqueWindow(source, at, anchor.quote.exact.length);
      return { component, find: window.slice, ...(window.grew ? { note: EDIT_SURROUND_NOTE } : {}) };
    }
    return { component, find: "", error: target ? SPLIT_TAGS : SCRIPT_BUILT };
  }
  if (!target) return { component, find: "", error: SCRIPT_BUILT };
  const raw = rawSliceForElement(source, target);
  if (!raw) return { component, find: "", error: NO_STRETCH };
  return { component, find: raw.slice, ...(raw.grew ? { note: EDIT_SURROUND_NOTE } : {}) };
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
  /** The current selection, or null when the learner cleared it. */
  onSelection?: (anchors: SelectionAnchor[] | null) => void;
  /** The start field changed. */
  onDraft?: () => void;
}

const rendered = new WeakMap<HTMLElement, string>();
const handlersFor = new WeakMap<HTMLElement, BoardHandlers>();
const listening = new WeakSet<HTMLElement>();

function renderKey(sources: BoardSources, images: BoardImageSources): string {
  const pictures = Object.entries(images).map(([id, src]) => `${id}:${src.length}:${src.slice(0, 64)}`);
  return [...BOARD_COMPONENTS.map((key) => sources[key]), ...pictures].join("\0");
}

function text(value: unknown, limit: number): string | null {
  return typeof value === "string" ? value.slice(0, limit) : null;
}

/** One anchor, or a list of them. A single object from an older frame still counts as one. */
export function readAnchors(value: unknown): SelectionAnchor[] {
  const list = Array.isArray(value) ? value : value == null ? [] : [value];
  return list.flatMap((item) => {
    const anchor = readAnchor(item);
    return anchor ? [anchor] : [];
  });
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
    const data = event.data as { source?: unknown; type?: unknown; anchor?: unknown; anchors?: unknown } | null;
    if (data?.source !== BRIDGE_SOURCE) return;
    const onSelection = handlersFor.get(host)?.onSelection;
    if (data.type === "clear") onSelection?.(null);
    if (data.type !== "selection") return;
    const anchors = readAnchors(data.anchors ?? data.anchor);
    if (anchors.length) onSelection?.(anchors);
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
  hint.textContent = "Name a topic or ask a question. Later, select text, click a picture or shape, or drag a box around elements.";
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

export function renderWhiteboard(host: HTMLElement, sources: BoardSources, handlers?: BoardHandlers, images: BoardImageSources = {}): void {
  if (handlers) handlersFor.set(host, handlers);
  listen(host);
  const key = renderKey(sources, images);
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
  frame.srcdoc = assembleBoardDocument(sources, images);
  host.append(frame);
}
