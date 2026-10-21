import { defineConfig } from "vitest/config";

// GitHub Pages publishes this repository under /Project15_LearnWithLLM/.
// A relative base makes the built script and style URLs resolve from that
// directory. The dev server still serves the TypeScript entry at /.
export default defineConfig({
  base: "./",
  build: {
    rollupOptions: {
      input: "index.template.html",
      output: {
        entryFileNames: "assets/app.js",
        chunkFileNames: "assets/[name].js",
        assetFileNames: "assets/[name][extname]",
      },
    },
  },
  plugins: [
    {
      name: "dev-entry",
      apply: "serve",
      transformIndexHtml: {
        order: "pre",
        handler(html) {
          return html
            .replace(/<link rel="stylesheet"[^>]*>\s*/g, "")
            .replace(
              /<script type="module"[^>]*><\/script>/,
              '<script type="module" src="/src/main.ts"></script>',
            );
        },
      },
    },
  ],
  server: {
    host: "0.0.0.0",
    port: 5173,
  },
  test: {
    environment: "node",
  },
});
