// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import type { SelectionAnchor } from "../types.ts";
import {
  assembleBoardDocument,
  boardDraft,
  emptyBoard,
  insertNote,
  markSource,
  readAnchor,
  renderWhiteboard,
  SELECTION_BRIDGE,
  SELECTION_END,
  SELECTION_START,
  snapshotBoard,
  START_HEADING,
  syncStartForm,
  titleFromHtml,
} from "./whiteboard.ts";

function anchor(selector: string, overrides: Partial<SelectionAnchor> = {}): SelectionAnchor {
  return {
    kind: "element",
    component: "html",
    selector,
    tag: "p",
    quote: { exact: "x", prefix: "", suffix: "" },
    outerHTML: "<p>x</p>",
    rect: { x: 0, y: 0, width: 0, height: 0 },
    ...overrides,
  };
}

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
    expect(frame?.getAttribute("sandbox")).toBe("allow-scripts allow-popups allow-popups-to-escape-sandbox");
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

  it("omits the svg slot when that source is empty and runs the selection bridge before the lesson script", () => {
    const doc = assembleBoardDocument({ ...emptyBoard(), html: "<p>Only html</p>", js: "lessonScript();" });
    expect(doc).not.toContain('id="lesson-svg"');
    expect(doc).toContain("globalThis.lessonData = null;");
    expect(doc.indexOf(SELECTION_BRIDGE)).toBeGreaterThan(0);
    expect(doc.indexOf(SELECTION_BRIDGE)).toBeLessThan(doc.indexOf("lessonScript();"));
    expect(SELECTION_BRIDGE).not.toMatch(/<\/script/i);
  });

  it("asks for the first question on a blank board", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const started: string[] = [];
    renderWhiteboard(host, emptyBoard(), { onStart: (question) => started.push(question) });
    expect(host.querySelector("iframe")).toBeNull();
    expect(host.querySelector("h2")?.textContent).toBe(START_HEADING);
    const field = host.querySelector("textarea")!;
    syncStartForm(host, { enabled: false, busy: false });
    expect(field.disabled).toBe(true);
    syncStartForm(host, { enabled: true, busy: false });
    field.value = "  Teach me tides ";
    expect(boardDraft(host)).toBe("  Teach me tides ");
    host.querySelector("form")!.requestSubmit();
    expect(started).toEqual(["Teach me tides"]);
    syncStartForm(host, { enabled: true, busy: true });
    expect(host.textContent).toContain("Writing the lesson…");
    host.remove();
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

describe("selection anchors", () => {
  const sources = {
    ...emptyBoard(),
    html: "<h1>Leaves</h1><p>Leaves hold <em>chlorophyll</em>.</p><ul><li>One</li></ul><p>Roots.</p>",
    svg: '<svg width="10" height="10"><circle></circle><text>Sun</text></svg>',
  };

  it("marks the selected element in the html or the svg source", () => {
    const html = markSource(sources, anchor("body > p:nth-of-type(1) > em:nth-of-type(1)"));
    expect(html.marked).toBe(true);
    expect(html.component).toBe("html");
    expect(html.text).toContain(`Leaves hold ${SELECTION_START}<em>chlorophyll</em>${SELECTION_END}.`);
    expect(html.text).not.toContain("<circle>");

    const svg = markSource(sources, anchor("#lesson-svg > svg:nth-of-type(1) > text:nth-of-type(1)", { component: "svg" }));
    expect(svg.component).toBe("svg");
    expect(svg.text).toContain(`${SELECTION_START}<text>Sun</text>${SELECTION_END}`);
  });

  it("returns the source unmarked when the selector is missing or invalid", () => {
    expect(markSource(sources, anchor("#nope"))).toEqual({ component: "html", text: sources.html, marked: false });
    expect(markSource(sources, anchor("p:::")).marked).toBe(false);
    expect(markSource(sources, anchor("body")).marked).toBe(false);
  });

  it("places a note after the block that holds the selection", () => {
    const after = insertNote(sources, anchor("body > p:nth-of-type(1) > em:nth-of-type(1)"), { question: "Why <green>?", reply: "A pigment." });
    expect(after.indexOf("learner-note")).toBeGreaterThan(after.indexOf("chlorophyll"));
    expect(after.indexOf("learner-note")).toBeLessThan(after.indexOf("<ul>"));
    expect(after).toContain("Why &lt;green&gt;?");
    expect(after).not.toContain("lesson-svg");

    const inList = insertNote(sources, anchor("body > ul:nth-of-type(1) > li:nth-of-type(1)"), { question: "Q", reply: "R" });
    expect(inList).toContain('<li>One<aside class="learner-note"');

    const underSvg = insertNote(sources, anchor("#lesson-svg > svg:nth-of-type(1) > circle:nth-of-type(1)"), { question: "Q", reply: "R" });
    expect(underSvg.startsWith('<aside class="learner-note"')).toBe(true);

    const atEnd = insertNote(sources, null, { question: "Q", reply: "R" });
    expect(atEnd.indexOf("learner-note")).toBeGreaterThan(atEnd.indexOf("Roots."));
  });

  it("accepts only a well-formed anchor from the frame", () => {
    const good = anchor("body > p:nth-of-type(1)");
    expect(readAnchor(good)).toEqual(good);
    expect(readAnchor({ ...good, kind: "other" })).toBeNull();
    expect(readAnchor({ ...good, quote: null })).toBeNull();
    expect(readAnchor("text")).toBeNull();
    expect(readAnchor({ ...good, selector: "x".repeat(2000) })?.selector).toHaveLength(600);
  });
});
