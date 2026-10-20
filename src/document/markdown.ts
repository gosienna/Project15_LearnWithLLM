export interface Section {
  id: string;
  level: 2 | 3;
  heading: string;
  body: string;
}

export interface Lesson {
  title: string;
  preamble: string;
  sections: Section[];
}

export interface SectionOutline {
  id: string;
  heading: string;
}

const SECTION_COMMENT = /^<!--\s*section:([a-z0-9-]{1,48})\s*-->\s*$/;
const TITLE_LINE = /^#(?!#)\s+(.*)$/;
const HEADING_LINE = /^(##|###)\s+(.*)$/;

export function slugify(heading: string): string {
  const base = heading
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return base || "section";
}

export function uniqueId(base: string, used: Set<string>): string {
  const root = /^[a-z0-9-]{1,48}$/.test(base) ? base : slugify(base);
  if (!used.has(root)) return root;
  let n = 2;
  while (n < 10_000) {
    const suffix = `-${n}`;
    const trimmed = root.slice(0, Math.max(1, 48 - suffix.length)).replace(/-+$/g, "") || "section";
    const id = `${trimmed}${suffix}`.slice(0, 48);
    if (!used.has(id)) return id;
    n += 1;
  }
  throw new Error("Could not allocate a section id.");
}

function trimBody(body: string): string {
  return body.replace(/^\n+/, "").replace(/\n+$/, "");
}

export function parseLesson(markdown: string): Lesson {
  const lines = markdown.replace(/\r\n/g, "\n").replace(/^\uFEFF/, "").split("\n");
  let title = "";
  let start = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const match = TITLE_LINE.exec(lines[i]);
    if (match) {
      title = match[1].trim();
      start = i + 1;
      break;
    }
  }

  const sections: Section[] = [];
  const used = new Set<string>();
  const preambleLines: string[] = [];
  let pendingId: string | null = null;
  let current: { id: string; level: 2 | 3; heading: string; lines: string[] } | null = null;
  let seenSection = false;

  const flush = () => {
    if (!current) return;
    sections.push({
      id: current.id,
      level: current.level,
      heading: current.heading,
      body: trimBody(current.lines.join("\n")),
    });
    current = null;
  };

  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i];
    const comment = SECTION_COMMENT.exec(line);
    if (comment) {
      flush();
      seenSection = true;
      pendingId = comment[1];
      continue;
    }
    const heading = HEADING_LINE.exec(line);
    if (heading) {
      flush();
      seenSection = true;
      const level: 2 | 3 = heading[1] === "###" ? 3 : 2;
      const text = heading[2].trim();
      let id = pendingId && SECTION_COMMENT.test(`<!-- section:${pendingId} -->`) ? pendingId : slugify(text);
      pendingId = null;
      id = uniqueId(id, used);
      used.add(id);
      current = { id, level, heading: text, lines: [] };
      continue;
    }
    if (!seenSection) preambleLines.push(line);
    else if (current) current.lines.push(line);
  }
  flush();

  return {
    title,
    preamble: trimBody(preambleLines.join("\n")),
    sections,
  };
}

export function serializeLesson(lesson: Lesson): string {
  if (!lesson.title && !lesson.preamble && lesson.sections.length === 0) return "";
  const lines = [`# ${lesson.title.trim() || "New topic"}`];
  if (lesson.preamble.trim()) {
    lines.push("");
    lines.push(lesson.preamble.trim());
  }
  for (const section of lesson.sections) {
    lines.push("");
    lines.push(`<!-- section:${section.id} -->`);
    lines.push(`${section.level === 3 ? "###" : "##"} ${section.heading}`);
    lines.push("");
    if (section.body.trim()) lines.push(section.body.trim());
  }
  return `${lines.join("\n")}\n`;
}

export function outline(lesson: Lesson, cap = 80): SectionOutline[] {
  return lesson.sections.slice(0, cap).map((section) => ({
    id: section.id,
    heading: section.heading,
  }));
}

export function ensureSectionComments(markdown: string): string {
  const normalized = markdown.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const used = new Set<string>();
  for (const line of lines) {
    const match = SECTION_COMMENT.exec(line);
    if (match) used.add(match[1]);
  }
  const out: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const heading = HEADING_LINE.exec(lines[i]);
    if (heading) {
      let prev = i - 1;
      while (prev >= 0 && lines[prev].trim() === "") prev -= 1;
      const hasComment = prev >= 0 && SECTION_COMMENT.test(lines[prev]);
      if (!hasComment) {
        const id = uniqueId(slugify(heading[2]), used);
        used.add(id);
        out.push(`<!-- section:${id} -->`);
      }
    }
    out.push(lines[i]);
  }
  return out.join("\n");
}

export function markdownForDisplay(markdown: string): string {
  return markdown
    .split("\n")
    .filter((line) => !SECTION_COMMENT.test(line))
    .join("\n");
}
