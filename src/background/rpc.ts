/**
 * Background SW RPC dispatcher.
 *
 * Other extension contexts (content script, options page, library page)
 * send RpcRequest messages via chrome.runtime.sendMessage; this dispatcher
 * resolves them by routing through the proxy with the user's settings.
 *
 * Keeps the proxy secret + Supermemory traffic in one process and gives
 * content scripts a single typed surface to call.
 */

import { loadSettings, type ValidatedSettings } from "../shared/settings.js";

const DATA_VERSION_KEY = "thilko_data_version";

/**
 * Bump the data-version timestamp in chrome.storage.local so the library
 * page (and any future cross-extension surface) re-fetches its data. Called
 * after every successful write op. Cheap; failures are non-fatal.
 */
function notifyDataChanged(): void {
  chrome.storage.local.set({ [DATA_VERSION_KEY]: Date.now() }).catch((e) => {
    console.warn("[thilko] notifyDataChanged failed", e);
  });
}
import {
  appendToThread,
  createComment,
  createHighlight,
  createThread,
  deleteComment,
  deleteHighlight,
  deleteThread,
  ensureArticle,
  listComments,
  listHighlights,
  listThreads,
  listTopics,
  ProxyApiError,
  search,
  updateComment,
  updateHighlight,
  updateThread,
  type ProxyCreds,
} from "../shared/proxy-api.js";
import { type RpcRequest, type RpcResponse } from "../shared/messages.js";
import { CLAUDE_CHAT_URL, CHATGPT_URL } from "../shared/claude-handoff.js";

/** Shared key for the one-shot chat-import stash read by chat-import content script. */
const CHAT_IMPORT_STASH_KEY = "thilko_pendingChatImport";
import { getConnectionStatus, runHealthCheck } from "./health-check.js";
import { appendOpLog, clearOpLog, readOpLog } from "./op-log.js";

function asCreds(s: ValidatedSettings): ProxyCreds {
  return { proxyUrl: s.proxyUrl, proxySecret: s.proxySecret, slot: s.slot };
}

async function dispatch(req: RpcRequest): Promise<unknown> {
  if (req.kind === "getConnectionStatus") {
    return getConnectionStatus();
  }
  if (req.kind === "recheckConnection") {
    return runHealthCheck();
  }
  if (req.kind === "openClaude") {
    // Pure tab open — no proxy creds needed. Lives in background because
    // content scripts can't call chrome.tabs.create directly. Target is a
    // fresh Claude.ai chat; the caller has already copied the summary to
    // the clipboard so the user can paste as their first message.
    await chrome.tabs.create({ url: CLAUDE_CHAT_URL });
    return { ok: true };
  }
  if (req.kind === "openInChat") {
    // Continuation flow: stash the text for the chat-import content script
    // to pick up + auto-paste + auto-send on the target site. We use
    // chrome.storage.session so the stash dies when the browser closes
    // (one-shot, not persistent), and the content script also clears it
    // after use to prevent re-fire on refresh.
    const url = req.target === "chatgpt" ? CHATGPT_URL : CLAUDE_CHAT_URL;
    await chrome.storage.session.set({
      [CHAT_IMPORT_STASH_KEY]: {
        target: req.target,
        text: req.text,
        ts: Date.now(),
      },
    });
    await chrome.tabs.create({ url });
    return { ok: true };
  }
  if (req.kind === "readOpLog") {
    return { entries: await readOpLog() };
  }
  if (req.kind === "clearOpLog") {
    await clearOpLog();
    return { ok: true };
  }
  if (req.kind === "getActivationSettings") {
    // Safe subset for the content script — never returns proxySecret/slot/url.
    const s = await loadSettings();
    if (!s) return { configured: false, exclusionDomains: [], localhostEnabled: false, devMode: false, autoPersistHighlights: false };
    return {
      configured: true,
      exclusionDomains: s.exclusionDomains,
      localhostEnabled: s.localhostEnabled,
      devMode: s.devMode,
      autoPersistHighlights: s.autoPersistHighlights,
    };
  }

  const settings = await loadSettings();
  if (!settings) {
    throw new ProxyApiError(0, "unconfigured", "Extension is not configured. Open Options to set proxy URL, secret, and slot.");
  }
  const creds = asCreds(settings);

  // Wrapper that bumps the cross-tab data version after successful writes.
  const withNotify = async <T>(p: Promise<T>): Promise<T> => {
    const r = await p;
    notifyDataChanged();
    return r;
  };

  switch (req.kind) {
    case "ensureArticle":
      return ensureArticle(creds, { url: req.url, title: req.title, contentType: req.contentType });

    case "createHighlight":
      return withNotify(createHighlight(creds, { id: req.id, articleId: req.articleId, anchor: req.anchor, topicIds: req.topicIds }));
    case "updateHighlight":
      return withNotify(updateHighlight(creds, req.id, req.patch));
    case "deleteHighlight":
      return withNotify(deleteHighlight(creds, req.id));
    case "listHighlights":
      return listHighlights(creds, { articleId: req.articleId });

    case "createComment":
      return withNotify(createComment(creds, { id: req.id, highlightId: req.highlightId, articleId: req.articleId, text: req.text }));
    case "updateComment":
      return withNotify(updateComment(creds, req.id, { text: req.text }));
    case "deleteComment":
      return withNotify(deleteComment(creds, req.id));
    case "listComments":
      return listComments(creds, { highlightId: req.highlightId, articleId: req.articleId });

    case "createThread":
      return withNotify(createThread(creds, { highlightId: req.highlightId, articleId: req.articleId, messages: req.messages }));
    case "appendToThread":
      return withNotify(appendToThread(creds, req.threadId, req.message));
    case "updateThread":
      return withNotify(updateThread(creds, req.id, { messages: req.messages }));
    case "deleteThread":
      return withNotify(deleteThread(creds, req.id));
    case "listThreads":
      return listThreads(creds, { highlightId: req.highlightId, articleId: req.articleId });

    case "search":
      return search(creds, req.q, req.filters);
    case "listTopics":
      return listTopics(creds);

    case "resetAllData":
      return withNotify(performResetAllData(creds));
  }
}

