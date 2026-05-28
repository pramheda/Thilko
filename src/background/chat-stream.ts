/**
 * Background-side handler for streaming chat ports.
 *
 * Each chrome.runtime.Port from the content script is a single chat turn:
 *   - opens, sends one "start" message, receives deltas, then "done"/"error", closes.
 *
 * We open a streaming fetch to /memory/chat, parse the SSE events as they
 * arrive (no buffering of the entire response), and forward extracted
 * `delta` / `done` / `error` events to the content script.
 *
 * If the port disconnects mid-stream (popover closed), we abort the upstream
 * fetch so we don't keep burning tokens.
 */

import { loadSettings } from "../shared/settings.js";
import {
  CHAT_PORT_NAME,
  type ChatStreamClientMessage,
  type ChatStreamServerMessage,
  type ChatStreamStart,
} from "../shared/chat-stream.js";

interface SseEvent {
  event: string;
  data: string;
}

export function registerChatStreamHandler(): void {
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== CHAT_PORT_NAME) return;
    let abort: AbortController | null = null;

    port.onMessage.addListener(async (msg: ChatStreamClientMessage) => {
      if (msg?.type !== "start") return;
      if (abort) return; // ignore duplicate starts on the same port
      abort = new AbortController();
      await runStream(msg, port, abort.signal);
    });

    port.onDisconnect.addListener(() => {
      abort?.abort();
      abort = null;
    });
  });
}

