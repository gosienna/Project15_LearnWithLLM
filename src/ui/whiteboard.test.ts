// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import type { SelectionAnchor } from "../types.ts";
import { inlineKatexFonts, KATEX_MODULE } from "./board-modules.ts";
import {
  assembleBoardDocument,
  boardDraft,
  EDIT_SURROUND_NOTE,
  editSlice,
  emptyBoard,
  insertNote,
  markSource,
  readAnchor,
  readAnchors,
  renderWhiteboard,
  resolveBoardImages,
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

  it("swaps board-image ids for the saved images in html, css and svg, and exposes lessonImages", () => {
    const images = { img1: "data:image/webp;base64,AAAA", img2: "https://img.example/b.jpg" };
    const doc = assembleBoardDocument(
      {
        ...emptyBoard(),
        html: '<img src="board-image:img1" alt="a"><img src="board-image:img9">',
        css: ".hero { background: url(board-image:img2); }",
        svg: '<svg><image href="board-image:img1"/></svg>',
      },
      images,
    );
    expect(doc).toContain('<img src="data:image/webp;base64,AAAA" alt="a">');
    expect(doc).toContain('<img src="board-image:img9">');
    expect(doc).toContain("url(https://img.example/b.jpg)");
    expect(doc).toContain('<image href="data:image/webp;base64,AAAA"/>');
    expect(doc).toContain(`globalThis.lessonImages = ${JSON.stringify(images)};`);
    expect(resolveBoardImages("board-image:img1 board-image:toString", images)).toBe("data:image/webp;base64,AAAA board-image:toString");
  });

  it("redraws when an image's source changes", () => {
    const host = document.createElement("div");
    const sources = { ...emptyBoard(), html: '<img src="board-image:img1">' };
    renderWhiteboard(host, sources, undefined, { img1: "https://img.example/a.jpg" });
    const first = host.querySelector("iframe");
    renderWhiteboard(host, sources, undefined, { img1: "https://img.example/a.jpg" });
    expect(host.querySelector("iframe")).toBe(first);
    renderWhiteboard(host, sources, undefined, { img1: "data:image/webp;base64,AAAA" });
    expect(host.querySelector("iframe")).not.toBe(first);
    expect(host.querySelector("iframe")?.srcdoc).toContain("data:image/webp;base64,AAAA");
  });

  it("omits the svg slot when that source is empty and runs the selection bridge before the lesson script", () => {
    const doc = assembleBoardDocument({ ...emptyBoard(), html: "<p>Only html</p>", js: "lessonScript();" });
    expect(doc).not.toContain('id="lesson-svg"');
    expect(doc).toContain("globalThis.lessonData = null;");
    expect(doc.indexOf(SELECTION_BRIDGE)).toBeGreaterThan(0);
    expect(doc.indexOf(SELECTION_BRIDGE)).toBeLessThan(doc.indexOf("lessonScript();"));
    expect(SELECTION_BRIDGE).not.toMatch(/<\/script/i);
  });

  it("prefills KaTeX before the selection bridge and renders math after the lesson script", () => {
    const doc = assembleBoardDocument({ ...emptyBoard(), html: String.raw`<p>\(x^2\)</p>`, css: "p { color: red; }", js: "lessonScript();" });
    expect(doc).toContain("font-src data:");
    expect(doc.indexOf(KATEX_MODULE.style)).toBeGreaterThan(0);
    expect(doc.indexOf(KATEX_MODULE.style)).toBeLessThan(doc.indexOf("p { color: red; }"));
    expect(doc.indexOf(KATEX_MODULE.boot)).toBeGreaterThan(doc.indexOf(KATEX_MODULE.script));
    expect(doc.indexOf(KATEX_MODULE.boot)).toBeLessThan(doc.indexOf(SELECTION_BRIDGE));
    expect(doc.lastIndexOf("renderMath();")).toBeGreaterThan(doc.indexOf("lessonScript();"));
    for (const part of [KATEX_MODULE.script, KATEX_MODULE.boot, KATEX_MODULE.style]) expect(part).not.toMatch(/<\/(script|style)/i);
  });

  it("inlines every KaTeX font as one woff2 data URI", () => {
    expect(KATEX_MODULE.style).not.toContain("url(fonts/");
    expect(KATEX_MODULE.style).toContain("data:font/woff2;base64,");
    const css = '@font-face{src:url(fonts/A-B.woff2) format("woff2"),url(fonts/A-B.woff) format("woff")}';
    expect(inlineKatexFonts(css, { "/x/fonts/A-B.woff2": "data:x" })).toBe('@font-face{src:url(data:x) format("woff2")}');
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
    expect(readAnchors([good, { ...good, kind: "nope" }])).toEqual([good]);
    expect(readAnchors(good)).toEqual([good]);
  });
});

