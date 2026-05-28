/**
 * Keyboard shortcuts for the selection toolbar.
 *
 *   Cmd/Ctrl + Shift + C → Comment on current selection
 *   Cmd/Ctrl + Shift + A → Ask AI on current selection (stubbed for M5)
 *
 * Handlers fire only when a valid selection exists per the trigger's
 * suppression rules.
 */

import { readCurrentSelection, type SelectionState } from "./trigger.js";
import { isInsideThilkoUi } from "../ui/shadow-mount.js";

export interface ShortcutsOptions {
  onComment: (state: SelectionState) => void;
  onAskAi: (state: SelectionState) => void;
}

export interface ShortcutsHandle {
  destroy: () => void;
}

export function installShortcuts(opts: ShortcutsOptions): ShortcutsHandle {
  const onKeydown = (e: KeyboardEvent) => {
    if (!e.shiftKey) return;
    const meta = e.metaKey || e.ctrlKey;
    if (!meta) return;
    const key = e.key.toLowerCase();
    if (key !== "c" && key !== "a") return;

    // Suppression: shortcut originating from inside an editable host or any
    // Thilko UI surface (popover textarea, etc.) must not hijack focus. The
    // shortcut is for highlighting *page text*, not for editing inputs.
    if (isFromEditableOrThilkoUi(e)) return;

    const state = readCurrentSelection();
    if (!state) return;

    e.preventDefault();
    e.stopPropagation();
    if (key === "c") opts.onComment(state);
    else opts.onAskAi(state);
  };

  document.addEventListener("keydown", onKeydown, true);

  return {
    destroy: () => document.removeEventListener("keydown", onKeydown, true),
  };
}

function isFromEditableOrThilkoUi(e: KeyboardEvent): boolean {
  // composedPath includes nodes inside shadow roots, which is essential for
  // detecting events that came from inside our own popover textarea.
  const path = typeof e.composedPath === "function" ? e.composedPath() : [];
  for (const node of path) {
    if (!(node instanceof Element)) continue;
    if (node.classList.contains("thilko-root")) return true;
    const tag = node.tagName.toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") return true;
    if ((node as HTMLElement).isContentEditable) return true;
    if (node.getAttribute("role") === "textbox") return true;
  }
  // Fallback for browsers without composedPath: check the target + active element.
  const t = e.target as Node | null;
  if (t instanceof Element && isInsideThilkoUi(t)) return true;
  const ae = document.activeElement;
  if (ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || (ae as HTMLElement).isContentEditable)) return true;
  return false;
}