/**
 * Client-driven slot reset: list every highlight/comment/thread in the
 * configured slot and delete each one. We use the existing per-record
 * delete endpoints to keep the proxy contract strictly additive (no new
 * /memory/reset route).
 *
 * Pagination: the proxy list endpoints cap each response at 500 records
 * (per the contract — see docs/proxy-contract.md). To drain a slot that
 * holds more than that, we loop list→delete-each→list-again per kind,
 * until either the next
 * list returns empty OR a full pass deletes nothing (i.e. every remaining
 * record's delete is failing — likely a transient backend issue, not a
 * bug we can recover from here).
 *
 * Errors: per-record delete failures are accumulated (count + first error
 * code) and returned so the options UI can show a partial-failure toast
 * instead of claiming success.
 */
interface ResetResult {
  deleted: { highlights: number; comments: number; threads: number };
  failed: { highlights: number; comments: number; threads: number };
  firstErrorCode?: string;
}

async function performResetAllData(creds: ProxyCreds): Promise<ResetResult> {
  let firstErrorCode: string | undefined;
  const noteError = (e: unknown): void => {
    if (!firstErrorCode && e instanceof ProxyApiError) firstErrorCode = e.code;
  };

  const cm = await drainKind(
    async () => (await listComments(creds, {})).comments,
    (id) => deleteComment(creds, id),
    noteError,
  );
  const th = await drainKind(
    async () => (await listThreads(creds, {})).threads,
    (id) => deleteThread(creds, id),
    noteError,
  );
  const hl = await drainKind(
    async () => (await listHighlights(creds, {})).highlights,
    (id) => deleteHighlight(creds, id),
    noteError,
  );

  // Drop the op log so the activity panel doesn't fill with deletion noise.
  await chrome.storage.local.remove(["thilko_op_log"]);

  return {
    deleted: { highlights: hl.deleted, comments: cm.deleted, threads: th.deleted },
    failed: { highlights: hl.failed, comments: cm.failed, threads: th.failed },
    firstErrorCode,
  };
}

async function drainKind<T extends { id: string }>(
  list: () => Promise<T[]>,
  del: (id: string) => Promise<unknown>,
  onError: (e: unknown) => void,
): Promise<{ deleted: number; failed: number }> {
  // Track records whose delete keeps failing so we don't re-attempt them on
  // every pass (which would explode the failed count + spin uselessly).
  const failedIds = new Set<string>();
  let deleted = 0;
  // Cap passes — at most ~50K records for v1 use, list cap is 500, so 100
  // passes is generous. If we hit the cap, that's a real bug worth surfacing.
  for (let pass = 0; pass < 100; pass++) {
    const items = await list();
    const todo = items.filter((i) => !failedIds.has(i.id));
    if (todo.length === 0) break;
    let progressed = false;
    for (const item of todo) {
      try {
        await del(item.id);
        deleted++;
        progressed = true;
      } catch (e) {
        failedIds.add(item.id);
        onError(e);
      }
    }
    if (!progressed) break;
  }
  return { deleted, failed: failedIds.size };
}

/** RPC kinds we DON'T record in the op-log — they're either reads of the log
 *  itself (which would recurse) or trivial UI plumbing that's pure noise. */
const OP_LOG_EXCLUDE = new Set<string>([
  "readOpLog",
  "clearOpLog",
  "getConnectionStatus",
  "getActivationSettings",
]);

export function registerRpcHandler(): void {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    // The Chrome runtime requires sendResponse to be invoked synchronously
    // OR `return true` to keep the channel open for an async response.
    const req = message as RpcRequest;
    if (!req || typeof req !== "object" || typeof (req as { kind?: unknown }).kind !== "string") {
      sendResponse({ ok: false, error: { code: "invalid_request", message: "Missing 'kind' field" } } satisfies RpcResponse);
      return false;
    }
    const startedAt = Date.now();
    const recordOp = (ok: boolean, errorCode?: string): void => {
      if (OP_LOG_EXCLUDE.has(req.kind)) return;
      void appendOpLog({
        at: Date.now(),
        kind: req.kind,
        durationMs: Date.now() - startedAt,
        ok,
        errorCode,
      });
    };
    dispatch(req).then(
      (data) => {
        recordOp(true);
        sendResponse({ ok: true, data } satisfies RpcResponse);
      },
      (err) => {
        if (err instanceof ProxyApiError) {
          recordOp(false, err.code);
          sendResponse({ ok: false, error: { code: err.code, message: err.message } } satisfies RpcResponse);
        } else {
          const msg = err instanceof Error ? err.message : String(err);
          recordOp(false, "internal_error");
          sendResponse({ ok: false, error: { code: "internal_error", message: msg } } satisfies RpcResponse);
        }
      },
    );
    return true; // async sendResponse
  });
}
