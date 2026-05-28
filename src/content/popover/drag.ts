/**
 * Drag hook for the popover header.
 *
 * Uses Pointer Events so the same code path handles mouse, touch, and pen
 * input. Captures pointer to keep receiving events when the cursor leaves
 * the handle (essential for fast drags).
 *
 * The caller passes a ref to the host element (the one whose top/left we
 * actually mutate) and a ref to the drag handle (typically the popover
 * header). We mutate the host's `style.top`/`style.left` directly during
 * drag and call `onDragEnd` so the parent state can persist the new
 * position.
 */

import { useEffect, useRef } from "react";

export interface DragHandleOptions {
  handleRef: React.RefObject<HTMLElement | null>;
  hostElement: HTMLElement;
  onDragEnd: (next: { top: number; left: number }) => void;
}

interface DragState {
  pointerId: number;
  startX: number;
  startY: number;
  initialTop: number;
  initialLeft: number;
}

export function useDrag(opts: DragHandleOptions): void {
  const dragRef = useRef<DragState | null>(null);

  useEffect(() => {
    const handle = opts.handleRef.current;
    if (!handle) return;

    const onPointerDown = (e: PointerEvent) => {
      // Only primary button starts a drag.
      if (e.button !== 0 && e.pointerType === "mouse") return;
      if (dragRef.current) return; // already dragging

      // Don't start a drag from a button inside the handle (close/collapse).
      if ((e.target as Element).closest("button")) return;

      const host = opts.hostElement;
      const rect = host.getBoundingClientRect();
      dragRef.current = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        initialTop: rect.top,
        initialLeft: rect.left,
      };
      try {
        handle.setPointerCapture(e.pointerId);
      } catch {
        // setPointerCapture can throw on some browsers if pointer isn't active; ignore.
      }
      e.preventDefault();
    };

    const onPointerMove = (e: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || e.pointerId !== drag.pointerId) return;
      const dx = e.clientX - drag.startX;
      const dy = e.clientY - drag.startY;
      const nextTop = clamp(drag.initialTop + dy, 0, window.innerHeight - 40);
      const nextLeft = clamp(drag.initialLeft + dx, -200, window.innerWidth - 80);
      opts.hostElement.style.top = `${nextTop}px`;
      opts.hostElement.style.left = `${nextLeft}px`;
    };

    const onPointerUp = (e: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || e.pointerId !== drag.pointerId) return;
      dragRef.current = null;
      try {
        handle.releasePointerCapture(e.pointerId);
      } catch {
        // ignore
      }
      const rect = opts.hostElement.getBoundingClientRect();
      opts.onDragEnd({ top: rect.top, left: rect.left });
    };

    handle.addEventListener("pointerdown", onPointerDown);
    handle.addEventListener("pointermove", onPointerMove);
    handle.addEventListener("pointerup", onPointerUp);
    handle.addEventListener("pointercancel", onPointerUp);

    return () => {
      handle.removeEventListener("pointerdown", onPointerDown);
      handle.removeEventListener("pointermove", onPointerMove);
      handle.removeEventListener("pointerup", onPointerUp);
      handle.removeEventListener("pointercancel", onPointerUp);
    };
  }, [opts.handleRef, opts.hostElement, opts.onDragEnd]);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
