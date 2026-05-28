/**
 * Local telemetry — ring buffer of the last N RPC operations.
 *
 * Lives in chrome.storage.local under "thilko_op_log". Capped at
 * MAX_ENTRIES so writes stay bounded. Each entry records a tiny summary
 * (kind, durationMs, ok-or-error-code) — never the request payload or
 * response body, since RPCs carry the user's notes and we don't want that
 * sitting in storage for debug purposes.
 *
 * Surfaced in the options page so the user can see what recent operations
 * have done — handy for "why isn't my highlight showing up?" without ever
 * sending data off-device. There is NO remote telemetry.
 */

export const MAX_OP_LOG_ENTRIES = 100;
const STORAGE_KEY = "thilko_op_log";

export interface OpLogEntry {
  /** Wall-clock ms at which the op resolved. */
  at: number;
  /** RPC kind, e.g. "createHighlight". */
  kind: string;
  /** Wall-clock ms duration of the dispatch. */
  durationMs: number;
  /** True on success, false on error. */
  ok: boolean;
  /** Error code on failure; omitted on success. */
  errorCode?: string;
}

export async function appendOpLog(entry: OpLogEntry): Promise<void> {
  try {
    const got = await chrome.storage.local.get(STORAGE_KEY);
    const existing: OpLogEntry[] = Array.isArray(got[STORAGE_KEY]) ? (got[STORAGE_KEY] as OpLogEntry[]) : [];
    const next = [...existing, entry];
    if (next.length > MAX_OP_LOG_ENTRIES) next.splice(0, next.length - MAX_OP_LOG_ENTRIES);
    await chrome.storage.local.set({ [STORAGE_KEY]: next });
  } catch (e) {
    // Best-effort — never let logging itself break dispatch.
    console.warn("[thilko] op-log append failed", e);
  }
}

export async function readOpLog(): Promise<OpLogEntry[]> {
  const got = await chrome.storage.local.get(STORAGE_KEY);
  const v = got[STORAGE_KEY];
  return Array.isArray(v) ? (v as OpLogEntry[]) : [];
}

export async function clearOpLog(): Promise<void> {
  await chrome.storage.local.remove(STORAGE_KEY);
}
