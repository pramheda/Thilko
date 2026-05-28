# Proxy contract (v0.1.0)

Thilko is a Chrome extension that talks to a proxy server you control. The proxy holds your `PROXY_SECRET`, your OpenAI Codex OAuth token, and your `SUPERMEMORY_API_KEY`, and forwards inference requests to OpenAI and storage requests to Supermemory. The extension never holds an API key.

This document defines the **wire contract** between the extension and the proxy. It exists so that anyone can implement a compatible proxy in any language. The author runs a private reference implementation; a public open-source proxy is planned for v0.2.

For an end-user, the practical implications:

- If you want to **use Thilko** with someone else's proxy, all you need is their `Proxy URL`, the `PROXY_SECRET`, and your `slot` name.
- If you want to **run your own proxy**, this document tells you exactly what endpoints to implement.

The current reference implementation is roughly **400 lines of TypeScript** on Node `http`. There is no business logic the proxy needs to invent — it's a thin auth + adapter layer.

---

## Transport

- HTTPS strongly recommended (the extension supports HTTP for SSH-tunnel localhost setups).
- Standard JSON request/response bodies, `Content-Type: application/json`.
- One endpoint streams Server-Sent Events (`/memory/chat`); the rest are request/response.

CORS: the extension's `chrome-extension://<id>` origin must be allowed on every endpoint. Headers to allow: `Authorization`, `X-Token-Slot`, `Content-Type`. Methods: `GET`, `POST`, `OPTIONS`. Reference proxy uses an allowlist that admits `chrome-extension://`, `moz-extension://`, `safari-web-extension://`.

---

## Authentication

Every request the extension makes carries two headers:

```
Authorization: Bearer <PROXY_SECRET>
X-Token-Slot: <slot-name>
```

- `PROXY_SECRET` is a shared secret you generate and configure on both sides (in `chrome.storage.sync` on the extension, in env on the proxy).
- `slot-name` is a 1–32-char namespace tag matching `^[a-zA-Z0-9_-]+$`. Every record the proxy stores must be scoped to a slot; reads must filter by slot. This is how multiple users share one proxy without seeing each other's data.

Two endpoints bypass `PROXY_SECRET` checks: **none.** Both auth headers are required on every route.

### Error shape

When the proxy rejects or fails a request, it returns a JSON body of this shape, never plain text:

```json
{ "error": { "code": "string", "message": "string" } }
```

Error codes used by the extension's typed handlers (you should emit these so error UI lights up):

| HTTP | code | when |
|---|---|---|
| 400 | `invalid_body` | malformed request payload |
| 400 | `invalid_slot` | slot didn't match `^[a-zA-Z0-9_-]{1,32}$` |
| 401 | `unauthorized` | bad `PROXY_SECRET` |
| 404 | `not_found` | record missing (during update/delete) |
| 429 | `rate_limited` | proxy rate limiter tripped |
| 502 | `upstream_*` | OpenAI or Supermemory error |
| 503 | `memory_unavailable` | proxy started without `SUPERMEMORY_API_KEY` |

---

## Endpoints

### `GET /health[?slot=<slot>]`

Health check used by the extension's background SW to populate the toolbar icon's red/green dot.

**Response 200**

```json
{
  "ok": true,
  "slot": "alice",
  "tokenValid": true,
  "tokenExpiresAt": "2026-07-12T10:30:00Z",
  "expiresInSeconds": 1234567
}
```

- `tokenValid` — your stored Codex OAuth token is non-expired.
- `tokenExpiresAt` — ISO-8601 expiry (or `null`).
- `expiresInSeconds` — convenience; `null` if unknown.

When the token is expired, return `200` with `ok: false, tokenValid: false`. Reserve non-200 for actual proxy faults.

---

### `POST /memory/ping`

Auth-only probe that doesn't hit Supermemory. Used by the extension's health check to disambiguate "wrong secret" from "Codex token issue".

