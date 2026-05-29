/**
 * chat-import — the auto-paste content script that runs ONLY on
 * claude.ai/* and chatgpt.com/* (per its manifest entry).
 *
 * Flow:
 *   1. Background's openInChat RPC stashes
 *      `{ target, text, ts }` in chrome.storage.session, then opens
 *      claude.ai/new or chatgpt.com/.
 *   2. This script wakes on the target page, reads the stash.
 *   3. If fresh (<60s), matches current host, waits for the chat input to
 *      mount (composer is React/Lexical/ProseMirror — appears on tick 2+),
 *      then fills it via execCommand('insertText') for contenteditable or
 *      the React-aware setter for textarea, dispatches `input` so React
 *      state updates, and clicks the Send button.
 *   4. Stash is cleared immediately to prevent re-fire on refresh/SPA-nav.
 *
 * Failure modes — all silent + non-destructive:
 *   - Stash missing/stale → script exits, normal blank chat page.
 *   - Input never mounts (logged out, captcha, UI rewrite) → text stays on
 *     user's clipboard (background also copied it), user can Ctrl-V.
 *   - Send button missing/disabled → text is prefilled, user clicks Send.
 *   - Hostname doesn't match the target → bail (defensive — manifest matches
 *     should already prevent this).
 *
 * The script is intentionally selector-tolerant: chat UIs ship frequent
 * redesigns, so we try multiple selectors per host and degrade gracefully
 * rather than insisting on one exact match.
 */

type Target = "claude" | "chatgpt";

interface StashItem {
  target: Target;
  text: string;
  ts: number;
}

const STASH_KEY = "thilko_pendingChatImport";
/** Stash is one-shot; older than this and we ignore it (user probably abandoned the flow). */
const STALE_MS = 60_000;
/** Cap on how long we'll wait for the chat input to mount. */
const INPUT_WAIT_MS = 8_000;
/** How long after input-fill we wait before trying to click Send (lets React enable the button). */
const SEND_DELAY_MS = 200;

interface Adapter {
  matches: (hostname: string) => boolean;
  findInput: () => HTMLElement | null;
  findSendButton: () => HTMLButtonElement | null;
}

const ADAPTERS: Record<Target, Adapter> = {
  claude: {
    matches: (h) => h === "claude.ai" || h.endsWith(".claude.ai"),
    findInput: () =>
      // Most common today: contenteditable div with role=textbox.
      document.querySelector<HTMLElement>('div[contenteditable="true"][role="textbox"]') ??
      // Claude uses ProseMirror under the hood.
      document.querySelector<HTMLElement>("div.ProseMirror") ??
      // Last-resort: any visible contenteditable.
      pickVisible(document.querySelectorAll<HTMLElement>('div[contenteditable="true"]')),
    findSendButton: () =>
      document.querySelector<HTMLButtonElement>('button[aria-label="Send message"]') ??
      document.querySelector<HTMLButtonElement>('button[aria-label="Send Message"]') ??
      document.querySelector<HTMLButtonElement>('button[aria-label*="Send"]') ??
      // The composer's submit-shaped button as last resort.
      document.querySelector<HTMLButtonElement>('button[type="submit"]:not([disabled])'),
  },
  chatgpt: {
    matches: (h) =>
      h === "chatgpt.com" || h.endsWith(".chatgpt.com") || h === "chat.openai.com" || h.endsWith(".chat.openai.com"),
    findInput: () =>
      document.querySelector<HTMLElement>('div#prompt-textarea[contenteditable="true"]') ??
      document.querySelector<HTMLElement>('div#prompt-textarea') ??
      document.querySelector<HTMLTextAreaElement>("textarea#prompt-textarea") ??
      pickVisible(document.querySelectorAll<HTMLElement>('div[contenteditable="true"]')) ??
      document.querySelector<HTMLTextAreaElement>("textarea"),
    findSendButton: () =>
      document.querySelector<HTMLButtonElement>('button[data-testid="send-button"]') ??
      document.querySelector<HTMLButtonElement>("#composer-submit-button") ??
      document.querySelector<HTMLButtonElement>('button[aria-label*="Send"]'),
  },
};

void run();

