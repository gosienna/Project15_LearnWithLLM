import { outline, parseLesson, type Section } from "../document/markdown.ts";
import { BOARD_COMPONENTS, type BoardSources, type SelectionAnchor } from "../types.ts";
import { boardIsEmpty, markSource, SELECTION_END, SELECTION_START } from "../ui/whiteboard.ts";

export const INSTRUCTIONS = `You teach on one surface: the whiteboard, a page of html, css, js, svg, and json.
The learner sees only the whiteboard. Your text reply is not shown, so every answer goes onto the page through the whiteboard tools.
If the whiteboard is empty, write a lesson page that answers the question with whiteboard_set.
If the prompt has a # Selection section, the learner pointed at one spot on the page. Answer about that spot: add a short note right next to it, or correct or expand that spot. Keep the rest of the page as it is. The source around the spot marks it with ${SELECTION_START} and ${SELECTION_END}; never write those markers into the page.
Before editing a component, call whiteboard_view, then send the whole changed component with whiteboard_set.
The SVG is inserted in #lesson-svg. To draw, call whiteboard_set with component "svg" and source set to one raw <svg> element with width and height in pixels. Do not call whiteboard_replace_document. Do not wrap the SVG in a sentence or backticks. Draw with basic shapes (rect, circle, line, polygon, text), not long path data. Do not paste that same diagram into html.
Parsed JSON is lessonData inside the page, or null when json is empty. Put labels, steps, and numbers there when the script should stay stable.
Call whiteboard_snapshot to read what the page currently says.
A stored markdown document exists only after the learner stores the learning material. It is not the live page. Call whiteboard_store_material only when the learner asks to store it.`;

export const EMPTY_BOARD_LINE = "The whiteboard is empty.";

const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export interface BuildPromptOptions {
  sources: BoardSources;
  materialMarkdown: string;
  /** The learner's question. */
  question: string;
  /** Where the learner pointed. Absent for the first question and for toolbar actions. */
  anchor?: SelectionAnchor | null;
  contextTokens?: number;
  reservedTokens?: number;
  maxFullSections?: number;
  /** A system prompt pinned to the topic; replaces the instructions, board status, and material. */
  systemOverride?: string;
}

export interface BuiltPrompt {
  system: string;
  /** What the session is prompted with: the selection and its source, then the question. */
  prompt: string;
}

export function boardStatus(sources: BoardSources): string {
  if (boardIsEmpty(sources)) return EMPTY_BOARD_LINE;
  return BOARD_COMPONENTS.map((key) => `${key}: ${sources[key].length} characters`).join(", ") + ".";
}

export function whiteboardPreface(status: string, includeMaterial: boolean): string {
  let text = `${INSTRUCTIONS}\n\n# Whiteboard\n${status}\n`;
  if (includeMaterial) text += `\n# Stored learning material\n`;
  return text;
}

function renderPartial(title: string, sections: Section[], fullCount: number): string {
  const full = sections.slice(0, fullCount);
  const omitted = sections.slice(fullCount);
  const lines = [`# ${title || "Untitled"}`, "", "Sections:"];
  for (const section of sections) lines.push(`- ${section.id}: ${section.heading}`);
  for (const section of full) {
    const hashes = section.level === 3 ? "###" : "##";
    lines.push("");
    lines.push(`<!-- section:${section.id} -->`);
    lines.push(`${hashes} ${section.heading}`);
    lines.push("");
    if (section.body.trim()) lines.push(section.body.trim());
  }
  if (omitted.length > 0) {
    lines.push("");
    lines.push(
      `Omitted section ids: ${omitted.map((section) => section.id).join(", ")}. The stored learning material was shortened to fit the context window.`,
    );
  }
  return lines.join("\n");
}

