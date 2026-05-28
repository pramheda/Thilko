/**
 * Stub for the `optimal-select` package, which @apache-annotator/dom pulls in
 * transitively only for its CSS-selector module (which we don't use — we only
 * use the TextQuote selector + matcher + highlightText).
 *
 * The real package has a broken `module` field pointing at `src/index.js`
 * which doesn't exist in published builds, so Vite can't resolve it. A vite
 * alias redirects `optimal-select` imports to this stub. None of the exported
 * functions are ever called in our code path.
 */

const notUsed = (name: string) => (): never => {
  throw new Error(`optimal-select.${name} is stubbed and should not be invoked from Thilko`);
};

export const select = notUsed("select");
export const optimize = notUsed("optimize");
export const match = notUsed("match");
export const adapt = notUsed("adapt");
export const common = notUsed("common");
export default {
  select,
  optimize,
  match,
  adapt,
  common,
};