**Request** `{}`

**Response 200**

```json
{ "ok": true, "memoryReady": true }
```

`memoryReady: false` means the proxy is running without a `SUPERMEMORY_API_KEY` — all `/memory/*` routes (except `ping` and `chat`) will return 503.

---

### `POST /memory/article`

Ensures an article document exists in Supermemory for a given canonical URL. Idempotent — safe to call multiple times for the same URL.

**Request**

```json
{
  "url": "https://example.com/article",
  "title": "Article title",
  "contentType": "html"  // or "pdf"
}
```

**Response 200**

```json
{
  "articleId": "a3f2…",            // sha256_hex(canonicalUrl)
  "supermemoryDocId": "doc_…",     // Supermemory's internal id
  "status": "created" | "existing",
  "canonicalUrl": "https://example.com/article",
  "title": "Article title"
}
```

The article ID is **deterministic from canonical URL** — both sides (extension + proxy) derive it the same way:

```ts
articleId = sha256_hex(canonicalizeUrl(rawUrl))
```

`canonicalizeUrl` strips a fixed set of tracking parameters (`utm_*`, `mc_*`, `fbclid`, `gclid`, `msclkid`, `yclid`, `dclid`, `twclid`, `igshid`, `ref`, `ref_src`, `ref_url`, `share`, `shared`, `spm`), lowercases hostname, normalizes ports/trailing slashes, drops the hash fragment. See `src/shared/url.ts` for the exact algorithm.

---

### `POST /memory/highlight`

CRUD on highlight records. Dispatched on `op`.

#### `op: "create"`

```json
{
  "op": "create",
  "highlight": {
    "id": "uuid",                 // optional; proxy generates if absent
    "articleId": "a3f2…",
    "anchor": { /* Anchor */ },
    "topicIds": []                // optional, default []
  }
}
```

**Response 200**

```json
{ "highlight": { /* full Highlight */ }, "supermemoryDocId": "doc_…" }
```

**Anchor shape:**

```ts
type Anchor =
  | { type: "html",
      quote: { exact: string, prefix: string, suffix: string },
      textPosition?: { start: number, end: number } }
  | { type: "pdf",
      quote: { exact: string, prefix: string, suffix: string },
      page: number,
      pageOffset: { start: number, end: number } }
```

`quote` follows the W3C Web Annotations `TextQuoteSelector` shape. The proxy doesn't interpret `anchor` — it just stores it as opaque JSON. The extension uses it on read to re-locate the highlight in the DOM.

**Important — embedding content:** the proxy stores the highlight's `content` field (used for Supermemory's vector embedding) as the concatenation of `quote.prefix + " " + quote.exact + " " + quote.suffix`. This is so two-word highlights still have enough surrounding text to embed meaningfully. See the reference implementation's `highlightToCreateInput`.

#### `op: "update"`

```json
{
  "op": "update",
  "id": "uuid",
  "patch": {
    "anchor": { /* Anchor */ },
    "topicIds": ["…"],
    "orphaned": true | false
  }
}
```

All fields in `patch` are optional; only those present should be updated.

**Response 200**: `{ "highlight": { /* full */ } }`

#### `op: "delete"`

```json
{ "op": "delete", "id": "uuid" }
```

**Response 200**: `{ "ok": true }`

Should be idempotent (deleting an already-deleted record returns 200, not 404).

#### `op: "list"`

```json
{ "op": "list", "articleId": "a3f2…" }   // articleId optional
```

**Response 200**: `{ "highlights": [ /* Highlight[] */ ] }`

When `articleId` is present, scope to that article. When absent, return everything owned by the slot. Cap recommended at 500 records per response.

#### Highlight entity shape

```ts
interface Highlight {
  id: string                     // uuid
  articleId: string              // sha256(canonicalUrl)
  anchor: Anchor
  topicIds: string[]
  createdAt: number              // epoch ms
  updatedAt: number              // epoch ms
  orphaned: boolean
  ownerSlot: string              // == slot from X-Token-Slot
}
```

