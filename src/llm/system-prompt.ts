import { outline, parseLesson, type Section } from "../document/markdown.ts";
import type { DialogueMessage, PromptMessage } from "../types.ts";

export const FIXED_INSTRUCTIONS = `You teach with two surfaces.
The whiteboard is the lesson. Change it only by calling whiteboard tools.
The chat is for the learner. Keep chat replies short. Do not paste the lesson into the chat.
If the whiteboard is empty, write the lesson with whiteboard_replace_document, then tell the learner what you added.
If the learner asks to change the lesson, edit the section with whiteboard_replace_section or whiteboard_insert_section.
If the learner asks a question, answer in chat. Update the whiteboard only when the answer should become part of the lesson.`;

export const EMPTY_BOARD_LINE = "The whiteboard is empty.";
export const WHITEBOARD_PLACEHOLDER = "The lesson will appear here.";

const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export interface BuildPromptOptions {
  markdown: string;
  messages: DialogueMessage[];
  contextTokens?: number;
  reservedTokens?: number;
  maxFullSections?: number;
}

export interface BuiltPrompt {
  system: string;
  history: PromptMessage[];
}

function learningMaterialHeader(): string {
  return `${FIXED_INSTRUCTIONS}\n\n# Learning material\n`;
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
      `Omitted section ids: ${omitted.map((section) => section.id).join(", ")}. Call whiteboard_read for one of them.`,
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
    `Omitted section ids: ${lesson.sections.map((section) => section.id).join(", ")}. Call whiteboard_read for one of them.`,
  ].join("\n");
  return compact;
}

export function buildPrompt(options: BuildPromptOptions): BuiltPrompt {
  const contextTokens = options.contextTokens ?? 8192;
  const reservedTokens = options.reservedTokens ?? 1500;
  const budget = Math.max(256, contextTokens - reservedTokens);
  const header = learningMaterialHeader();
  const lessonBudget = Math.max(64, budget - estimateTokens(header));
  const material = fitLesson(options.markdown, lessonBudget, options.maxFullSections);
  const system = `${header}${material}`;
  if (system.includes(WHITEBOARD_PLACEHOLDER)) {
    throw new Error("The system prompt must not include the whiteboard placeholder.");
  }

  let remaining = budget - estimateTokens(system);
  const history: PromptMessage[] = [];
  const messages = options.messages.filter((message) => message.role === "user" || message.role === "assistant");
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
