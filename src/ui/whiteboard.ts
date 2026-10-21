import { BOARD_COMPONENTS, type BoardComponent, type BoardSources } from "../types.ts";

export const WHITEBOARD_PLACEHOLDER = "The lesson will appear here.";
export const SNAPSHOT_TEXT_LIMIT = 8_000;

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

const rendered = new WeakMap<HTMLElement, string>();

function renderKey(sources: BoardSources): string {
  return BOARD_COMPONENTS.map((key) => sources[key]).join("\0");
}

export function renderWhiteboard(host: HTMLElement, sources: BoardSources): void {
  const key = renderKey(sources);
  if (rendered.get(host) === key && host.childElementCount > 0) return;
  rendered.set(host, key);
  host.replaceChildren();
  if (boardIsEmpty(sources)) {
    const placeholder = document.createElement("p");
    placeholder.className = "board-placeholder";
    placeholder.textContent = WHITEBOARD_PLACEHOLDER;
    host.append(placeholder);
    return;
  }
  const frame = document.createElement("iframe");
  frame.className = "board-frame";
  frame.title = "Whiteboard";
  frame.setAttribute("sandbox", "allow-scripts");
  frame.referrerPolicy = "no-referrer";
  frame.srcdoc = assembleBoardDocument(sources);
  host.append(frame);
}
