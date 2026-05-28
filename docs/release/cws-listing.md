# Chrome Web Store — listing material

Submit at: <https://chrome.google.com/webstore/devconsole>

One-time: pay the $5 developer registration fee. Set the extension visibility to **Unlisted** (only people with the install link can install — your small circle).

---

## Item details

### Name
```
Thilko
```

### Short description (132 char max)
```
Highlight any web article, ask Dabbis about it, remember every note. A reading companion for the people who actually read.
```
(Currently 121 chars.)

### Detailed description
```
Thilko is a reading companion for the web.

Highlight any sentence on any article or PDF. Ask Dabbis — your small scholarly AI assistant — to explain it, push back on it, or sit with it. Save notes that survive page reloads. Every highlight, comment, and conversation is stored in a personal memory backend so you can come back to them, search them, and bundle them up to share with another LLM in one click.

Built for the way people actually read: select a sentence that struck you, ask a question, move on. The window stays out of the way of the text.

What you get:
• A floating selection toolbar that appears when you highlight text. Click Comment to save a note, click Ask Dabbis-AI to start a conversation.
• Highlights that survive page reloads, with smart re-anchoring for articles that get edited.
• A draggable, frosted-glass popover that anchors to the right edge of the viewport — out of the way of the text you're reading.
• Streaming AI replies with full markdown, including code blocks.
• PDF support: any *.pdf link opens in Thilko's viewer, with the same toolbar and the same memory.
• A side library with semantic search across every highlight, note, and AI conversation you've ever made.
• "Open with Claude": bundle a highlight, an article, or a whole topic into a markdown summary and paste it into claude.com with one click.
• Lazy-by-default persistence: highlights only get saved when you actually attach a note or a question. Your memory stays clean.
• Local-first telemetry: a 100-entry ring buffer of recent operations, viewable in Options. No remote logging.

How it works:
Thilko talks to a proxy server you configure (either run your own, or use one a friend hosts). The proxy holds your secrets and forwards inference requests to OpenAI's Codex API and storage requests to Supermemory. The extension never holds an API key. Your data is scoped to a "slot" namespace you choose.

This is a personal-v1 release. The code is open source under MIT — see the GitHub repo linked in the support URL.
```

### Category
```
Productivity
```

### Language
```
English (United States)
```

---

## Privacy

### Single purpose
```
Thilko helps users annotate web articles and PDFs with private highlights, notes, and AI conversations.
```

### Permission justifications

(Map of each manifest permission to a one-paragraph justification.)

**`storage`** — Stores the user's configuration (proxy URL, secret, slot, exclusion list) in `chrome.storage.sync` so settings persist and sync across the user's Chrome installs. Stores a session-scoped connection status and a 100-entry local op-log for in-app debugging.

**`alarms`** — Schedules a periodic connection health check (~once a minute) so the toolbar icon's status dot reflects whether the user's proxy is reachable.

**`tabs`** — Opens the library page and the Claude-import page in new tabs when the user clicks the extension action or the "Open with Claude" affordance. Used to focus an existing library tab if one is already open.

**`declarativeNetRequest`** — Redirects top-level navigations to `*.pdf` URLs into the extension's bundled PDF viewer so highlights work on PDFs the same way they do on HTML pages. A single dynamic rule scoped to `main_frame` resource type; no other URL classes are affected.

**`host_permissions: <all_urls>`** — The content script that powers selection highlighting needs to run on user-chosen articles. The extension activates only on user-supplied selections and on a configurable exclusion list of sites where it does not run by default (e.g., banking, mail, chat services).

### Data usage declaration

(Tick what applies.)

- [x] **Personally identifiable information** — None collected directly. The user-configured "slot" is a namespace string the user chooses (typically a username), stored only in the user's proxy.
- [x] **Authentication information** — The user enters a "Proxy secret" (a shared password for their proxy). Stored in `chrome.storage.sync`, sent only to the proxy URL the user configured. Not collected by the extension publisher.
- [x] **Personal communications** — The user's highlights, notes, and AI conversations are sent to the proxy the user configures. The proxy publisher may or may not be the same as the extension publisher.
- [ ] Financial / payment info — None.
- [ ] Health info — None.
- [ ] Location — None.
- [ ] Web history — None. The extension does NOT track which pages the user visits; it only acts on user-supplied selections.
- [ ] User activity / web content — Only what the user explicitly selects + their note text.

### Privacy policy URL

```
https://github.com/<USERNAME>/thilko/blob/main/PRIVACY.md
```

(Replace `<USERNAME>` with the actual GitHub username once the repo is pushed.)

---

## Promo / store assets

Submit:

| Asset | Required size | Notes |
|---|---|---|
| Store icon | 128×128 PNG | Use `public/icons/icon-128.png` from this repo. |
| Screenshots | 1280×800 PNG, min 1, max 5 | See checklist below. |
| Small promo tile | 440×280 PNG | Optional but improves browse visibility. The mascot + name + tagline on a soft cream gradient works well. |
| Marquee promo tile | 1400×560 PNG | Optional. Skip for unlisted. |

### Screenshot capture checklist

Open the extension on your local Chrome. Pick a long-form article (a Stratechery post, a Paul Graham essay, an arXiv paper — anything you'd actually annotate). Then capture each of these at 1280×800:

1. **The selection toolbar in action.** Highlight a sentence so the toolbar appears with the mascot peeking above. The point of this shot: showing the moment of action.
2. **A popover with one AI exchange.** Highlight → Ask Dabbis-AI → ask one question → wait for the response. Capture with the mascot in the gutter on the assistant turn.
3. **The popover with a note + an AI thread.** Both surfaces in one capture — proves the "single conversation" UI.
4. **The library page.** Open the action → library opens in a new tab with at least 3-4 highlights visible across 1-2 topics.
5. **The options page.** Just shows that there's a real settings surface. Make sure no real proxy secret is visible in the screenshot — use a placeholder before capturing.

Save them under `docs/release/screenshots/` with names `01-toolbar.png`, `02-popover-chat.png`, `03-popover-note-thread.png`, `04-library.png`, `05-options.png`.

### Small promo tile (optional)

If you want one, a Figma / Photoshop layout with:

- Soft cream gradient (`linear-gradient(135deg, #fdfaf2, #fbf6e9)`)
- Mascot illustration centered-left at ~180px
- "Thilko" wordmark in Inter SemiBold, brand-purple (`#4f46e5`)
- Tagline below: "Read with Dabbis" in muted gray (`#6b7280`), Inter Medium

---

## Pre-submit checklist

- [ ] Built fresh `release/thilko-v0.1.0.zip` (or rebuild now if anything's changed).
- [ ] Removed every reference to real personal slot / secret / VPS from the codebase.
- [ ] Verified the `.zip` installs cleanly on a clean Chrome profile via "Load unpacked".
- [ ] Verified the first-run options page opens, Test Connection works against your proxy.
- [ ] PRIVACY.md is reachable at the URL in the listing's Privacy section.
- [ ] All 5 screenshots captured at 1280×800.
- [ ] Visibility set to **Unlisted** in the dashboard (not Private, not Public).

After submit, review takes ~1–3 days for an unlisted extension.

---

## Sharing with the small circle (post-publish)

When CWS approves the listing, you'll get an install URL like `https://chromewebstore.google.com/detail/<id>`. Send that to each friend along with:

- Your proxy URL
- The `PROXY_SECRET`
- A unique **slot** name per friend (e.g., `alice`, `bob`, `carol`) — they paste this into Options.

They install from the URL, paste the three values into Options, click Test Connection, and they're in.

If you add or remove friends later, no extension change is needed — slot is just a string each user configures.
