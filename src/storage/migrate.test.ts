import { describe, expect, it } from "vitest";
import { addImagesField, migrateTopicRecord } from "./db.ts";

describe("topic migration", () => {
  it("turns a markdown lesson into stored material plus static html", () => {
    const row: Record<string, unknown> = {
      id: "t1",
      title: "Photosynthesis",
      documentMarkdown: "# Photosynthesis\n\n<!-- section:overview -->\n## Overview\n\nLeaves capture sunlight.\n",
      messages: [],
      createdAt: 1,
      updatedAt: 1,
    };
    expect(migrateTopicRecord(row)).toBe(true);
    expect(row.documentMarkdown).toBeUndefined();
    expect(row.materialMarkdown).toContain("Leaves capture sunlight.");
    expect(row.html).toContain("Leaves capture sunlight.");
    expect(row.html).not.toContain("<script");
    expect(row.css).toBe("");
    expect(row.js).toBe("");
    expect(row.svg).toBe("");
    expect(row.json).toBe("");
  });

  it("adds an empty image list to v2 topics, once", () => {
    const row: Record<string, unknown> = { id: "t1", html: "<p>x</p>" };
    expect(addImagesField(row)).toBe(true);
    expect(row.images).toEqual([]);
    expect(addImagesField(row)).toBe(false);
  });
});
