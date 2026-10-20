import { describe, expect, it } from "vitest";
import { parseLesson, serializeLesson } from "./markdown.ts";
import { insertSection, replaceSection } from "./ops.ts";

function sample(): string {
  return serializeLesson({
    title: "Photosynthesis",
    preamble: "",
    sections: [
      { id: "overview", level: 2, heading: "Overview", body: "Plants store energy from light in sugar." },
      { id: "calvin-cycle", level: 2, heading: "The Calvin cycle", body: "The cycle fixes carbon." },
      { id: "light", level: 3, heading: "Light reactions", body: "Water splits." },
    ],
  });
}

describe("document operations", () => {
  it("replaces one section and leaves the others byte-for-byte", () => {
    const source = sample();
    const calvin = source.slice(source.indexOf("<!-- section:calvin-cycle -->"));
    const light = source.slice(source.indexOf("<!-- section:light -->"));
    const next = replaceSection(source, {
      sectionId: "overview",
      body: "Leaves capture sunlight.",
    });
    expect(parseLesson(next).sections[0]).toMatchObject({
      id: "overview",
      body: "Leaves capture sunlight.",
    });
    expect(next.slice(next.indexOf("<!-- section:calvin-cycle -->"))).toBe(calvin);
    expect(next.slice(next.indexOf("<!-- section:light -->"))).toBe(light);
    expect(next).not.toBe(source);
  });

  it("inserts after the named section and allocates a unique id", () => {
    const source = sample();
    const inserted = insertSection(source, {
      afterSectionId: "overview",
      heading: "Overview",
      body: "A second pass over the same idea.",
    });
    expect(inserted.id).toBe("overview-2");
    expect(inserted.afterSectionId).toBe("overview");
    const ids = parseLesson(inserted.markdown).sections.map((section) => section.id);
    expect(ids).toEqual(["overview", "overview-2", "calvin-cycle", "light"]);
    const first = insertSection(source, { heading: "Prelude", body: "Before the rest." });
    expect(parseLesson(first.markdown).sections.map((section) => section.id)[0]).toBe(first.id);
  });
});
