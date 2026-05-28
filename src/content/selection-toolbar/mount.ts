/**
 * Mounts the selection toolbar in a shadow host on document.body and shows
 * / hides / repositions it based on the current selection.
 *
 * One toolbar instance per content-script lifecycle. The host element is
 * created lazily on first show.
 */

import { createElement } from "react";
import { mountInShadow, type ShadowMount } from "../ui/shadow-mount.js";
import { placeNear, rangeAnchorRect } from "../ui/positioning.js";
import { SelectionToolbar } from "./toolbar.js";
import styleSheetCss from "../ui/styles.css?inline";
import { type SelectionState } from "./trigger.js";

export interface ToolbarMountOptions {
  onComment: (state: SelectionState) => Promise<void> | void;
  onAskAi: (state: SelectionState) => Promise<void> | void;
}

export interface ToolbarMountHandle {
  show: (state: SelectionState) => void;
  hide: () => void;
  destroy: () => void;
}

const TOOLBAR_WIDTH = 220;
const TOOLBAR_HEIGHT = 44;

export function mountSelectionToolbar(opts: ToolbarMountOptions): ToolbarMountHandle {
  let mount: ShadowMount | null = null;
  let currentState: SelectionState | null = null;
  let busy = false;

  const ensureMount = (): ShadowMount => {
    if (mount) return mount;
    mount = mountInShadow({
      styles: styleSheetCss,
      hostClasses: ["thilko-toolbar-host"],
      hostStyle: {
        width: `${TOOLBAR_WIDTH}px`,
        height: `${TOOLBAR_HEIGHT}px`,
        top: "-9999px",
        left: "-9999px",
      },
    });
    return mount;
  };

  const render = () => {
    if (!mount) return;
    if (!currentState) {
      mount.reactRoot.render(null);
      return;
    }
    const text = currentState.text;
    const onCommentClick = async (): Promise<void> => {
      const snapshot = currentState;
      if (!snapshot || busy) return;
      busy = true;
      render();
      try {
        await opts.onComment(snapshot);
      } catch (e) {
        console.warn("[thilko] toolbar comment handler threw", e);
      } finally {
        busy = false;
        render();
      }
    };
    const onAskAiClick = (): void => {
      if (!currentState || busy) return;
      const snapshot = currentState;
      Promise.resolve(opts.onAskAi(snapshot)).catch((e) =>
        console.warn("[thilko] toolbar ask-ai handler threw", e),
      );
    };
    mount.reactRoot.render(
      createElement(SelectionToolbar, { selectionText: text, onComment: onCommentClick, onAskAi: onAskAiClick, busy }),
    );
  };

  const show = (state: SelectionState): void => {
    currentState = state;
    const m = ensureMount();
    const anchor = rangeAnchorRect(state.range);
    if (!anchor) {
      m.host.style.top = "-9999px";
      m.host.style.left = "-9999px";
      return;
    }
    const place = placeNear(anchor, {
      preferred: "above",
      width: TOOLBAR_WIDTH,
      height: TOOLBAR_HEIGHT,
    });
    m.host.style.top = `${place.top}px`;
    m.host.style.left = `${place.left}px`;
    render();
  };

  const hide = (): void => {
    currentState = null;
    if (!mount) return;
    mount.host.style.top = "-9999px";
    mount.host.style.left = "-9999px";
    mount.reactRoot.render(null);
  };

  return {
    show,
    hide,
    destroy: () => {
      currentState = null;
      mount?.destroy();
      mount = null;
    },
  };
}
