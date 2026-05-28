# Contributing

## Dev loop

```bash
git clone <fork>
cd thilko
npm install
npm run typecheck    # TS strict
npm test             # vitest
npm run build        # dist/ for Chrome
```

Load `dist/` as an unpacked extension in `chrome://extensions` while iterating.

## Where things live

```
src/
  background/        Service worker: RPC dispatcher, health check, chat stream
  content/           Content script: selection toolbar, popover, sidebar, anchor
    popover/         The popover surface — header, transcript, composer, mascot
    selection-toolbar/
    sidebar/
    anchor/          W3C TextQuoteSelector adapter + render of <mark> nodes
    ui/              Shared shadow-DOM styles + Mascot component + positioning
  library/           Full-tab library page (search, topics, detail)
  options/           First-run setup + ongoing config
  pdf-viewer/        Custom PDF viewer (pdfjs-dist) — same lifecycle as HTML
  shared/            Types, settings, messages, URL canonicalisation,
                     memory-summary builder, chat-stream protocol
```

The architecture overview lives in the README's "Architecture" diagram.

## Code conventions

- **TypeScript strict.** No `any`, no implicit returns. Prefer narrow utility types over inline shapes for anything used across files.
- **Comments only when *why* is non-obvious.** Don't restate the code; name a hidden constraint, a workaround, an invariant.
- **No dead-code-eliminated stubs.** If a function is only there for forward-compat with a future milestone, delete it until that milestone lands.
- **Shadow DOM for every UI surface on the host page.** Every floating widget (toolbar, popover, sidebar) mounts inside its own shadow root via `src/content/ui/shadow-mount.ts`. Never `document.body.appendChild` a styled element directly — host pages will fight your CSS.
- **No persistent UI state outside chrome.storage.** Service workers can be evicted at any moment; in-memory state in the SW is fair game to lose. Anything that needs to survive is in `chrome.storage`.

## Tests

Tests live in `tests/unit/` and run under [vitest](https://vitest.dev). Pure-function modules (URL canonicalisation, memory-summary builder) are unit-tested with goldens. UI components are not unit-tested — they're verified by loading the extension and walking the flows manually.

## Submitting changes

1. Open a draft PR early — the diff is the conversation.
2. Each feature should keep typecheck + tests + build green.
3. For UI changes, screenshot the before/after in the PR description.
4. For protocol changes (anything in `src/shared/messages.ts` or the proxy contract), call it out explicitly so reviewers can pull the proxy repo and check the matching side.

## License

MIT. By contributing you agree your contributions are licensed under MIT.
