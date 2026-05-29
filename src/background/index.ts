/**
 * Background service worker entry point.
 *
 * Responsibilities (M2 scope):
 *   1. On install/update: open the options page so the user can configure.
 *   2. On startup: register the periodic health-check alarm, the RPC handler,
 *      and the settings-change subscription. Run an initial health check.
 *   3. On extension-action click: open the library page (placeholder route
 *      until M7).
 *
 * Chrome may terminate this SW at any time. All state lives in chrome.storage
 * (sync = user settings; session = current connection status) or
 * chrome.alarms (next health check). No module-scope live data.
 */

import { loadSettings, onSettingsChange } from "../shared/settings.js";
import { ensureHealthAlarm, registerHealthAlarmHandler, runHealthCheck } from "./health-check.js";
import { registerRpcHandler } from "./rpc.js";
import { registerChatStreamHandler } from "./chat-stream.js";
import { installPdfRedirectRule, removePdfRedirectRule } from "./pdf-redirect.js";

// ── One-time SW boot ────────────────────────────────────────────────────────

(async function boot() {
  // chrome.storage.session defaults to "TRUSTED_CONTEXTS" — that means the
  // SW, options page, and popup can read/write it, but content scripts
  // can't. The chat-import content script on claude.ai / chatgpt.com needs
  // to read the one-shot continuation stash, so we widen the access level
  // here. setAccessLevel can only be called from a trusted context, so the
  // SW boot is the right place. Safe to call on every boot — it's a no-op
  // when the level is already what we requested.
  try {
    await chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS" });
  } catch (e) {
    // Pre-Chrome 102 won't have setAccessLevel; pre-115 may not accept the
    // string literal. Either way, fall through — chat-import will simply
    // fail to read the stash and leave the text on the clipboard.
    console.warn("[thilko] session storage setAccessLevel failed", e);
  }

  registerHealthAlarmHandler();
  registerRpcHandler();
  registerChatStreamHandler();
  await ensureHealthAlarm();
  await syncPdfRedirectRule();
  await runHealthCheck();
})().catch((e) => console.error("[thilko] background boot failed", e));

/**
 * Install or remove the PDF redirect rule based on the user's
 * `pdfAutoRedirect` setting. Default behaviour (setting absent or false):
 * PDFs go to Chrome's native viewer. Setting must be flipped on for the
 * pre-v0.1.5 "open everything in Thilko" behaviour.
 */
async function syncPdfRedirectRule(): Promise<void> {
  const settings = await loadSettings();
  if (settings?.pdfAutoRedirect) {
    await installPdfRedirectRule();
  } else {
    await removePdfRedirectRule();
  }
}

// ── Event hooks (must be registered at top level so Chrome re-wires them
//     after SW restart). ─────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async (details) => {
  // First install → open options page so the user can configure immediately.
  if (details.reason === "install") {
    try {
      await chrome.runtime.openOptionsPage();
    } catch (e) {
      console.warn("[thilko] could not auto-open options on install", e);
    }
  }
  // Update or re-install → ensure alarm + dNR rule are in their proper state.
  await ensureHealthAlarm();
  await syncPdfRedirectRule();
  await runHealthCheck();
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureHealthAlarm();
  await syncPdfRedirectRule();
  await runHealthCheck();
});

// Settings changes trigger an immediate re-check (user just hit Save and
// expects the icon to update without waiting up to a minute for the alarm).
onSettingsChange(() => {
  runHealthCheck().catch((e) => console.error("[thilko] settings-change health check failed", e));
  // pdfAutoRedirect may have just flipped — re-sync the DNR rule.
  syncPdfRedirectRule().catch((e) => console.error("[thilko] PDF redirect sync failed", e));
});

/** URL heuristic for PDFs the action-click switch handles. Mirrors the
 *  patterns the DNR redirect rule uses — keep in sync with pdf-redirect.ts. */
function isPdfTabUrl(url: string | undefined): boolean {
  if (!url) return false;
  // .pdf extension (case-insensitive) on http/https
  if (/^https?:\/\/[^?#]+\.pdf(?:[?#]|$)/i.test(url)) return true;
  // arxiv's bare /pdf/<id> form (no extension)
  if (/^https?:\/\/arxiv\.org\/pdf\//i.test(url)) return true;
  return false;
}

// Action button:
//   - On a PDF tab → reopen the same PDF in Thilko's pdf.js viewer in a
//     new tab. Chrome's native viewer stays as the default for browsing;
//     this gives a one-click "switch to Thilko to annotate" path.
//   - Otherwise → open the library page (focus an existing one if open).
chrome.action.onClicked.addListener(async (tab) => {
  const tabUrl = tab.url ?? "";
  if (isPdfTabUrl(tabUrl)) {
    const viewerUrl = chrome.runtime.getURL("src/pdf-viewer/viewer.html") + "?file=" + tabUrl;
    try {
      await chrome.tabs.create({ url: viewerUrl, active: true });
      return;
    } catch (e) {
      console.warn("[thilko] could not open PDF in Thilko viewer", e);
      // fall through to the library behaviour
    }
  }

  const libraryUrl = chrome.runtime.getURL("src/library/library.html");
  try {
    const existing = await chrome.tabs.query({ url: chrome.runtime.getURL("src/library/library.html") });
    if (existing.length > 0 && existing[0]?.id !== undefined) {
      const t = existing[0];
      await chrome.tabs.update(t.id!, { active: true });
      if (t.windowId !== undefined) {
        await chrome.windows.update(t.windowId, { focused: true });
      }
      return;
    }
    await chrome.tabs.create({ url: libraryUrl });
  } catch (e) {
    console.warn("[thilko] could not open library", e);
    // Fallback to the options page if for some reason the library URL fails.
    try {
      await chrome.runtime.openOptionsPage();
    } catch {
      // give up
    }
  }
});
