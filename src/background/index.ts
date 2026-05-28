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

import { onSettingsChange } from "../shared/settings.js";
import { ensureHealthAlarm, registerHealthAlarmHandler, runHealthCheck } from "./health-check.js";
import { registerRpcHandler } from "./rpc.js";
import { registerChatStreamHandler } from "./chat-stream.js";
import { installPdfRedirectRule } from "./pdf-redirect.js";

// ── One-time SW boot ────────────────────────────────────────────────────────

(async function boot() {
  registerHealthAlarmHandler();
  registerRpcHandler();
  registerChatStreamHandler();
  await ensureHealthAlarm();
  await installPdfRedirectRule();
  await runHealthCheck();
})().catch((e) => console.error("[thilko] background boot failed", e));

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
  // Update or re-install → ensure alarm + dNR rule are wired up.
  await ensureHealthAlarm();
  await installPdfRedirectRule();
  await runHealthCheck();
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureHealthAlarm();
  await installPdfRedirectRule();
  await runHealthCheck();
});

// Settings changes trigger an immediate re-check (user just hit Save and
// expects the icon to update without waiting up to a minute for the alarm).
onSettingsChange(() => {
  runHealthCheck().catch((e) => console.error("[thilko] settings-change health check failed", e));
});

// Action button → open the library page in a new tab. If one is already
// open for this extension, focus it instead of creating a duplicate.
chrome.action.onClicked.addListener(async () => {
  const libraryUrl = chrome.runtime.getURL("src/library/library.html");
  try {
    const existing = await chrome.tabs.query({ url: chrome.runtime.getURL("src/library/library.html") });
    if (existing.length > 0 && existing[0]?.id !== undefined) {
      const tab = existing[0];
      await chrome.tabs.update(tab.id!, { active: true });
      if (tab.windowId !== undefined) {
        await chrome.windows.update(tab.windowId, { focused: true });
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
