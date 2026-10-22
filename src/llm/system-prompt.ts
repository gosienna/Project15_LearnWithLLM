import { outline, parseLesson, type Section } from "../document/markdown.ts";
import { BOARD_COMPONENTS, selectionList, type BoardImage, type BoardSources, type SelectionAnchor } from "../types.ts";
import { BOARD_MODULES } from "../ui/board-modules.ts";
import { boardIsEmpty, markSelections, markSource, SELECTION_END, SELECTION_START } from "../ui/whiteboard.ts";

export const INSTRUCTIONS = `You teach on one surface: the whiteboard, a page of html, css, js, svg, and json.
The learner sees only the whiteboard. Your text reply is not shown, so every answer goes through the whiteboard tools.
If the whiteboard is empty, write a lesson page that answers the question with whiteboard_set.
If the prompt has a # Selection section, the learner pointed at one or more spots on the page. Answer about those spots and keep the rest of the page as it is. The source around each spot marks it with ${SELECTION_START} and ${SELECTION_END}; never write those markers into the page.
To add a note, an example, or a new section, call whiteboard_insert with only the new html; it lands right after the selection. To change a few words or lines, call whiteboard_edit. Use whiteboard_set only to write a component from scratch or rewrite most of it, after whiteboard_view.
To explain a word or the selected spot without changing the page, call whiteboard_explain with a short plain-text explanation; it shows in a floating box the learner closes and is not saved.
The SVG is inserted in #lesson-svg. To draw, call whiteboard_set with component "svg" and source set to one raw <svg> element with width and height in pixels. Do not call whiteboard_replace_document. Do not wrap the SVG in a sentence or backticks. Draw with basic shapes (rect, circle, line, polygon, text), not long path data. Do not paste that same diagram into html.
Parsed JSON is lessonData inside the page, or null when json is empty. Put labels, steps, and numbers there when the script should stay stable.
Call whiteboard_snapshot to read what the page currently says.
${BOARD_MODULES.map((module) => module.usage).join("\n")}
A stored markdown document exists only after the learner stores the learning material. It is not the live page. Call whiteboard_store_material only when the learner asks to store it.`;

/** Added to the instructions when the ask offers web_search. */
export const WEB_SEARCH_INSTRUCTIONS = `# Web search
Call web_search when the question needs current facts, numbers, or names you are not sure of. Search before you write, then teach from what the results say.
When you use results, end the lesson with a Sources list of <a href="url" target="_blank" rel="noopener">title</a> links. Never invent a url.
When a picture would help, call web_search with include_images true and show an image with <img src="url" alt="what it shows" style="max-width:100%">. Use only image urls from the results, and list the image's page in Sources.`;

/** Added when the ask offers whiteboard_add_image: pictures are saved with the topic, not hotlinked. */
export const IMAGE_INSTRUCTIONS = `# Images
Do not put a web_search image url in <img> directly. To show a picture that web_search found, first call whiteboard_add_image with its url and a short description. Then put <img src="board-image:ID" alt="what it shows" style="max-width:100%"> in the html, with the id it returned. Credit the image's page in Sources.
Use only board-image ids that whiteboard_add_image returned or that the whiteboard lists below.`;

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
  /** Where the learner pointed. One spot, or every element in a box. Absent for the first question and for toolbar actions. */
  anchor?: SelectionAnchor | readonly SelectionAnchor[] | null;
  contextTokens?: number;
  reservedTokens?: number;
  maxFullSections?: number;
  /** A system prompt pinned to the topic; replaces the instructions, board status, and material. */
  systemOverride?: string;
  /** The ask offers web_search. */
  webSearch?: boolean;
  /** The ask offers whiteboard_add_image. */
  imageTools?: boolean;
  /** The topic's saved images, listed in the board status. */
  images?: readonly Pick<BoardImage, "id" | "description">[];
}

export interface BuiltPrompt {
  system: string;
  /** What the session is prompted with: the selection and its source, then the question. */
  prompt: string;
}

export function boardStatus(sources: BoardSources, images: readonly Pick<BoardImage, "id" | "description">[] = []): string {
  const pictures = images.length
    ? `\nImages: ${images.map((image) => `${image.id} (${image.description})`).join(", ")}.`
    : "";
  if (boardIsEmpty(sources)) return `${EMPTY_BOARD_LINE}${pictures}`;
  return BOARD_COMPONENTS.map((key) => `${key}: ${sources[key].length} characters`).join(", ") + "." + pictures;
}

