import { Marked } from "marked";
import { markdownForDisplay } from "./markdown.ts";

const marked = new Marked({ gfm: true, breaks: false });
marked.use({
  renderer: {
    html({ text }) {
      return escapeHtml(text);
    },
  },
});

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function markdownToStaticHtml(markdown: string): string {
  if (!markdown.trim()) return "";
  const parsed = marked.parse(markdownForDisplay(markdown), { async: false });
  return typeof parsed === "string" ? parsed : "";
}
