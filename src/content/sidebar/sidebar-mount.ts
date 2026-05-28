/**
 * Sidebar mount manager.
 *
 * Owns two shadow-DOM hosts:
 *   - Toggle button (bottom-right, always present when there are annotations)
 *   - Sidebar panel (right edge, only mounted while open)
 *
 * State (open/closed) lives here — the manager doesn't persist it across page
 * reloads (plan §6 M6 reviewer-check: "Toggle state persists per-article?
 * Decision: NO").
 *
 * The manager owns no business logic — render functions receive everything
 * via setState/setOpen, and row clicks bubble up via onNoteClick.
 */

import { createElement } from "react";
import { mountInShadow, type ShadowMount } from "../ui/shadow-mount.js";
import { Sidebar } from "./sidebar.js";
import { ToggleButton } from "./toggle-button.js";
import styleSheetCss from "../ui/styles.css?inline";
import { type SidebarState } from "./sidebar-state.js";
import type { HandoffResult } from "../../shared/claude-handoff.js";

export interface SidebarMountOptions {
  /** Called when the user clicks a row. Manager handles scroll + popover. */
  onNoteClick: (highlightId: string) => void;
  /** Optional handler for the header "Open in Claude" button. Returns the
   *  handoff result so the sidebar can show an inline toast. */
  onSendArticleToClaude?: () => Promise<HandoffResult>;
}

export interface SidebarMountHandle {
  /** Update the data being shown. Idempotent. */
  setState: (state: SidebarState) => void;
  /** Reflect open/closed in the toggle button + mount/unmount the panel. */
  setOpen: (open: boolean) => void;
  /** Toggle the open state. Returns the new state. */
  toggle: () => boolean;
  /** Cleanup all shadow hosts. */
  destroy: () => void;
}

export function mountSidebar(opts: SidebarMountOptions): SidebarMountHandle {
  let toggleMount: ShadowMount | null = null;
  let panelMount: ShadowMount | null = null;
  let currentState: SidebarState | null = null;
  let open = false;

  const ensureToggle = (): ShadowMount => {
    if (toggleMount) return toggleMount;
    toggleMount = mountInShadow({
      styles: styleSheetCss,
      hostClasses: ["thilko-sidebar-toggle-host"],
      hostStyle: {
        // Bottom-right anchor, leave the floating button to size itself.
        bottom: "20px",
        right: "20px",
        top: "auto",
        left: "auto",
        width: "auto",
        height: "auto",
      },
    });
    return toggleMount;
  };

  const ensurePanel = (): ShadowMount => {
    if (panelMount) return panelMount;
    panelMount = mountInShadow({
      styles: styleSheetCss,
      hostClasses: ["thilko-sidebar-panel-host"],
      hostStyle: {
        // Right-edge panel, full height. The component handles its own width.
        top: "0",
        right: "0",
        bottom: "0",
        left: "auto",
        width: "auto",
        height: "100vh",
      },
    });
    return panelMount;
  };

  const renderToggle = (): void => {
    if (!currentState) {
      // No state yet — don't show the button.
      toggleMount?.reactRoot.render(null);
      return;
    }
    const totalCount = currentState.live.length + currentState.orphans.length;
    if (totalCount === 0) {
      // Hide button if nothing to show. Keep the host alive (cheap) so future
      // renders are instant.
      toggleMount?.reactRoot.render(null);
      return;
    }
    const mount = ensureToggle();
    mount.reactRoot.render(
      createElement(ToggleButton, {
        count: totalCount,
        sidebarOpen: open,
        onClick: () => setOpen(!open),
      }),
    );
  };

  const renderPanel = (): void => {
    if (!open) {
      if (panelMount) {
        panelMount.reactRoot.render(null);
      }
      return;
    }
    if (!currentState) return;
    const mount = ensurePanel();
    mount.reactRoot.render(
      createElement(Sidebar, {
        state: currentState,
        onClose: () => setOpen(false),
        onNoteClick: opts.onNoteClick,
        onSendArticleToClaude: opts.onSendArticleToClaude,
      }),
    );
  };

  const setState = (state: SidebarState): void => {
    currentState = state;
    renderToggle();
    renderPanel();
  };

  const setOpen = (next: boolean): void => {
    if (open === next) return;
    open = next;
    renderToggle();
    renderPanel();
  };

  const toggle = (): boolean => {
    setOpen(!open);
    return open;
  };

  return {
    setState,
    setOpen,
    toggle,
    destroy: () => {
      toggleMount?.destroy();
      panelMount?.destroy();
      toggleMount = null;
      panelMount = null;
    },
  };
}
