/**
 * Throwaway debug probe — investigates whether Chrome's native PDF viewer
 * surfaces text selections and events to our parent content script.
 *
 * Activates only when the document is a PDF (Chrome's PDF viewer wraps the
 * tab in a small HTML page with an embed pointing at chrome-extension://
 * mhjfbmdgc...). We then probe:
 *
 *   1. Frame tree — what's the actual DOM structure?
 *   2. Selection events — does selectionchange fire on parent when user
 *      selects text inside the PDF viewer iframe?
 *   3. Mouse events — do mouseup/click bubble up?
 *   4. window.getSelection() polling — does the parent's selection ever
 *      reflect what's selected in the PDF?
 *   5. Inbound postMessage — does the PDF viewer send any messages?
 *   6. Outbound postMessage — does the PDF viewer respond to common
 *      command shapes (documentLoaded, selectionChanged, viewport, etc.)?
 *
 * All logs are tagged `[thilko-probe]` — easy to filter in DevTools.
 *
 * To run: load the probe build with DNR redirect disabled, navigate to
 * https://arxiv.org/pdf/<paper>, open DevTools console, screenshot.
 *
 * DELETE this file (and its manifest entry) before shipping a real release.
 */

const TAG = "[thilko-probe]";

function isPdfContext(): boolean {
  if (document.contentType === "application/pdf") return true;
  if (document.querySelector('embed[type="application/pdf"]')) return true;
  if (/\.pdf(?:[?#]|$)/i.test(location.pathname)) return true;
  if (/\/pdf\//i.test(location.pathname)) return true;
  return false;
}

function probeNow() {
  if (!isPdfContext()) return;

  console.group(TAG + " activated");
  console.log("URL:", location.href);
  console.log("Origin:", location.origin);
  console.log("document.contentType:", document.contentType);
  console.log("readyState:", document.readyState);
  console.log("Top frame === self?", window.top === window.self);
  console.log("Has embed[type=application/pdf]?", !!document.querySelector('embed[type="application/pdf"]'));
  console.groupEnd();

  logFrameTree();

  // Arm event listeners NOW so even early selections register.
  armListeners();

  // Wait for embed to mount + load PDF before doing the outbound postMessage probes.
  setTimeout(probeEmbed, 1500);
  setTimeout(probeEmbed, 4000); // and again, in case PDF loaded later
}

function logFrameTree() {
  console.group(TAG + " frame tree");
  console.log("window.frames.length:", window.frames.length);
  for (let i = 0; i < window.frames.length; i++) {
    try {
      const f = window.frames[i]!;
      console.log(`frame[${i}].location.href:`, f.location.href, "origin:", f.location.origin);
    } catch (e) {
      console.log(`frame[${i}] cross-origin (expected for PDF viewer iframe):`, (e as Error).message);
    }
  }
  document.querySelectorAll("embed, iframe, object").forEach((el, i) => {
    const node = el as HTMLIFrameElement;
    console.log(`embed/iframe/object[${i}]:`, el.tagName, {
      src: node.src ?? node.getAttribute("src"),
      type: el.getAttribute("type"),
      name: el.getAttribute("name"),
    });
  });
  console.groupEnd();
}

let armed = false;
function armListeners() {
  if (armed) return;
  armed = true;

  let selChangeCount = 0;
  document.addEventListener("selectionchange", () => {
    selChangeCount++;
    const sel = document.getSelection();
    const text = sel?.toString() ?? "";
    // Log first few + any non-empty.
    if (text.length > 0 || selChangeCount <= 3) {
      console.log(
        `${TAG} selectionchange #${selChangeCount} — parent text="${text.slice(0, 80)}" length=${text.length}`,
      );
    }
  });

  let mouseupCount = 0;
  window.addEventListener("mouseup", (e) => {
    mouseupCount++;
    if (mouseupCount <= 8) {
      const target = e.target as Element | null;
      console.log(
        `${TAG} mouseup #${mouseupCount} on parent — target=${target?.tagName ?? "null"}`,
        target,
      );
    }
  }, true);

  let clickCount = 0;
  window.addEventListener("click", (e) => {
    clickCount++;
    if (clickCount <= 8) {
      console.log(`${TAG} click #${clickCount} on parent — target=`, e.target);
    }
  }, true);

  window.addEventListener("message", (e: MessageEvent) => {
    const dataStr = (() => {
      try { return JSON.stringify(e.data).slice(0, 200); } catch { return String(e.data).slice(0, 200); }
    })();
    console.log(`${TAG} INBOUND postMessage from ${e.origin}: ${dataStr}`);
  });

  // Poll the parent's selection every 1s for 30s — confirms whether parent
  // ever observes the user's PDF selection.
  let pollCount = 0;
  const pollHandle = setInterval(() => {
    pollCount++;
    const text = document.getSelection()?.toString() ?? "";
    if (text.length > 0) {
      console.log(`${TAG} poll #${pollCount} — parent selection NON-EMPTY: "${text.slice(0, 120)}"`);
    } else if (pollCount % 5 === 0) {
      console.log(`${TAG} poll #${pollCount} — parent selection empty`);
    }
    if (pollCount >= 30) clearInterval(pollHandle);
  }, 1000);

  console.log(TAG + " listeners armed (selectionchange, mouseup, click, message, polling).");
}

function probeEmbed() {
  const embeds = document.querySelectorAll("embed, iframe");
  if (embeds.length === 0) {
    console.log(TAG + " probeEmbed: no embeds found yet");
    return;
  }
  embeds.forEach((el, i) => {
    const win = (el as HTMLIFrameElement).contentWindow;
    if (!win) {
      console.log(`${TAG} embed[${i}]: no contentWindow`);
      return;
    }
    console.log(`${TAG} OUTBOUND probes to embed[${i}]…`);
    const probes: unknown[] = [
      { type: "getSelection" },
      { type: "getSelectedText" },
      { type: "selection" },
      { type: "selectionChanged" },
      { type: "documentLoaded" },
      { type: "viewport" },
      { type: "getNamedDestination" },
      { type: "stopScrolling" },
      { type: "getPlugin" },
      { type: "getInternalApi" },
      // Bare-string commands (older Chromium PDF viewer style)
      "getSelection",
      "documentLoaded",
      "selectionChanged",
    ];
    probes.forEach((p) => {
      try {
        win.postMessage(p, "*");
      } catch (e) {
        console.log(`${TAG} embed[${i}] postMessage(${JSON.stringify(p)}) threw:`, (e as Error).message);
      }
    });
  });
  console.log(TAG + " outbound probes sent. Any reply will log as INBOUND postMessage above.");
}

// document.contentType for PDFs is available very early; armListeners is
// safe to attach immediately.
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", probeNow);
} else {
  probeNow();
}
