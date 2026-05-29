# Privacy

Thilko is a Chrome extension you point at a proxy server you configure. This document lists every piece of data that leaves your browser and where it goes.

## What Thilko sends, and to where

When you interact with the extension, the following data flows out of your browser to **the proxy URL you set in Options** (and nowhere else):

| When | What | Sent to |
|---|---|---|
| You highlight text and add a note | The highlighted text, the canonical article URL, the article title, the note text | Your proxy → Supermemory |
| You ask Dabbis a question | The highlighted text, the article excerpt (truncated to fit), your question, the prior turns in this conversation | Your proxy → OpenAI Codex API |
| You ask Dabbis a question (cont.) | After the response: the user turn + assistant turn (both stored on Supermemory under your slot) | Your proxy → Supermemory |
| Page load on a non-excluded URL | A list-highlights request scoped to the canonical URL's article ID | Your proxy → Supermemory |
| Background health-check (~once a minute) | An auth-only ping that confirms your secret + slot are valid | Your proxy |
| You click "Open with Claude" | A markdown summary is written to your **local clipboard**; a new tab opens at `claude.com/import-memory` | Your clipboard, your browser |

**Anything you do NOT highlight or comment on is never sent.** The content script does not read page text passively. The selection toolbar only fires when you make an explicit selection.

## What the proxy does

The proxy is a server **you control** (or your friend controls if you're using their proxy). It:

- Holds your `PROXY_SECRET` and a Codex OAuth token so the browser never sees them.
- Forwards inference requests to `chatgpt.com/backend-api/codex/responses` using the OAuth token.
- Forwards memory CRUD to `api.supermemory.ai` using a `SUPERMEMORY_API_KEY`.
- Scopes every read and write to the **slot** you configured. Other slots cannot read your data.

The proxy keeps a short-lived in-memory write-through cache (default 5 minutes) so that reload-immediately-after-create works reliably. It does not log request bodies by default.

## Open with Claude / Open with ChatGPT

When you click "Open with Claude" or "Open with ChatGPT" in a popover menu, the extension opens a new tab on `claude.ai` or `chatgpt.com` and pastes the full transcript of that highlight's conversation into the chat input, then sends it as your first message. This transfer is **initiated by your explicit click** — no transcript ever leaves the extension to those hosts without it. Anthropic (Claude.ai) or OpenAI (ChatGPT) then receives the transcript as ordinary chat input and is governed by their own privacy policy from that point on.

If you do not click those buttons, no data is sent to Claude.ai or ChatGPT.

## Excluded sites

By default the extension does **not** activate on these hosts: `claude.ai`, `claude.com`, `chatgpt.com`, `chat.openai.com`, `mail.google.com`, `accounts.google.com`, plus a list of common banking domains. You can edit this list in Options.

A narrow exception: on `claude.ai` and `chatgpt.com` a small content script runs only to perform the one-click handoff described above. It does not read existing chat content, does not run on any other page, and does not communicate with the proxy.

It also does not run on `localhost` unless you explicitly enable it.

## What stays local

- Your settings (proxy URL, secret, slot, exclusion list) — `chrome.storage.sync` (synced across your signed-in Chrome installs by Google's normal sync, never to the extension's servers).
- The op-log ring buffer (last 100 background operations, kinds only, no payloads) — `chrome.storage.local`.
- A `thilko_data_version` timestamp used to cross-notify open tabs of writes — `chrome.storage.local`.

## What we never collect

No analytics. No telemetry. No remote logging. The Thilko extension makes zero network requests except to:

1. The proxy URL you configured.
2. The page you're reading (the content script reads `location.href` and selected DOM nodes only).
3. The bundled `pdfjs-dist` worker for rendering PDFs (loaded locally from the extension package, not over the network).

## Resetting your data

The Options page has a **Reset all data** button. It deletes every highlight, comment, and AI thread stored under your slot on Supermemory, then clears the local op-log. Articles are not slot-scoped on Supermemory (they're shared documents), so they remain.

## Multi-user note

This is a personal-v1 extension. Authentication is a shared secret + a slot name — secure enough for self-hosting with friends but **not** a real multi-tenant authentication system. Don't share a slot name with someone you don't want to share data with.

## Questions

File an issue on the GitHub repo.
