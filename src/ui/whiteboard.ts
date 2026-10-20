import DOMPurify from "dompurify";
import { Marked } from "marked";
import { markdownForDisplay } from "../document/markdown.ts";

export const WHITEBOARD_PLACEHOLDER = "The lesson will appear here.";

const marked = new Marked({ gfm: true, breaks: false });
marked.use({
  renderer: {
    html({ text }) {
      return escapeHtml(text);
    },
  },
});

let hooksReady = false;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function configurePurifier(): void {
  if (hooksReady) return;
  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    if (node.tagName === "A") {
      node.setAttribute("rel", "noopener noreferrer");
      node.setAttribute("target", "_blank");
    }
  });
  hooksReady = true;
}

export function renderMarkdown(markdown: string): string {
  configurePurifier();
  const source = markdownForDisplay(markdown);
  const parsed = marked.parse(source, { async: false });
  const html = typeof parsed === "string" ? parsed : "";
  return DOMPurify.sanitize(html);
}

export function renderWhiteboard(host: HTMLElement, markdown: string): void {
  host.replaceChildren();
  if (!markdown.trim()) {
    const placeholder = document.createElement("p");
    placeholder.className = "board-placeholder";
    placeholder.textContent = WHITEBOARD_PLACEHOLDER;
    host.append(placeholder);
    return;
  }
  const lesson = document.createElement("div");
  lesson.className = "lesson";
  lesson.innerHTML = renderMarkdown(markdown);
  host.append(lesson);
}
