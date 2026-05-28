/**
 * Open-with-Claude handoff.
 *
 * Per the plan: the user clicks "Open with Claude" on a popover, sidebar,
 * or library surface; we write the markdown summary to their clipboard,
 * then open https://claude.com/import-memory in a new tab so they can paste
 * directly into a fresh conversation.
 *
 * Implementation notes:
 *   - Clipboard write happens FIRST and SYNCHRONOUSLY relative to the user
 *     gesture. Some browsers consume the gesture once an `await` resolves;
 *     writing before the round-trip to background avoids a "clipboard
 *     blocked — not focused" failure mode.
 *   - The tab open is routed through the background SW because content
 *     scripts cannot call chrome.tabs.create directly. Extension pages
 *     (library, options) get the same RPC path — slightly redundant for
 *     them, but the single code path keeps the helper trivial.
 *   - We return granular success flags so callers can show distinct toasts
 *     ("copied + opened" vs "copied but couldn't open tab" vs "clipboard
 *     blocked, opening anyway").
 */

import type { RpcRequest } from "./messages.js";

export const CLAUDE_IMPORT_URL = "https://claude.com/import-memory";

export interface HandoffResult {
  clipboardOk: boolean;
  tabOk: boolean;
}

export async function openWithClaude(summary: string): Promise<HandoffResult> {
  const clipboardOk = await writeClipboard(summary);
  const tabOk = await openImportTab();
  return { clipboardOk, tabOk };
}

async function writeClipboard(text: string): Promise<boolean> {
  if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
    return false;
  }
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    console.warn("[thilko] clipboard write failed", e);
    return false;
  }
}

async function openImportTab(): Promise<boolean> {
  if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) {
    return false;
  }
  try {
    const req: RpcRequest = { kind: "openClaudeImport" };
    const res = (await chrome.runtime.sendMessage(req)) as { ok?: boolean } | undefined;
    return !!res?.ok;
  } catch (e) {
    console.warn("[thilko] could not open Claude import tab", e);
    return false;
  }
}