describe("edit slices", () => {
  it("uses the selected words when they occur once", () => {
    const sources = { ...emptyBoard(), html: "<p>Leaves hold chlorophyll.</p>" };
    expect(editSlice(sources, anchor("body > p:nth-of-type(1)", {
      kind: "text",
      quote: { exact: "chlorophyll", prefix: "Leaves hold ", suffix: "." },
    }))).toEqual({ component: "html", find: "chlorophyll" });
  });

  it("widens a repeated word until the slice is unique", () => {
    const sources = { ...emptyBoard(), html: "<p>red apple</p><p>green apple</p>" };
    const slice = editSlice(sources, anchor("body > p:nth-of-type(1)", {
      kind: "text",
      tag: "p",
      quote: { exact: "apple", prefix: "red ", suffix: "" },
    }));
    expect(slice.find).toContain("apple");
    expect(slice.find).not.toContain("green");
    expect(sources.html.indexOf(slice.find)).toBe(sources.html.lastIndexOf(slice.find));
    expect(slice.note).toBe(EDIT_SURROUND_NOTE);
  });

  it("recovers an image tag and an svg shape from the stored source", () => {
    const sources = {
      ...emptyBoard(),
      html: '<p>Hi</p><img src="board-image:img1" alt="leaf">',
      svg: '<svg width="10" height="10"><rect width="4" height="4"></rect></svg>',
    };
    const image = editSlice(sources, anchor("body > img:nth-of-type(1)", {
      kind: "element",
      tag: "img",
      quote: { exact: "", prefix: "", suffix: "" },
    }));
    expect(image.error).toBeUndefined();
    expect(image.find).toContain("board-image:img1");
    expect(sources.html.split(image.find)).toHaveLength(2);

    const shape = editSlice(sources, anchor("#lesson-svg > svg:nth-of-type(1) > rect:nth-of-type(1)", {
      kind: "element",
      component: "svg",
      tag: "rect",
      quote: { exact: "", prefix: "", suffix: "" },
    }));
    expect(shape.component).toBe("svg");
    expect(shape.find).toContain("<rect");
    expect(sources.svg.split(shape.find)).toHaveLength(2);
  });

  it("refuses a selection the stored source does not contain", () => {
    const sources = { ...emptyBoard(), html: "<p>hold <em>chlorophyll</em></p><div id='app'></div>" };
    const split = editSlice(sources, anchor("body > p:nth-of-type(1)", {
      kind: "text",
      quote: { exact: "hold chlorophyll", prefix: "", suffix: "" },
    }));
    expect(split.error).toContain("Tags sit in the middle");
    const built = editSlice(sources, anchor("#app > button:nth-of-type(1)", {
      kind: "text",
      quote: { exact: "missing", prefix: "", suffix: "" },
    }));
    expect(built.error).toContain("lesson script");
  });
});

describe("selection gestures", () => {
  const messages: { type?: string; anchors?: { tag?: string; kind?: string; component?: string }[] }[] = [];

  function place(el: Element, x: number, y: number, w: number, h: number): void {
    Object.defineProperty(el, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ x, y, left: x, top: y, right: x + w, bottom: y + h, width: w, height: h, toJSON() { return {}; } }),
    });
  }

  function pointer(type: string, target: Element, x: number, y: number): void {
    target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, button: 0 }));
  }

  async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  function highlighted(): string[] {
    return [...document.querySelectorAll("[data-ask-highlight]")].map((el) => el.id);
  }

  it("clicks a picture or shape, drags a box, and keeps text drags as text", async () => {
    window.addEventListener("message", (event) => {
      const data = event.data as { source?: string; type?: string; anchors?: { tag?: string; kind?: string; component?: string }[] };
      if (data?.source === "learn-with-llm") messages.push(data);
    });
    window.eval(SELECTION_BRIDGE);
    document.body.innerHTML = `<button id="go">Go</button><section id="wrap"><img id="pic" alt="leaf"><p id="words">Hello chlorophyll</p></section><div id="lesson-svg"><svg id="drawing"><rect id="shape" width="10" height="10"></rect></svg></div>`;
    const pic = document.querySelector("#pic")!;
    const words = document.querySelector("#words")!;
    const wrap = document.querySelector("#wrap")!;
    const shape = document.querySelector("#shape")!;
    const drawing = document.querySelector("#drawing")!;
    const go = document.querySelector("#go")!;
    place(wrap, 0, 0, 200, 200);
    place(pic, 10, 10, 40, 40);
    place(words, 10, 60, 100, 20);
    place(drawing, 10, 120, 80, 40);
    place(shape, 20, 130, 20, 20);
    place(go, 300, 10, 40, 20);

    pointer("pointerdown", pic, 20, 20);
    pointer("pointerup", pic, 20, 20);
    pic.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: 20, clientY: 20 }));
    pic.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 20, clientY: 20 }));
    await settle();
    expect(messages.at(-1)?.anchors?.map((item) => item.tag)).toEqual(["img"]);
    expect(highlighted()).toEqual(["pic"]);

    pointer("pointerdown", shape, 25, 135);
    pointer("pointerup", shape, 25, 135);
    shape.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    shape.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await settle();
    expect(messages.at(-1)?.anchors?.[0]).toMatchObject({ tag: "rect", component: "svg", kind: "element" });
    expect(highlighted()).toEqual(["shape"]);

    const before = messages.length;
    pointer("pointerdown", go, 310, 15);
    pointer("pointerup", go, 310, 15);
    go.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    go.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await settle();
    expect(messages.slice(before).some((message) => message.anchors?.some((item) => item.tag === "button"))).toBe(false);
    expect(go.hasAttribute("data-ask-highlight")).toBe(false);

    messages.length = 0;
    pointer("pointerdown", pic, 12, 12);
    pointer("pointermove", pic, 110, 80);
    pointer("pointerup", pic, 110, 80);
    pic.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    pic.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await settle();
    expect(document.querySelector("[data-ask-marquee]")).toBeNull();
    expect(messages.at(-1)?.anchors?.map((item) => item.tag)).toEqual(["img", "p"]);
    expect(highlighted().sort()).toEqual(["pic", "words"]);
    expect(wrap.hasAttribute("data-ask-highlight")).toBe(false);

    messages.length = 0;
    pointer("pointerdown", words, 20, 70);
    pointer("pointermove", words, 180, 200);
    pointer("pointerup", words, 180, 200);
    expect(document.querySelector("[data-ask-marquee]")).toBeNull();
    const range = document.createRange();
    range.selectNodeContents(words);
    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    words.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    await settle();
    expect(messages.at(-1)?.anchors?.[0]?.kind).toBe("text");
    expect(highlighted()).toEqual(["words"]);
  });
});
