/**
 * Helpers for mounting React UIs in shadow DOM hosts.
 *
 * Every Thilko floating widget (selection toolbar, popovers, future sidebar)
 * lives inside its own shadow root attached to a host <div> on document.body.
 * Shadow DOM gives us:
 *   - hard style isolation (host CSS can't leak in; ours can't leak out)
 *   - independent stacking contexts (we set z-index inside the shadow)
 *
 * The host element gets a `class="thilko-root"` so selection-toolbar
 * suppression can detect "user clicked inside our own UI."
 */

import { createRoot, type Root } from "react-dom/client";

export interface ShadowMount {
  host: HTMLElement;
  shadow: ShadowRoot;
  reactRoot: Root;
  /** Unmount + remove from DOM. Idempotent. */
  destroy: () => void;
}

export interface MountOptions {
  /** CSS to inject into the shadow root. */
  styles: string;
  /** Optional id to set on the host element. */
  hostId?: string;
  /**
   * Extra class names for the host. The class `thilko-root` is always added.
   * `thilko-popover-host`, `thilko-toolbar-host` are useful for finding them.
   */
  hostClasses?: string[];
  /**
   * Inline styles applied to the HOST (positioning is host-level — the inner
   * React tree just renders a card; the host places it on screen).
   */
  hostStyle?: Partial<CSSStyleDeclaration>;
}

export function mountInShadow(opts: MountOptions): ShadowMount {
  const host = document.createElement("div");
  host.classList.add("thilko-root", ...(opts.hostClasses ?? []));
  if (opts.hostId) host.id = opts.hostId;

  // Default host CSS so the floating widget doesn't push layout around. The
  // shadow root provides its own styles for everything inside.
  Object.assign(host.style, {
    position: "fixed",
    zIndex: "2147483646", // one below max so DevTools picker still wins
    top: "0",
    left: "0",
    width: "0",
    height: "0",
    pointerEvents: "none", // children re-enable pointer events as needed
    contain: "layout style",
  } satisfies Partial<CSSStyleDeclaration>);
  if (opts.hostStyle) Object.assign(host.style, opts.hostStyle);

  const shadow = host.attachShadow({ mode: "open" });

  const styleEl = document.createElement("style");
  styleEl.textContent = opts.styles;
  shadow.appendChild(styleEl);

  const mountPoint = document.createElement("div");
  mountPoint.className = "thilko-mount";
  shadow.appendChild(mountPoint);

  document.body.appendChild(host);

  const reactRoot = createRoot(mountPoint);

  let destroyed = false;
  return {
    host,
    shadow,
    reactRoot,
    destroy: () => {
      if (destroyed) return;
      destroyed = true;
      try {
        reactRoot.unmount();
      } catch (e) {
        console.warn("[thilko] unmount failed", e);
      }
      host.remove();
    },
  };
}

/** Walks ancestors to determine if a node lives inside any Thilko shadow host. */
export function isInsideThilkoUi(node: Node | null): boolean {
  let n: Node | null = node;
  while (n) {
    if (n instanceof Element && n.classList?.contains("thilko-root")) return true;
    n = (n.parentNode ?? (n as Node & { host?: Node }).host) ?? null;
  }
  return false;
}