---

### `POST /memory/note`

CRUD on comments. Same `op` pattern: `create | update | delete | list`.

#### `op: "create"`

```json
{
  "op": "create",
  "comment": {
    "id": "uuid",                // optional; proxy generates if absent
    "highlightId": "uuid",
    "articleId": "a3f2…",
    "text": "…"
  }
}
```

#### `op: "list"`

```json
{ "op": "list", "highlightId": "uuid" }
// or
{ "op": "list", "articleId": "a3f2…" }
// or
{ "op": "list" }                 // all comments owned by slot
```

#### Comment entity

```ts
interface Comment {
  id: string
  highlightId: string
  articleId: string
  text: string
  createdAt: number
  updatedAt: number
  ownerSlot: string
}
```

---

### `POST /memory/thread`

CRUD on AI threads. Same `op` pattern, plus an `append` op for adding a single message.

#### `op: "create"`

```json
{
  "op": "create",
  "thread": {
    "id": "uuid",                // optional
    "highlightId": "uuid",
    "articleId": "a3f2…",
    "messages": [                // optional; pass [user, assistant] to atomically save the first turn
      { "role": "user", "content": "…", "createdAt": 123 },
      { "role": "assistant", "content": "…", "createdAt": 124 }
    ]
  }
}
```

The extension uses this to atomically write a thread with its first user+assistant pair, avoiding a window where an empty thread is on disk.

#### `op: "append"`

```json
{
  "op": "append",
  "threadId": "uuid",
  "message": { "role": "user", "content": "…", "createdAt": 123 }
}
```

Must be idempotent: if the last stored message matches role+content within ~1s of the incoming `createdAt`, treat it as duplicate, no-op. Response includes a `deduped` flag.

#### `op: "update"`

```json
{
  "op": "update",
  "id": "uuid",
  "patch": { "messages": [ /* ThreadMessage[] */ ] }
}
```

Replaces the entire `messages` array atomically. Used by the extension to commit a streamed `[user, assistant]` pair in one write.

#### `op: "delete"`

`{ "op": "delete", "id": "uuid" }` → `{ "ok": true }`

#### `op: "list"`

```json
{ "op": "list", "highlightId": "uuid" }
// or
{ "op": "list", "articleId": "a3f2…" }
// or
{ "op": "list" }
```

#### Thread entity

```ts
interface ThreadMessage {
  role: "user" | "assistant"
  content: string
  createdAt: number
}

interface Thread {
  id: string
  highlightId: string
  articleId: string
  messages: ThreadMessage[]
  createdAt: number
  lastMessageAt: number
  ownerSlot: string
}
```

---

### `POST /memory/search`

Semantic search across the slot's data.

**Request**

```json
{
  "q": "what did the post say about coordination",
  "filters": {
    "kinds": ["highlight", "comment", "thread"],   // optional, default all
    "articleId": "a3f2…",                          // optional
    "highlightId": "uuid",                         // optional
    "topicId": "…"                                 // optional, v1: same as articleId
  }
}
```

**Response 200**

```json
{
  "results": [
    {
      "kind": "highlight",
      "item": { /* Highlight | Comment | Thread */ },
      "score": 0.87,
      "snippet": "…matched substring with surrounding context…"
    },
    …
  ]
}
```

Score in `[0, 1]`. The extension uses score to order results; ties broken by recency.

---

### `POST /memory/topics`

Lists "topics" — in v1, topics are articles that have at least one highlight on them.

**Request** `{}`

**Response 200**

```json
{
  "topics": [
    {
      "id": "a3f2…",              // v1: articleId
      "label": "Article title",
      "canonicalUrl": "https://…", // optional
      "memoryCount": 42            // number of records (highlights+comments+threads) for this topic
    }
  ]
}
```

