/**
 * Periodic connection check.
 *
 * Uses chrome.alarms (survives Chrome service-worker termination) so the
 * connection indicator stays accurate even when the SW has been evicted.
 *
 * Two-stage probe:
 *   1. POST /memory/ping — auth-only, no Supermemory traffic. Validates the
 *      PROXY_SECRET + slot. 401 here means wrong secret; 400 means bad slot.
 *      This is what catches "user typed the secret wrong".
 *   2. GET /health — unchanged existing endpoint. Surfaces Codex token state
 *      so we can tell the user their token has expired (separate failure
 *      from secret being wrong).
 *
 * Result is broadcast into chrome.storage.session so other surfaces (options
 * page, future library page) can read it without re-fetching.
 */

import { type ConnectionStatus } from "../shared/types.js";
import { loadSettings } from "../shared/settings.js";
import { health, ping, ProxyApiError } from "../shared/proxy-api.js";
import { applyConnectionStatusToIcon } from "./icon-state.js";

const ALARM_NAME = "thilko-health-check";
const HEALTH_INTERVAL_MIN = 1; // chrome.alarms minimum granularity.

const SESSION_KEY = "thilko_connection_status";

/**
 * Exponential backoff between failed checks.
 *
 * The chrome.alarms minimum granularity is 1 minute, which is too slow for the
 * user-visible "Backend unreachable" recovery. On a transient-cause failure
 * (network / timeout / unknown) we schedule a faster setTimeout retry on the
 * ladder below — capped at 30s. On the next success we reset the counter
 * back to 0 and let the 1-minute alarm cadence take over.
 *
 * setTimeout in a service worker only fires while the SW is alive; that's OK
 * because the chrome.alarm fires every minute regardless, so we're guaranteed
 * eventual recovery — the backoff just shortens the first few retries.
 *
 * Causes that ARE user-config errors (auth, slot, token) are NOT retried hot:
 * the user must fix settings, and a hot loop would only burn CPU.
 */
const BACKOFF_LADDER_MS = [1000, 2000, 4000, 8000, 16000, 30000] as const;
let consecutiveFailures = 0;
let backoffTimer: ReturnType<typeof setTimeout> | null = null;

function isTransientCause(c: Extract<ConnectionStatus, { kind: "down" }>["cause"]): boolean {
  return c === "network" || c === "timeout" || c === "unknown";
}

function scheduleBackoffRetry(): void {
  if (backoffTimer !== null) {
    clearTimeout(backoffTimer);
    backoffTimer = null;
  }
  const idx = Math.min(consecutiveFailures - 1, BACKOFF_LADDER_MS.length - 1);
  const delay = BACKOFF_LADDER_MS[Math.max(0, idx)] ?? 30000;
  backoffTimer = setTimeout(() => {
    backoffTimer = null;
    runHealthCheck().catch((e) => console.warn("[thilko] backoff retry failed", e));
  }, delay);
}

function clearBackoff(): void {
  consecutiveFailures = 0;
  if (backoffTimer !== null) {
    clearTimeout(backoffTimer);
    backoffTimer = null;
  }
}

export async function getConnectionStatus(): Promise<ConnectionStatus> {
  const got = await chrome.storage.session.get(SESSION_KEY);
  const v = got[SESSION_KEY];
  if (v && typeof v === "object" && "kind" in v) {
    return v as ConnectionStatus;
  }
  return { kind: "unconfigured" };
}

async function storeAndApply(status: ConnectionStatus): Promise<void> {
  await chrome.storage.session.set({ [SESSION_KEY]: status });
  try {
    await applyConnectionStatusToIcon(status);
  } catch (e) {
    console.warn("[thilko] icon update failed", e);
  }
}

/** Run a single connection check now. Safe to call at any time. */
export async function runHealthCheck(): Promise<ConnectionStatus> {
  const settings = await loadSettings();
  if (!settings) {
    const status: ConnectionStatus = { kind: "unconfigured" };
    clearBackoff();
    await storeAndApply(status);
    return status;
  }

  const creds = {
    proxyUrl: settings.proxyUrl,
    proxySecret: settings.proxySecret,
    slot: settings.slot,
  };
  const now = Date.now();

  // Stage 1: ping → validates secret + slot.
  let memoryReady = false;
  try {
    const p = await ping(creds);
    memoryReady = p.memoryReady;
  } catch (e) {
    const status = classifyDown(e, now);
    consecutiveFailures++;
    if (status.kind === "down" && isTransientCause(status.cause)) {
      scheduleBackoffRetry();
    }
    await storeAndApply(status);
    return status;
  }

  // Stage 2: /health → Codex token state.
  try {
    const h = await health(creds);
    if (!h.ok || !h.tokenValid) {
      const reason = h.tokenExpiresAt
        ? `Codex token expired (was ${h.tokenExpiresAt}). Re-run \`codex login\` on the proxy host.`
        : "Codex token reports invalid.";
      const status: ConnectionStatus = {
        kind: "down",
        lastCheckedAt: now,
        reason,
        cause: "token",
      };
      // Token state is a user-config issue (proxy admin must re-login) — no
      // hot retry; let the 1-minute alarm pick it up.
      consecutiveFailures++;
      await storeAndApply(status);
      return status;
    }
    const status: ConnectionStatus = {
      kind: "ok",
      lastCheckedAt: now,
      tokenExpiresInSeconds: h.expiresInSeconds ?? null,
      memoryReady,
    };
    clearBackoff();
    await storeAndApply(status);
    return status;
  } catch (e) {
    const status = classifyDown(e, now);
    consecutiveFailures++;
    if (status.kind === "down" && isTransientCause(status.cause)) {
      scheduleBackoffRetry();
    }
    await storeAndApply(status);
    return status;
  }
}

function classifyDown(e: unknown, at: number): ConnectionStatus {
  if (e instanceof ProxyApiError) {
    if (e.status === 401) {
      return { kind: "down", lastCheckedAt: at, reason: "Bad PROXY_SECRET", cause: "auth" };
    }
    if (e.status === 400 && e.code === "invalid_slot") {
      return { kind: "down", lastCheckedAt: at, reason: "Slot rejected by proxy", cause: "slot" };
    }
    if (e.code === "timeout") {
      return { kind: "down", lastCheckedAt: at, reason: "Proxy did not respond", cause: "timeout" };
    }
    if (e.code === "network" || e.status === 0) {
      return { kind: "down", lastCheckedAt: at, reason: "Proxy unreachable", cause: "network" };
    }
    return { kind: "down", lastCheckedAt: at, reason: `${e.code} (${e.status})`, cause: "unknown" };
  }
  const msg = e instanceof Error ? e.message : String(e);
  return { kind: "down", lastCheckedAt: at, reason: msg, cause: "unknown" };
}

/** Ensure the periodic check alarm is registered. Idempotent. */
export async function ensureHealthAlarm(): Promise<void> {
  const existing = await chrome.alarms.get(ALARM_NAME);
  if (existing && existing.periodInMinutes === HEALTH_INTERVAL_MIN) return;
  await chrome.alarms.create(ALARM_NAME, {
    periodInMinutes: HEALTH_INTERVAL_MIN,
    delayInMinutes: 0,
  });
}

export function registerHealthAlarmHandler(): void {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== ALARM_NAME) return;
    runHealthCheck().catch((e) => console.error("[thilko] scheduled connection check failed", e));
  });
}
