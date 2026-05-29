<div align="center">
  <img src="public/mascot/mascot-idle.png" width="128" alt="Dabbis, the Thilko reading assistant" />

# Thilko

**Read anything on the web with an AI reading companion that remembers.**

</div>

Thilko is a Chrome extension that lets you highlight text on any web page or PDF, attach private comments, and have a streaming AI conversation about the passage with **Dabbis** — a small scholarly assistant that lives next to your toolbar. Your highlights, notes, and AI chats are stored in a personal memory backend (Supermemory) so you can come back to them, search them, and bundle them up to share with another LLM in one click.

It's built for the way people actually read: select a sentence that struck you, ask a question, move on. The window stays out of the way of the text.

---

## Features

- **Annotate any page or PDF.** Highlights survive page reloads and reasonable article edits (W3C TextQuoteSelector + position fallbacks).
- **Talk to Dabbis about what you're reading.** Streaming responses, full markdown, threads attached to each highlight.
- **Lazy persistence.** A highlight is just a local marker until you add a note or ask a question — your memory stays clean of empty markers. Togglable in options.
- **Side library.** A full-tab `library.html` lists every highlight you've ever made, with semantic search across notes and threads.
- **"Open with Claude."** Bundle a highlight, an article, or a whole topic into a markdown summary and paste it into [claude.com](https://claude.com) with one click.
- **PDF support.** Click a `.pdf` link, the extension renders it in its own viewer with the same selection toolbar.
- **Light, frosted UI.** Polished popover, mascot in the conversation gutter, brand-purple accent for the things that matter.

---

## Architecture (one diagram)

```
┌──────────────────────────────────────────────┐
│ Chrome MV3 extension (this repo)             │
│  • content script: selection toolbar +       │
│    highlight render + popover + sidebar      │
│  • PDF viewer page (pdfjs-dist)              │
│  • library page (full tab)                   │
│  • options page                              │
│  • background service worker (RPC,           │
│    health-check, op-log, chat streaming)     │
└──────────────────┬───────────────────────────┘
                   │  HTTPS Bearer + X-Token-Slot
                   ▼
┌──────────────────────────────────────────────┐
│ Codex+Memory proxy (NOT in this repo)        │
│  POST /responses    → chatgpt.com/codex      │
│  POST /memory/chat  → streaming SSE          │
│  POST /memory/*     → Supermemory CRUD       │
│  Holds: PROXY_SECRET, Codex OAuth tokens,    │
│         SUPERMEMORY_API_KEY                  │
└────────┬──────────────────────┬──────────────┘
         ▼                      ▼
   chatgpt.com/codex      api.supermemory.ai
```

The extension never holds an API key — it talks only to **your proxy**, which holds the secrets and forwards to OpenAI's Codex API + Supermemory. The proxy lives in a separate repo (see *Backend* below). Multi-user is supported by the `X-Token-Slot` header — each user gets a personal "slot" namespace for their data.

---

## Install

### Path A — Chrome Web Store (recommended)

> Coming once the unlisted listing is approved. Link will be added here.

### Path B — Load unpacked from a release `.zip`

1. Grab the latest `.zip` from [Releases](../../releases).
2. Unzip it somewhere.
3. Open `chrome://extensions`, toggle **Developer mode** (top-right), click **Load unpacked**, point at the unzipped folder.
4. The first-run options page opens automatically. See *Configure* below.

### Path C — Build from source

```bash
git clone <this-repo>.git
cd thilko
npm install
npm run build           # produces dist/
```

Then load `dist/` as an unpacked extension in `chrome://extensions`.

---

## Configure

Thilko needs three things to work:

1. **Proxy URL** — the base URL of a Codex+Memory proxy (see *Backend* below). Example: `https://proxy.example.com:3200`.
2. **Proxy secret** — the `PROXY_SECRET` the proxy was started with. The extension sends this as a Bearer token.
3. **Slot** — your personal namespace tag. 1–32 characters, letters/digits/`-`/`_`. Each slot's data is isolated from every other slot's.

Open the options page (auto-opens on install, or right-click the extension icon → **Options**), paste your three values, click **Test connection**. You should see a green dot. Save.

The toolbar icon's corner dot shows live connection state — green when good, red when down, amber `!` when unconfigured.

---

## Backend

The extension never holds an API key. Instead it talks to a **proxy server you configure** that holds your OpenAI Codex OAuth token and your Supermemory API key, and forwards inference + storage requests on your behalf.

There are two ways to get a proxy:

- **Use someone else's.** If somebody you trust is running a Thilko-compatible proxy, ask them for an install link. Paste it into Options and the extension configures itself. Your data is scoped to your own slot.
- **Run your own.** The proxy is a separate concern from the extension. The **wire contract** is documented in [`docs/proxy-contract.md`](./docs/proxy-contract.md); a public open-source proxy implementation is planned for v0.2. In the meantime, anyone can build a compatible proxy in any language against the contract (reference implementation is ~400 lines of TypeScript).

Why this separation: the proxy concerns (Codex OAuth, Supermemory schema, rate-limiting, eventually-consistent caching) are independent from the browser extension and have a different deploy story. Keeping them in separate repos prevents either from constraining the other.

---

## Privacy

See [PRIVACY.md](./PRIVACY.md). One-line summary: the extension sends the text you highlight, the comments you write, and your AI conversations to a proxy you configure, which sends them to OpenAI's Codex API and to Supermemory. Nothing else.

---

## Development

```bash
npm install
npm run typecheck       # TypeScript strict
npm test                # vitest
npm run build           # production bundle to dist/
```

For watch mode during development:

```bash
npm run build -- --watch
```

The build uses [`@crxjs/vite-plugin`](https://github.com/crxjs/chrome-extension-tools) to assemble the MV3 manifest + content scripts + background worker + asset pipeline.

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the dev loop and code conventions.

---

## Roadmap

- [x] HTML + PDF highlighting and re-anchoring
- [x] Per-highlight popover with comments and streaming AI threads
- [x] Side library with semantic search
- [x] "Open with Claude" handoff
- [x] Lazy persistence (highlights only saved with content)
- [x] Local telemetry ring buffer
- [x] Reset-all-data
- [ ] **v0.2 — Open-source the reference proxy** (extracted into its own repo)
- [ ] Hosted backend so users don't need to deploy a proxy
- [ ] Multi-user sign-in (OAuth)
- [ ] Cross-device sync of UI preferences
- [ ] Other browsers (Firefox via MV3, Safari)

---

## License

MIT. See [LICENSE](./LICENSE).

---

<div align="center">

Built by a small group of people who wanted a better way to read on the web.

</div>
