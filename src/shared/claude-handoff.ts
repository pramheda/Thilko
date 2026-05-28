/**
 * Open-with-Claude handoff.
 *
 * Per the plan: the user clicks "Open with Claude" on a popover, sidebar,
 * or library surface; we write the markdown summary to their clipboard,
 * then open https://claude.ai/new in a new tab — a fresh Claude.ai chat —
 * so they can paste the article + notes as their first message.
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

export const CLAUDE_CHAT_URL = "https://claude.ai/new";
export const CHATGPT_URL = "https://chatgpt.com/";

export type ChatTarget = "claude" | "chatgpt";

export interface HandoffResult {
  clipboardOk: boolean;
  tabOk: boolean;
}

export async function openWithClaude(summary: string): Promise<HandoffResult> {
  const clipboardOk = await writeClipboard(summary);
  const tabOk = await openImportTab();
  return { clipboardOk, tabOk };
}

/**
 * The Open-with-Claude/ChatGPT *continuation* flow used by the popover.
 *
 * Differs from openWithClaude() above in that we stash the text for a
 * content script to auto-paste and auto-send in the target chat surface,
 * so the user lands in an already-acknowledged conversation rather than a
 * blank chat with the text on their clipboard.
 *
 * We still write to the clipboard as a defensive fallback — if the auto-
 * paste content script doesn't engage (target not logged in, UI changed,
 * etc.) the user can Ctrl-V it themselves.
 */
export async function openContinuation(target: ChatTarget, text: string): Promise<HandoffResult> {
  const clipboardOk = await writeClipboard(text);
  const tabOk = await openInChatTab(target, text);
  return { clipboardOk, tabOk };
}

async function openInChatTab(target: ChatTarget, text: string): Promise<boolean> {
  if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) {
    return false;
  }
  try {
    const req: RpcRequest = { kind: "openInChat", target, text };
    const res = (await chrome.runtime.sendMessage(req)) as { ok?: boolean } | undefined;
    return !!res?.ok;
  } catch (e) {
    console.warn("[thilko] could not open chat tab", e);
    return false;
  }
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
    const req: RpcRequest = { kind: "openClaude" };
    const res = (await chrome.runtime.sendMessage(req)) as { ok?: boolean } | undefined;
    return !!res?.ok;
  } catch (e) {
    console.warn("[thilko] could not open Claude tab", e);
    return false;
  }
}