async function runStream(req: ChatStreamStart, port: chrome.runtime.Port, signal: AbortSignal): Promise<void> {
  const settings = await loadSettings();
  if (!settings) {
    safePost(port, {
      type: "error",
      requestId: req.requestId,
      code: "unconfigured",
      message: "Extension is not configured. Open Options.",
    });
    safeDisconnect(port);
    return;
  }

  const url = `${settings.proxyUrl.replace(/\/+$/, "")}/memory/chat`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${settings.proxySecret}`,
        "X-Token-Slot": settings.slot,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        systemPrompt: req.systemPrompt,
        contextBlocks: req.contextBlocks,
        history: req.history,
        userMessage: req.userMessage,
        model: req.model,
      }),
      mode: "cors",
      credentials: "omit",
      cache: "no-store",
      signal,
    });
  } catch (e) {
    safePost(port, {
      type: "error",
      requestId: req.requestId,
      code: signal.aborted ? "aborted" : "network",
      message: e instanceof Error ? e.message : String(e),
    });
    safeDisconnect(port);
    return;
  }

  if (!response.ok) {
    let errBody = "";
    try {
      errBody = (await response.text()).slice(0, 300);
    } catch {
      // ignore
    }
    let code = `http_${response.status}`;
    let message = `Proxy returned HTTP ${response.status}`;
    try {
      const parsed = errBody ? (JSON.parse(errBody) as { error?: { code?: string; message?: string } }) : undefined;
      if (parsed?.error?.code) code = parsed.error.code;
      if (parsed?.error?.message) message = parsed.error.message;
    } catch {
      // ignore
    }
    safePost(port, { type: "error", requestId: req.requestId, code, message });
    safeDisconnect(port);
    return;
  }

  if (!response.body) {
    safePost(port, { type: "error", requestId: req.requestId, code: "no_body", message: "Proxy returned no body" });
    safeDisconnect(port);
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let accumulated = "";
  let usage: { inputTokens?: number; outputTokens?: number } | undefined;
  let sawCompleted = false;

  /** Find the next SSE event terminator (\n\n or \r\n\r\n) in `buffer`. */
  function nextEventBreak(): { idx: number; len: number } {
    const lf = buffer.indexOf("\n\n");
    const crlf = buffer.indexOf("\r\n\r\n");
    if (lf < 0 && crlf < 0) return { idx: -1, len: 0 };
    if (lf < 0) return { idx: crlf, len: 4 };
    if (crlf < 0) return { idx: lf, len: 2 };
    return lf < crlf ? { idx: lf, len: 2 } : { idx: crlf, len: 4 };
  }

  /** Dispatch one accumulated event. Returns true if we should bail (errored). */
  function dispatch(rawEvent: string): boolean {
    const ev = parseSseEvent(rawEvent);
    if (!ev) return false;
    const handled = handleEvent(ev, req.requestId, port, (text) => {
      accumulated += text;
    });
    if (handled.completed) {
      sawCompleted = true;
      if (handled.usage) usage = handled.usage;
    }
    return handled.errored;
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        // Flush any final buffered event the upstream didn't terminate with a
        // blank line. Codex normally does terminate, but be conservative.
        const tail = buffer.trim();
        if (tail.length > 0) {
          if (dispatch(tail)) {
            safeDisconnect(port);
            return;
          }
          buffer = "";
        }
        break;
      }
      buffer += decoder.decode(value, { stream: true });

      let brk = nextEventBreak();
      while (brk.idx >= 0) {
        const rawEvent = buffer.slice(0, brk.idx);
        buffer = buffer.slice(brk.idx + brk.len);
        if (dispatch(rawEvent)) {
          safeDisconnect(port);
          return;
        }
        brk = nextEventBreak();
      }
    }
  } catch (e) {
    if (signal.aborted) {
      // Caller closed the port — silently stop.
      safeDisconnect(port);
      return;
    }
    safePost(port, {
      type: "error",
      requestId: req.requestId,
      code: "stream_error",
      message: e instanceof Error ? e.message : String(e),
    });
    safeDisconnect(port);
    return;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }

  if (sawCompleted) {
    safePost(port, { type: "done", requestId: req.requestId, finalText: accumulated, usage });
  } else {
    // Stream ended without a completion marker — likely truncated.
    safePost(port, {
      type: "error",
      requestId: req.requestId,
      code: "incomplete_stream",
      message: "Upstream stream ended without a completion event",
    });
  }
  safeDisconnect(port);
}

interface EventOutcome {
  completed: boolean;
  errored: boolean;
  usage?: { inputTokens?: number; outputTokens?: number };
}

function handleEvent(
  ev: SseEvent,
  requestId: string,
  port: chrome.runtime.Port,
  appendDelta: (text: string) => void,
): EventOutcome {
  if (ev.event === "thilko-error") {
    try {
      const parsed = JSON.parse(ev.data) as { code?: string; message?: string };
      safePost(port, {
        type: "error",
        requestId,
        code: parsed.code ?? "stream_error",
        message: parsed.message ?? "Proxy reported a stream error",
      });
    } catch {
      safePost(port, { type: "error", requestId, code: "stream_error", message: "Proxy reported a stream error" });
    }
    return { completed: false, errored: true };
  }
  if (ev.event === "thilko-done") {
    return { completed: true, errored: false };
  }

  // Codex Responses API events.
  interface CodexEventShape {
    type?: string;
    delta?: string;
    response?: { usage?: { input_tokens?: number; output_tokens?: number } };
    /** `output_item.added` / `output_item.done` events. */
    item?: {
      id?: string;
      type?: string;
      status?: string;
      action?: { type?: string; query?: string; queries?: string[] };
    };
  }
  let parsed: CodexEventShape;
  try {
    parsed = JSON.parse(ev.data) as CodexEventShape;
  } catch {
    return { completed: false, errored: false };
  }

  if (parsed.type === "response.output_text.delta" && typeof parsed.delta === "string") {
    const delta = parsed.delta;
    appendDelta(delta);
    safePost(port, { type: "delta", requestId, text: delta });
    return { completed: false, errored: false };
  }
  if (parsed.type === "response.completed") {
    const usage = parsed.response?.usage;
    return {
      completed: true,
      errored: false,
      usage: usage ? { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens } : undefined,
    };
  }

  // Web search events — surfaced to the popover as `search` messages so the
  // user gets a "Dabbis is searching…" affordance while the model fetches.
  // `output_item.added` with type web_search_call = search started.
  // `output_item.done`  with type web_search_call = search completed (carries
  // the query in `action.query`/`action.queries`).
  if (parsed.type === "response.output_item.added" && parsed.item?.type === "web_search_call" && parsed.item.id) {
    safePost(port, { type: "search", requestId, itemId: parsed.item.id, status: "started", query: null });
    return { completed: false, errored: false };
  }
  if (parsed.type === "response.output_item.done" && parsed.item?.type === "web_search_call" && parsed.item.id) {
    const action = parsed.item.action;
    // Pick the most descriptive query string available.
    const query = action?.query
      ?? (Array.isArray(action?.queries) && action!.queries.length > 0 ? action!.queries[0]! : null);
    safePost(port, { type: "search", requestId, itemId: parsed.item.id, status: "completed", query });
    return { completed: false, errored: false };
  }
  // Other events (response.created, response.in_progress, etc.) are ignored.
  return { completed: false, errored: false };
}

function parseSseEvent(raw: string): SseEvent | null {
  // SSE format: lines beginning with `event:` / `data:` / `:`. Multiple data
  // lines concatenate with \n. Lines may be terminated by CR, LF, or CRLF.
  let eventName = "message";
  const dataLines: string[] = [];
  for (const line of raw.split(/\r\n|\n|\r/)) {
    if (line.length === 0) continue;
    if (line.startsWith(":")) continue; // comment
    if (line.startsWith("event:")) eventName = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
  }
  if (dataLines.length === 0 && eventName === "message") return null;
  return { event: eventName, data: dataLines.join("\n") };
}

function safePost(port: chrome.runtime.Port, msg: ChatStreamServerMessage): void {
  try {
    port.postMessage(msg);
  } catch {
    // port already closed
  }
}

function safeDisconnect(port: chrome.runtime.Port): void {
  try {
    port.disconnect();
  } catch {
    // ignore
  }
}
