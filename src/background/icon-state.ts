/**
 * Toolbar action icon state — visual cue for the user that the proxy is
 * reachable and configured. Two states:
 *   - connected:    indigo + green dot, no badge
 *   - disconnected: indigo + red dot, badge "✕" (or "!" if unconfigured)
 *
 * Chrome service workers can be killed/restarted at any time. We re-read
 * current state from chrome.storage.session at boot if needed; intermediate
 * UI hints (badge text) live on chrome.action which Chrome persists per-tab
 * for free.
 */

import { type ConnectionStatus } from "../shared/types.js";

const ICON_CONNECTED: Record<string, string> = {
  "16": "icons/icon-16.png",
  "32": "icons/icon-32.png",
  "48": "icons/icon-48.png",
  "128": "icons/icon-128.png",
};

const ICON_DISCONNECTED: Record<string, string> = {
  "16": "icons/icon-16-disconnected.png",
  "32": "icons/icon-32-disconnected.png",
  "48": "icons/icon-48-disconnected.png",
  "128": "icons/icon-128-disconnected.png",
};

export async function applyConnectionStatusToIcon(status: ConnectionStatus): Promise<void> {
  if (status.kind === "ok") {
    await Promise.all([
      chrome.action.setIcon({ path: ICON_CONNECTED }),
      chrome.action.setBadgeText({ text: "" }),
      chrome.action.setTitle({ title: "Thilko — connected. Click to open library." }),
    ]);
    return;
  }

  const reason =
    status.kind === "unconfigured"
      ? "Not configured. Right-click → Options to set up."
      : `Disconnected: ${status.reason}`;

  await Promise.all([
    chrome.action.setIcon({ path: ICON_DISCONNECTED }),
    chrome.action.setBadgeText({ text: status.kind === "unconfigured" ? "!" : "✕" }),
    chrome.action.setBadgeBackgroundColor({ color: status.kind === "unconfigured" ? "#a16207" : "#b91c1c" }),
    chrome.action.setTitle({ title: `Thilko — ${reason}` }),
  ]);
}