export function fitLesson(markdown: string, tokenBudget: number, maxFullSections?: number): string {
  if (!markdown.trim()) return EMPTY_BOARD_LINE;
  const uncapped = maxFullSections === undefined;
  if (uncapped && estimateTokens(markdown) <= tokenBudget) return markdown;

  const lesson = parseLesson(markdown);
  const limit = maxFullSections ?? lesson.sections.length;
  let chosen = Math.min(limit, lesson.sections.length);
  while (chosen > 0 && estimateTokens(renderPartial(lesson.title, lesson.sections, chosen)) > tokenBudget) {
    chosen -= 1;
  }
  const text = renderPartial(lesson.title, lesson.sections, chosen);
  if (estimateTokens(text) <= tokenBudget) return text;

  const listed = outline(lesson);
  const compact = [
    `# ${lesson.title || "Untitled"}`,
    "",
    "Sections:",
    ...listed.map((section) => `- ${section.id}: ${section.heading}`),
    "",
    `Omitted section ids: ${lesson.sections.map((section) => section.id).join(", ")}. The stored learning material was shortened to fit the context window.`,
  ].join("\n");
  return compact;
}

function automaticSystem(options: BuildPromptOptions, budget: number): string {
  const materialMarkdown = options.materialMarkdown.trim();
  const header = whiteboardPreface(boardStatus(options.sources), materialMarkdown.length > 0);
  const lessonBudget = Math.max(64, budget - estimateTokens(header));
  const material = materialMarkdown ? fitLesson(options.materialMarkdown, lessonBudget, options.maxFullSections) : "";
  return `${header}${material}`;
}

/** At most `limit` characters of the source, centred on the selection markers when they fit. */
export function sourceWindow(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const start = text.indexOf(SELECTION_START);
  const end = text.indexOf(SELECTION_END);
  if (start === -1) return `${text.slice(0, limit)}\n…(${text.length - limit} more characters)`;
  const middle = Math.floor((start + (end === -1 ? start : end + SELECTION_END.length)) / 2);
  const from = Math.max(0, Math.min(text.length - limit, middle - Math.floor(limit / 2)));
  const to = from + limit;
  return `${from > 0 ? `…(${from} characters before)\n` : ""}${text.slice(from, to)}${to < text.length ? `\n…(${text.length - to} characters after)` : ""}`;
}

function selectionHead(anchor: SelectionAnchor): string {
  const what = anchor.kind === "text" ? `selected text inside a <${anchor.tag}>` : `picked the whole <${anchor.tag}> element`;
  const quote = anchor.quote.exact
    ? `${anchor.quote.prefix ? `…${anchor.quote.prefix}` : ""}[[${anchor.quote.exact}]]${anchor.quote.suffix ? `${anchor.quote.suffix}…` : ""}`
    : "(no text)";
  return [
    "# Selection",
    `The learner ${what} in the ${anchor.component} of the whiteboard.`,
    `selector: ${anchor.selector}`,
    `text, selection in [[ ]]: ${quote}`,
    "element as the page shows it:",
    anchor.outerHTML,
  ].join("\n");
}

/** The selection, the source around it, and the question, within what the budget leaves. */
export function selectionPrompt(sources: BoardSources, anchor: SelectionAnchor, question: string, tokenBudget: number): string {
  const head = selectionHead(anchor);
  const tail = `# Question\n${question}`;
  const marked = markSource(sources, anchor);
  const where = marked.marked
    ? `The selected element is between ${SELECTION_START} and ${SELECTION_END}.`
    : "The selector did not match the stored source; the lesson's script may have built that element. Use the text and the element above to find the spot.";
  const intro = `# Source: ${marked.component}\n${where}`;
  const left = tokenBudget - estimateTokens(`${head}\n\n${intro}\n\n${tail}`);
  const limit = Math.max(800, left * CHARS_PER_TOKEN);
  const source = marked.text.trim() ? sourceWindow(marked.text, limit) : "(empty)";
  return `${head}\n\n${intro}\n${source}\n\n${tail}`;
}

export function buildPrompt(options: BuildPromptOptions): BuiltPrompt {
  const contextTokens = options.contextTokens ?? 8192;
  const reservedTokens = options.reservedTokens ?? 1500;
  const budget = Math.max(256, contextTokens - reservedTokens);
  const system = options.systemOverride ?? automaticSystem(options, budget);
  const anchor = options.anchor;
  if (!anchor || boardIsEmpty(options.sources)) return { system, prompt: options.question };
  const remaining = Math.max(256, budget - estimateTokens(system));
  return { system, prompt: selectionPrompt(options.sources, anchor, options.question, remaining) };
}