async function run(): Promise<void> {
  console.info("[thilko] chat-import script loaded on", location.hostname);
  let item: StashItem | undefined;
  try {
    const stash = await chrome.storage.session.get(STASH_KEY);
    item = stash[STASH_KEY] as StashItem | undefined;
  } catch (e) {
    console.warn("[thilko] chat-import: storage read failed", e);
    return;
  }
  if (!item || typeof item !== "object") {
    console.info("[thilko] chat-import: no stash, nothing to do");
    return;
  }
  if (typeof item.text !== "string" || item.text.length === 0) {
    console.info("[thilko] chat-import: stash had no text");
    return;
  }
  if (typeof item.ts !== "number" || Date.now() - item.ts > STALE_MS) {
    console.info("[thilko] chat-import: stash stale, dropping");
    void chrome.storage.session.remove(STASH_KEY);
    return;
  }

  const adapter = ADAPTERS[item.target];
  if (!adapter || !adapter.matches(location.hostname)) {
    console.info("[thilko] chat-import: target mismatch", { stashTarget: item.target, host: location.hostname });
    return;
  }
  console.info("[thilko] chat-import: stash found, target=", item.target, "len=", item.text.length);

  // Clear immediately so SPA route-changes inside the same chat don't
  // re-fire the paste on every navigation.
  try {
    await chrome.storage.session.remove(STASH_KEY);
  } catch {
    // ignore
  }

  // Wait for the composer to mount. SPAs render their composer 1-3 ticks
  // after first paint; an empty querySelector at document_idle is normal.
  const input = await waitFor(() => adapter.findInput(), INPUT_WAIT_MS);
  if (!input) {
    console.info("[thilko] chat-import: input not found, leaving text on clipboard");
    return;
  }
  console.info("[thilko] chat-import: input found", input.tagName, input.getAttribute("id") ?? input.className);

  insertText(input, item.text);

  // Give React a moment to enable the Send button after the input event.
  await sleep(SEND_DELAY_MS);

  const send = adapter.findSendButton();
  if (send && !send.disabled && send.getAttribute("aria-disabled") !== "true") {
    console.info("[thilko] chat-import: clicking send");
    send.click();
  } else {
    console.info("[thilko] chat-import: send button not ready, prefilled only", { found: !!send, disabled: send?.disabled });
  }
}

/** Insert text into either a contenteditable or a textarea, triggering the
 *  events React/Lexical/ProseMirror need to update their internal state. */
function insertText(el: HTMLElement, text: string): void {
  el.focus();

  if (el instanceof HTMLTextAreaElement) {
    // React tracks the textarea via a hidden value tracker; setting .value
    // directly doesn't notify the tracker. Use the native setter so React's
    // onChange fires.
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    if (setter) {
      setter.call(el, text);
    } else {
      el.value = text;
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return;
  }

  // contenteditable path — works for ProseMirror, Lexical, and plain CE divs.
  // execCommand is officially deprecated but remains the most reliable way
  // to drive these editors because it fires the full set of beforeinput +
  // input + selection events that they listen on.
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  const ok = document.execCommand("insertText", false, text);
  if (!ok) {
    // Fallback: drop the text directly. Some editors won't react but it's
    // better than nothing.
    el.textContent = text;
    el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
  }
}

/** Poll for a check to return truthy, up to `timeoutMs`. Returns null on timeout. */
function waitFor<T>(check: () => T | null, timeoutMs: number): Promise<T | null> {
  return new Promise((resolve) => {
    const found = check();
    if (found) {
      resolve(found);
      return;
    }
    const start = Date.now();
    const observer = new MutationObserver(() => {
      const v = check();
      if (v) {
        observer.disconnect();
        window.clearTimeout(timer);
        resolve(v);
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    const timer = window.setTimeout(() => {
      observer.disconnect();
      // Final attempt in case the mutation we needed predated the observer hookup.
      resolve(check() ?? null);
    }, timeoutMs - (Date.now() - start));
  });
}

function pickVisible(nodes: NodeListOf<HTMLElement>): HTMLElement | null {
  for (const n of nodes) {
    if (n.offsetParent !== null) return n;
  }
  return nodes[0] ?? null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
