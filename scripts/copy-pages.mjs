import { copyFileSync, cpSync, readFileSync, rmSync } from "node:fs";

const builtHtmlPath = "dist/index.template.html";
const html = readFileSync(builtHtmlPath, "utf8");
if (html.includes("main.ts")) {
  throw new Error("Built page still references main.ts");
}
if (!html.includes('src="./assets/app.js"')) {
  throw new Error("Built page is missing ./assets/app.js");
}
if (!html.includes('href="./assets/index.css"')) {
  throw new Error("Built page is missing ./assets/index.css");
}
copyFileSync(builtHtmlPath, "dist/index.html");
copyFileSync(builtHtmlPath, "index.html");
rmSync("assets", { recursive: true, force: true });
cpSync("dist/assets", "assets", { recursive: true });
console.log("Published index.html and assets/ for GitHub Pages.");