The extension treats `topic.id === articleId` in v1, but the contract leaves room for future "semantic cluster" topics that aren't 1:1 with articles.

---

### `POST /memory/chat` (streaming)

The big one. Streams an AI reply from OpenAI's Codex Responses API back to the extension via Server-Sent Events.

**Request**

```json
{
  "systemPrompt": "You are Dabbis…",   // includes article + highlight as background
  "contextBlocks": [],                  // legacy field; ignored when systemPrompt has the context baked in (current behavior)
  "history": [
    { "role": "user", "content": "…" },
    { "role": "assistant", "content": "…" }
  ],
  "userMessage": "…",                  // the new user turn
  "model": "gpt-5-codex"               // optional; reference proxy has a default
}
```

The extension does its own token budgeting before sending — see `src/content/popover/context-budget.ts`. The proxy can also enforce a hard byte cap as a backstop.

**Response — Server-Sent Events**

`Content-Type: text/event-stream`. The proxy forwards chunks from OpenAI's streaming response and emits them as SSE messages with a stable shape:

```
event: delta
data: {"type":"delta","requestId":"…","text":" partial token "}

event: delta
data: {"type":"delta","requestId":"…","text":" next token "}

event: done
data: {"type":"done","requestId":"…","finalText":"the full assembled assistant message"}
```

On error:

```
event: error
data: {"type":"error","requestId":"…","code":"…","message":"…"}
```

The extension uses `chrome.runtime.connect` to maintain a long-lived port — the background SW receives these messages and pipes them into the popover via the same protocol. When the user closes the popover mid-stream, the port disconnects and the proxy should abort the upstream OpenAI request (via `AbortSignal`).

`requestId` is generated by the extension and echoed by the proxy so concurrent streams to the same SW port can be disambiguated.

---

## Operational notes

These aren't part of the wire contract, but they're things the reference implementation does that you'll want to do too:

### Eventual-consistency cache

Supermemory's `/v3/documents/list` is eventually consistent — a doc you just created via POST may not appear in a subsequent list call for several seconds to minutes. The reference proxy holds a **write-through cache** of recent writes (keyed by `slot + customId`) and **overlays** them onto list responses. Default TTL: 5 minutes (`MEMORY_DOC_CACHE_TTL_MS`). Without this, the extension's "reload after creating a highlight" flow drops the just-created highlight randomly.

### Per-record mutex

When two operations target the same `customId` simultaneously (e.g., the user adds a comment while the AI is streaming), the proxy serializes them via a per-record async mutex. This prevents the second writer from overwriting the first's metadata fields.

### Tombstones

After a delete, the proxy keeps a short-lived tombstone (~5 min) so the same eventual-consistency window doesn't resurrect the deleted record in a list response.

### Idempotency

All `create` operations accept a client-supplied `id`. The reference proxy uses these as Supermemory `customId`s, so retrying a create that already succeeded returns the existing record rather than creating a duplicate. The extension generates these client-side specifically to make optimistic UI safe.

### Slot scoping on every read

Every list / get must filter by `ownerSlot == X-Token-Slot`. The reference proxy stores this as a Supermemory metadata field on every record and includes it in every filter clause.

---

## What the reference implementation looks like

For sizing: roughly

- `index.ts` — HTTP server, route table, auth middleware, rate-limit bucket, slot validation. ~250 lines.
- `memory.ts` — all `/memory/*` CRUD routes, the cache + tombstone machinery, Supermemory adapter. ~1300 lines.
- `chat.ts` — `/memory/chat` SSE streaming. ~400 lines.
- Codex OAuth flow — separate from the proxy itself (one-time setup; the reference implementation runs `codex login` and persists the per-slot OAuth token in a local file the proxy reads at request time).

The proxy itself is open-source on the roadmap (v0.2). For v0.1 you have two practical paths: write a compatible proxy against this contract, or use an instance someone else is running.
