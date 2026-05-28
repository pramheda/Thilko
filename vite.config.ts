import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { crx } from "@crxjs/vite-plugin";
import manifest from "./public/manifest.json" with { type: "json" };
import path from "node:path";

export default defineConfig({
  plugins: [
    react(),
    crx({ manifest: manifest as never }),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // @apache-annotator/dom transitively imports `optimal-select` from its
      // `css` module (CSS selector creation, which we don't use). The package
      // ships a broken `module` field. Redirect to a stub so Vite can resolve.
      "optimal-select": path.resolve(__dirname, "./src/vendor/optimal-select-stub.ts"),
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      // CRX plugin handles entries discoverable from the manifest. The
      // library page is opened at runtime via chrome.runtime.getURL — Rollup
      // can't trace that string, so we add it as an explicit input.
      input: {
        library: "src/library/library.html",
        "pdf-viewer": "src/pdf-viewer/viewer.html",
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    hmr: {
      port: 5174,
    },
  },
});
