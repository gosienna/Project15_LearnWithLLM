// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { assembleBoardDocument, emptyBoard, renderWhiteboard, snapshotBoard, titleFromHtml } from "./whiteboard.ts";

describe("whiteboard frame", () => {
  it("renders the five sources in a sandboxed iframe and leaves the parent unmarked", () => {
    const host = document.createElement("div");
    const sources = {
      html: "<h1>Hi</h1><p>Body text</p><script>secret()</script>",
      css: "p { color: red; }",
      js: "const tag = '</script>';",
      svg: "<svg><text>Diagram</text></svg>",
      json: '{"tag":"<b>one</b>"}',
    };
    renderWhiteboard(host, sources);
    const frame = host.querySelector("iframe");
    expect(frame?.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame?.getAttribute("sandbox")).not.toContain("allow-same-origin");
    const srcdoc = frame?.srcdoc ?? "";
    expect(srcdoc).toContain(sources.html);
    expect(srcdoc).toContain(sources.css);
    expect(srcdoc).toContain("const tag = '<\\/script>';");
    expect(srcdoc).toContain('id="lesson-svg"');
    expect(srcdoc).toContain(sources.svg);
    expect(srcdoc).toContain("globalThis.lessonData");
    expect(srcdoc).toContain("\\u003c");
    expect(srcdoc).not.toContain("<b>one</b>");
    expect(host.querySelector("h1")).toBeNull();
    expect(host.querySelector("svg")).toBeNull();
    expect(host.querySelector("script")).toBeNull();
  });

  it("omits the svg slot when that source is empty and shows the placeholder for a blank board", () => {
    const doc = assembleBoardDocument({ ...emptyBoard(), html: "<p>Only html</p>" });
    expect(doc).not.toContain("lesson-svg");
    expect(doc).toContain("globalThis.lessonData = null;");

    const host = document.createElement("div");
    renderWhiteboard(host, emptyBoard());
    expect(host.querySelector("iframe")).toBeNull();
    expect(host.textContent).toContain("The lesson will appear here.");
  });

  it("reads the title and visible text without keeping script text", () => {
    expect(titleFromHtml("<h1>Photosynthesis</h1><p>Leaves</p>")).toBe("Photosynthesis");
    const shot = snapshotBoard({
      ...emptyBoard(),
      html: "<script>secret()</script><p>Visible</p>",
      svg: "<svg><text>Label</text></svg>",
    });
    expect(shot.text).toContain("Visible");
    expect(shot.text).toContain("Label");
    expect(shot.text).not.toContain("secret");
  });
});
