import katexScript from "katex/dist/katex.min.js?raw";
import autoRenderScript from "katex/dist/contrib/auto-render.min.js?raw";
import katexStyle from "katex/dist/katex.min.css?raw";
import katexPackage from "katex/package.json";

/**
 * A library every board document loads before the lesson, so the model uses it instead of adding
 * one. The frame's CSP blocks network scripts and fonts, so everything here is inline.
 */
export interface BoardModule {
  id: string;
  name: string;
  version: string;
  /** What the system prompt tells the model about it. */
  usage: string;
  style: string;
  script: string;
  /** Runs after the library and defines what the lesson calls. */
  boot: string;
  /** Runs after the lesson script. */
  after: string;
}

const KATEX_FONTS = import.meta.glob<string>("/node_modules/katex/dist/fonts/*.woff2", {
  query: "?inline",
  import: "default",
  eager: true,
});

/** The KaTeX css with each font as a woff2 data URI; the woff and ttf fallbacks are dropped. */
export function inlineKatexFonts(css: string, fonts: Record<string, string>): string {
  const byName = new Map(Object.entries(fonts).map(([path, uri]) => [path.slice(path.lastIndexOf("/") + 1), uri]));
  return css.replace(/src:url\(fonts\/([\w-]+)\.woff2\)[^;}]*/g, (rule, name: string) => {
    const uri = byName.get(`${name}.woff2`);
    return uri ? `src:url(${uri}) format("woff2")` : rule;
  });
}

/** Single $…$ is left out so prices in prose stay text. */
const KATEX_BOOT = String.raw`(() => {
  const delimiters = [
    { left: "$$", right: "$$", display: true },
    { left: "\\[", right: "\\]", display: true },
    { left: "\\(", right: "\\)", display: false },
  ];
  const ignoredTags = ["script", "noscript", "style", "textarea", "pre", "code", "option"];
  globalThis.renderMath = (el = document.body) => {
    if (!el || !globalThis.katex || !globalThis.renderMathInElement) return;
    const tagged = [...el.querySelectorAll("[data-latex], [data-latex-display]")];
    if (el.matches?.("[data-latex], [data-latex-display]")) tagged.unshift(el);
    for (const node of tagged) {
      const display = node.hasAttribute("data-latex-display");
      const tex = node.getAttribute(display ? "data-latex-display" : "data-latex") || "";
      katex.render(tex, node, { displayMode: display, throwOnError: false });
    }
    renderMathInElement(el, { delimiters, ignoredTags, throwOnError: false });
  };
})();`;

export const KATEX_MODULE: BoardModule = {
  id: "katex",
  name: "KaTeX",
  version: katexPackage.version,
  usage: String.raw`Math: the page already loads KaTeX. Write LaTeX in html as \( … \) inline, or \[ … \] or $$ … $$ for a display equation; it renders by itself. Never add a script, link, or library for math. If the js adds math later, call renderMath(element).`,
  style: inlineKatexFonts(katexStyle, KATEX_FONTS),
  script: `${katexScript}\n${autoRenderScript}`,
  boot: KATEX_BOOT,
  after: "renderMath();",
};

export const BOARD_MODULES: readonly BoardModule[] = [KATEX_MODULE];
