import { outline, parseLesson, type Section } from "../document/markdown.ts";
import { BOARD_COMPONENTS, type BoardSources, type DialogueMessage, type PromptMessage } from "../types.ts";
import { boardIsEmpty } from "../ui/whiteboard.ts";

export const FIXED_INSTRUCTIONS = `You teach with two surfaces.
The whiteboard is a page of html, css, js, svg, and json. Change it only by calling whiteboard tools.
The SVG is inserted in #lesson-svg. To draw, call whiteboard_set with component "svg" and source set to one raw <svg> element with width and height in pixels. Do not call whiteboard_replace_document. Do not wrap the SVG in a sentence or backticks. Draw with basic shapes (rect, circle, line, polygon, text), not long path data. Do not paste that same diagram into html.
Parsed JSON is lessonData inside the page, or null when json is empty. Put labels, steps, and numbers there when the script should stay stable.
The chat is for the learner. Keep chat replies short. Do not paste the page source into the chat.
If the whiteboard is empty, write the page with whiteboard_set.
Before editing a component, call whiteboard_view. Call whiteboard_snapshot to read what the page currently says.
A stored markdown document exists only after the learner stores the learning material. It is not the live page. Call whiteboard_store_material only when the learner asks to store it.`;

export const EMPTY_BOARD_LINE = "The whiteboard is empty.";
export const WHITEBOARD_PLACEHOLDER = "The lesson will appear here.";

const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export interface BuildPromptOptions {
  sources: BoardSources;
  materialMarkdown: string;
  messages: DialogueMessage[];
  contextTokens?: number;
  reservedTokens?: number;
  maxFullSections?: number;
  /** A system prompt pinned to the topic; replaces the instructions, board status, and material. */
  systemOverride?: string;
}

export interface BuiltPrompt {
  system: string;
  history: PromptMessage[];
}

export function boardStatus(sources: BoardSources): string {
  if (boardIsEmpty(sources)) return EMPTY_BOARD_LINE;
  return BOARD_COMPONENTS.map((key) => `${key}: ${sources[key].length} characters`).join(", ") + ".";
}

export function whiteboardPreface(status: string, includeMaterial: boolean): string {
  let text = `${FIXED_INSTRUCTIONS}\n\n# Whiteboard\n${status}\n`;
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
  const system = `${header}${material}`;
  if (system.includes(WHITEBOARD_PLACEHOLDER)) {
    throw new Error("The system prompt must not include the whiteboard placeholder.");
  }
  return system;
}

export function buildPrompt(options: BuildPromptOptions): BuiltPrompt {
  const contextTokens = options.contextTokens ?? 8192;
  const reservedTokens = options.reservedTokens ?? 1500;
  const budget = Math.max(256, contextTokens - reservedTokens);
  const system = options.systemOverride ?? automaticSystem(options, budget);

  let remaining = budget - estimateTokens(system);
  const history: PromptMessage[] = [];
  // Assistant messages with no text are failed or stopped turns, kept only for their trace.
  const messages = options.messages.filter(
    (message) => message.role === "user" || (message.role === "assistant" && message.content.trim() !== ""),
  );
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    const cost = estimateTokens(message.content) + 1;
    if (cost > remaining) break;
    remaining -= cost;
    history.push({ role: message.role, content: message.content });
  }
  history.reverse();
  return { system, history };
}
