import { describe, expect, it } from "vitest";
import { parseLesson, serializeLesson } from "./markdown.ts";

describe("lesson markdown", () => {
  it("keeps section ids through a serialize and parse round trip", () => {
    const lesson = {
      title: "Photosynthesis",
      preamble: "",
      sections: [
        { id: "overview", level: 2 as const, heading: "Overview", body: "Plants store energy from light in sugar." },
        { id: "calvin-cycle", level: 2 as const, heading: "The Calvin cycle", body: "Carbon dioxide becomes sugar." },
        { id: "electron-transport", level: 3 as const, heading: "Electron transport", body: "Light excites electrons." },
      ],
    };
    const serialized = serializeLesson(lesson);
    const again = parseLesson(serialized);
    expect(again.sections.map((section) => section.id)).toEqual(lesson.sections.map((section) => section.id));
    expect(again.sections.map((section) => section.heading)).toEqual(lesson.sections.map((section) => section.heading));
    expect(again.sections.map((section) => section.body)).toEqual(lesson.sections.map((section) => section.body));
    expect(again.sections.map((section) => section.level)).toEqual(lesson.sections.map((section) => section.level));
    expect(serializeLesson(again)).toBe(serialized);
  });

  it("keeps a preamble that sits under the title", () => {
    const lesson = {
      title: "Photosynthesis",
      preamble: "Plants convert light into sugar.",
      sections: [{ id: "overview", level: 2 as const, heading: "Overview", body: "A closer look." }],
    };
    const again = parseLesson(serializeLesson(lesson));
    expect(again.preamble).toBe(lesson.preamble);
    expect(again.sections[0]?.id).toBe("overview");
  });
});