export function whiteboardPreface(status: string, includeMaterial: boolean, webSearch = false, imageTools = false): string {
  const extra = `${webSearch ? `${WEB_SEARCH_INSTRUCTIONS}\n\n` : ""}${imageTools ? `${IMAGE_INSTRUCTIONS}\n\n` : ""}`;
  let text = `${INSTRUCTIONS}\n\n${extra}# Whiteboard\n${status}\n`;
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
  const header = whiteboardPreface(
    boardStatus(options.sources, options.images),
    materialMarkdown.length > 0,
    options.webSearch === true,
    options.imageTools === true,
  );
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

function selectionBody(anchor: SelectionAnchor): string {
  const what = anchor.kind === "text" ? `selected text inside a <${anchor.tag}>` : `picked the whole <${anchor.tag}> element`;
  const quote = anchor.quote.exact
    ? `${anchor.quote.prefix ? `…${anchor.quote.prefix}` : ""}[[${anchor.quote.exact}]]${anchor.quote.suffix ? `${anchor.quote.suffix}…` : ""}`
    : "(no text)";
  return [
    `The learner ${what} in the ${anchor.component} of the whiteboard.`,
    `selector: ${anchor.selector}`,
    `text, selection in [[ ]]: ${quote}`,
    "element as the page shows it:",
    anchor.outerHTML,
  ].join("\n");
}

function selectionHead(anchor: SelectionAnchor): string {
  return `# Selection\n${selectionBody(anchor)}`;
}

function oneSelection(sources: BoardSources, anchor: SelectionAnchor, question: string, tokenBudget: number): string {
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

function manySelections(sources: BoardSources, anchors: readonly SelectionAnchor[], question: string, tokenBudget: number): string {
  const bodies = anchors.map((anchor, index) => `${index + 1}. ${selectionBody(anchor)}`).join("\n\n");
  const head = `# Selection\nThe learner selected ${anchors.length} elements. whiteboard_insert places new html after the last one.\n\n${bodies}`;
  const tail = `# Question\n${question}`;
  const marked = markSelections(sources, anchors);
  const blocks: string[] = [];
  for (const component of ["html", "svg"] as const) {
    if (!anchors.some((anchor) => anchor.component === component)) continue;
    const any = marked.matched.some((ok, index) => ok && anchors[index]?.component === component);
    const where = any
      ? `The selected elements are between ${SELECTION_START} and ${SELECTION_END}.`
      : "The selectors did not match the stored source; the lesson's script may have built those elements. Use the text and the elements above to find the spots.";
    blocks.push(`# Source: ${component}\n${where}`);
  }
  const intro = blocks.join("\n\n");
  const left = tokenBudget - estimateTokens(`${head}\n\n${intro}\n\n${tail}`);
  const limit = Math.max(800, left * CHARS_PER_TOKEN);
  const sourcesText = blocks
    .map((block) => {
      const component = block.startsWith("# Source: svg") ? "svg" : "html";
      const text = component === "svg" ? marked.svg : marked.html;
      return `${block}\n${text.trim() ? sourceWindow(text, limit) : "(empty)"}`;
    })
    .join("\n\n");
  return `${head}\n\n${sourcesText}\n\n${tail}`;
}

/** The selection, the source around it, and the question, within what the budget leaves. */
export function selectionPrompt(
  sources: BoardSources,
  anchor: SelectionAnchor | readonly SelectionAnchor[],
  question: string,
  tokenBudget: number,
): string {
  const anchors = selectionList(anchor);
  const one = anchors[0];
  if (!one) return `# Question\n${question}`;
  if (anchors.length === 1) return oneSelection(sources, one, question, tokenBudget);
  return manySelections(sources, anchors, question, tokenBudget);
}

function without(text: string, block: string): string {
  return text.split(`${block}\n\n`).join("").split(block).join("");
}

/** A pinned system prompt follows the Web search switch: the instructions are dropped, then added back while it is on. */
export function pinnedSystem(text: string, webSearch: boolean, imageTools = false): string {
  const base = without(without(text, WEB_SEARCH_INSTRUCTIONS), IMAGE_INSTRUCTIONS).trimEnd();
  return `${base}${webSearch ? `\n\n${WEB_SEARCH_INSTRUCTIONS}` : ""}${imageTools ? `\n\n${IMAGE_INSTRUCTIONS}` : ""}`;
}

export function buildPrompt(options: BuildPromptOptions): BuiltPrompt {
  const contextTokens = options.contextTokens ?? 8192;
  const reservedTokens = options.reservedTokens ?? 1500;
  const budget = Math.max(256, contextTokens - reservedTokens);
  const system =
    options.systemOverride === undefined
      ? automaticSystem(options, budget)
      : pinnedSystem(options.systemOverride, options.webSearch === true, options.imageTools === true);
  const anchors = selectionList(options.anchor);
  if (anchors.length === 0 || boardIsEmpty(options.sources)) return { system, prompt: options.question };
  const remaining = Math.max(256, budget - estimateTokens(system));
  return { system, prompt: selectionPrompt(options.sources, anchors, options.question, remaining) };
}
