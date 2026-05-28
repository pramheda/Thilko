/**
 * Settings storage + validation.
 *
 * Persisted in chrome.storage.sync so the user's config (proxy URL, secret,
 * slot) syncs across their Chrome installs. Multi-user later swaps the form
 * for an OAuth flow that writes the same shape — no data-model change.
 */

import { z } from "zod";
import { type Settings, DEFAULT_EXCLUSION_DOMAINS } from "./types.js";

const SLOT_RE = /^[a-zA-Z0-9_-]{1,32}$/;

export const SettingsSchema = z.object({
  proxyUrl: z
    .string()
    .min(1, "Proxy URL is required")
    .refine(
      (v) => {
        try {
          const u = new URL(v);
          return u.protocol === "http:" || u.protocol === "https:";
        } catch {
          return false;
        }
      },
      { message: "Must be a valid http(s) URL" },
    ),
  proxySecret: z.string().min(1, "Proxy secret is required"),
  slot: z
    .string()
    .min(1, "Slot is required")
    .regex(SLOT_RE, "Slot must be 1–32 chars, alphanumeric/hyphen/underscore"),
  exclusionDomains: z.array(z.string()).default([...DEFAULT_EXCLUSION_DOMAINS]),
  localhostEnabled: z.boolean().default(false),
  devMode: z.boolean().default(false),
  autoPersistHighlights: z.boolean().default(false),
});

export type ValidatedSettings = z.infer<typeof SettingsSchema>;

const STORAGE_KEY = "thilko_settings_v1";

/** Read settings, validating shape. Returns null if unset or invalid. */
export async function loadSettings(): Promise<ValidatedSettings | null> {
  const raw = await chrome.storage.sync.get(STORAGE_KEY);
  const stored = raw[STORAGE_KEY];
  if (!stored) return null;
  const parsed = SettingsSchema.safeParse(stored);
  if (!parsed.success) {
    console.warn("[thilko] settings failed validation; treating as unconfigured", parsed.error);
    return null;
  }
  return parsed.data;
}

/** Persist settings. Throws on validation failure (caller should validate first). */
export async function saveSettings(input: Settings): Promise<ValidatedSettings> {
  const parsed = SettingsSchema.parse(input); // throws ZodError on invalid
  // Normalize: strip trailing slash on proxyUrl, lower-case host.
  parsed.proxyUrl = normalizeProxyUrl(parsed.proxyUrl);
  await chrome.storage.sync.set({ [STORAGE_KEY]: parsed });
  return parsed;
}

export async function clearSettings(): Promise<void> {
  await chrome.storage.sync.remove(STORAGE_KEY);
}

/**
 * Subscribe to settings changes from any extension surface. The callback
 * receives the new validated settings (or null if removed/cleared).
 *
 * Returns an unsubscribe function.
 */
export function onSettingsChange(cb: (s: ValidatedSettings | null) => void): () => void {
  const listener = (
    changes: { [key: string]: chrome.storage.StorageChange },
    areaName: chrome.storage.AreaName,
  ): void => {
    if (areaName !== "sync") return;
    const change = changes[STORAGE_KEY];
    if (!change) return;
    const next = change.newValue;
    if (next === undefined) {
      cb(null);
      return;
    }
    const parsed = SettingsSchema.safeParse(next);
    cb(parsed.success ? parsed.data : null);
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

function normalizeProxyUrl(input: string): string {
  try {
    const u = new URL(input);
    u.hash = "";
    u.search = "";
    if (u.pathname.length > 1 && u.pathname.endsWith("/")) {
      u.pathname = u.pathname.replace(/\/+$/, "");
    }
    return u.toString().replace(/\/$/, "");
  } catch {
    return input;
  }
}
