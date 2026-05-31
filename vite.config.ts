import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { crx } from "@crxjs/vite-plugin";
import manifest from "./public/manifest.json" with { type: "json" };
import path from "node:path";
import { cpSync, existsSync } from "node:fs";

/**
 * Copy pdfjs-dist asset directories (cmaps, standard_fonts, wasm) into the
 * extension output so PDFViewer can find them at runtime via
 * chrome.runtime.getURL(). These are the asset dirs `getDocument({ cMapUrl,
 * standardFontDataUrl, wasmUrl })` expects. We copy from node_modules at
 * build time rather than committing 4MB of binary blobs to the repo and to
 * stay in sync with the installed pdfjs-dist version.
 *
 * Runs on closeBundle so the source files in node_modules are recursively
 * copied into the final `dist/` extension output after Vite/Rollup have
 * finished emitting the JS/CSS bundles. The assets are not in
 * web_accessible_resources — only the pdf-viewer extension page (and its
 * pdf.js worker) fetches them, and extension pages have same-origin
 * access to extension resources without WAR.
 */
function copyPdfjsAssets(): Plugin {
  const sources = ["cmaps", "standard_fonts", "wasm"] as const;
  return {
    name: "thilko:copy-pdfjs-assets",
    closeBundle() {
      const root = path.resolve(__dirname, "node_modules/pdfjs-dist");
      const outDir = path.resolve(__dirname, "dist");
      for (const dir of sources) {
        const from = path.join(root, dir);
        if (!existsSync(from)) {
          this.warn(`pdfjs-dist/${dir} not found at ${from}`);
          continue;
        }
        cpSync(from, path.join(outDir, dir), { recursive: true });
      }
    },
  };
}

export default defineConfig({
  plugins: [
    react(),
    crx({ manifest: manifest as never }),
    copyPdfjsAssets(),
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
