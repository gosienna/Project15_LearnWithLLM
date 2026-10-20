import {
  ensureSectionComments,
  outline,
  parseLesson,
  serializeLesson,
  slugify,
  uniqueId,
  type Lesson,
  type Section,
} from "./markdown.ts";

const MAX_DOCUMENT_CHARS = 200_000;

export interface SectionOutline {
  id: string;
  heading: string;
}

function assertString(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string.`);
  return value;
}

function outlineError(lesson: Lesson, message: string): Error {
  return new Error(`${message} Current outline: ${JSON.stringify(outline(lesson))}`);
}

interface SectionRange {
  id: string;
  start: number;
  end: number;
  section: Section;
}

function sectionRanges(markdown: string, lesson: Lesson): SectionRange[] {
  const matcher = /^<!--\s*section:([a-z0-9-]{1,48})\s*-->/gm;
  const matches = [...markdown.matchAll(matcher)];
  return matches.map((match, index) => {
    const id = match[1];
    const section = lesson.sections.find((item) => item.id === id);
    if (!section || match.index === undefined) {
      throw new Error(`Section "${id}" is missing from the lesson.`);
    }
    const next = matches[index + 1];
    return {
      id,
      start: match.index,
      end: next?.index ?? markdown.length,
      section,
    };
  });
}

function formatSection(section: Section, trailingBlank: boolean): string {
  const hashes = section.level === 3 ? "###" : "##";
  const body = section.body.trim();
  let text = `<!-- section:${section.id} -->\n${hashes} ${section.heading}\n\n`;
  if (body) text += `${body}\n`;
  if (trailingBlank) text += "\n";
  return text;
}

function canonicalIfNeeded(markdown: string): { source: string; lesson: Lesson } {
  const lesson = parseLesson(ensureSectionComments(markdown));
  const canonical = serializeLesson(lesson);
  if (!markdown.trim()) return { source: "", lesson };
  if (canonical === markdown) return { source: markdown, lesson };
  return { source: canonical, lesson: parseLesson(canonical) };
}

export function replaceDocument(markdown: string): {
  markdown: string;
  title: string;
  sections: SectionOutline[];
} {
  const text = assertString(markdown, "markdown");
  if (text.trim() === "") throw new Error("markdown is empty.");
  if (text.length > MAX_DOCUMENT_CHARS) {
    throw new Error("markdown is longer than 200000 characters.");
  }
  const lesson = parseLesson(ensureSectionComments(text));
  if (!lesson.title.trim()) throw new Error("The lesson must start with a # title.");
  const serialized = serializeLesson(lesson);
  return {
    markdown: serialized,
    title: lesson.title.trim(),
    sections: outline(lesson),
  };
}

export function replaceSection(
  markdown: string,
  input: { sectionId: string; body: string; heading?: string },
): string {
  const sectionId = assertString(input.sectionId, "sectionId");
  const body = assertString(input.body, "body");
  if (input.heading !== undefined) {
    const heading = assertString(input.heading, "heading");
    if (!heading.trim()) throw new Error("heading must be a non-empty string.");
  }
  const { source, lesson } = canonicalIfNeeded(markdown);
  const ranges = sectionRanges(source, lesson);
  const range = ranges.find((item) => item.id === sectionId);
  if (!range) throw outlineError(lesson, `Unknown section "${sectionId}".`);
  const next: Section = {
    ...range.section,
    heading: input.heading !== undefined ? input.heading.trim() : range.section.heading,
    body: body.trim(),
  };
  const trailingBlank = range.end !== source.length;
  return source.slice(0, range.start) + formatSection(next, trailingBlank) + source.slice(range.end);
}

export function insertSection(
  markdown: string,
  input: { heading: string; body: string; afterSectionId?: string; level?: number },
): { markdown: string; id: string; heading: string; afterSectionId: string | null } {
  const heading = assertString(input.heading, "heading").trim();
  const body = assertString(input.body, "body");
  if (!heading) throw new Error("heading must be a non-empty string.");
  let level: 2 | 3 = 2;
  if (input.level !== undefined) {
    if (input.level !== 2 && input.level !== 3) throw new Error("level must be 2 or 3.");
    level = input.level;
  }
  const afterSectionId = input.afterSectionId === undefined ? null : assertString(input.afterSectionId, "afterSectionId");
  const { source, lesson } = canonicalIfNeeded(markdown);
  const used = new Set(lesson.sections.map((section) => section.id));
  const id = uniqueId(slugify(heading), used);
  const section: Section = { id, level, heading, body: body.trim() };

  if (!source.trim()) {
    const created = serializeLesson({ title: "New topic", preamble: "", sections: [section] });
    return { markdown: created, id, heading, afterSectionId };
  }

  if (afterSectionId === null) {
    const title = /^#(?!#)\s+.*$/m.exec(source);
    if (!title || title.index === undefined) {
      throw new Error("The lesson must start with a # title.");
    }
    const lineEnd = title.index + title[0].length;
    let rest = lineEnd;
    while (source[rest] === "\n") rest += 1;
    const block = formatSection(section, rest < source.length);
    return {
      markdown: `${source.slice(0, lineEnd)}\n\n${block}${source.slice(rest)}`,
      id,
      heading,
      afterSectionId,
    };
  }

  const ranges = sectionRanges(source, lesson);
  const range = ranges.find((item) => item.id === afterSectionId);
  if (!range) throw outlineError(lesson, `Unknown section "${afterSectionId}".`);
  const atEnd = range.end === source.length;
  const block = formatSection(section, !atEnd);
  if (atEnd) {
    const prefix = source.endsWith("\n\n") ? source : `${source.replace(/\n*$/, "")}\n\n`;
    return { markdown: prefix + formatSection(section, false), id, heading, afterSectionId };
  }
  return {
    markdown: source.slice(0, range.end) + block + source.slice(range.end),
    id,
    heading,
    afterSectionId,
  };
}

export function deleteSection(markdown: string, sectionId: string): {
  markdown: string;
  deleted: string;
  sections: SectionOutline[];
} {
  const id = assertString(sectionId, "sectionId");
  const { source, lesson } = canonicalIfNeeded(markdown);
  const ranges = sectionRanges(source, lesson);
  const range = ranges.find((item) => item.id === id);
  if (!range) throw outlineError(lesson, `Unknown section "${id}".`);
  const nextMarkdown = source.slice(0, range.start) + source.slice(range.end);
  const next = parseLesson(nextMarkdown);
  return {
    markdown: nextMarkdown,
    deleted: id,
    sections: outline(next),
  };
}

export function readSection(markdown: string, sectionId: string | undefined): unknown {
  const lesson = parseLesson(markdown);
  if (sectionId === undefined) {
    return { title: lesson.title, sections: outline(lesson) };
  }
  if (typeof sectionId !== "string") throw new Error("sectionId must be a string.");
  const section = lesson.sections.find((item) => item.id === sectionId);
  if (!section) throw outlineError(lesson, `Unknown section "${sectionId}".`);
  const hashes = section.level === 3 ? "###" : "##";
  const body = section.body.trim();
  const rendered = body ? `${hashes} ${section.heading}\n\n${body}` : `${hashes} ${section.heading}`;
  return { id: section.id, heading: section.heading, markdown: rendered };
}
