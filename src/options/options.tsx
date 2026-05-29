/**
 * Options page — first-run setup and ongoing configuration.
 *
 * Single form (proxy URL, secret, slot) with inline validation, a Test
 * Connection button that hits /health via background RPC, and a Save
 * button that persists to chrome.storage.sync. Connection status is shown
 * in real time and updates whenever the background SW reruns its health
 * check.
 */

import { StrictMode, useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { z } from "zod";
import "./options.css";
import {
  loadSettings,
  saveSettings,
  SettingsSchema,
  onSettingsChange,
  type ValidatedSettings,
} from "../shared/settings.js";
import { type ConnectionStatus, DEFAULT_EXCLUSION_DOMAINS } from "../shared/types.js";
import { type RpcRequest, type RpcResponse } from "../shared/messages.js";

interface FormState {
  proxyUrl: string;
  proxySecret: string;
  slot: string;
  devMode: boolean;
  exclusionDomains: string[];
  localhostEnabled: boolean;
  autoPersistHighlights: boolean;
  pdfAutoRedirect: boolean;
}

interface FormErrors {
  proxyUrl?: string;
  proxySecret?: string;
  slot?: string;
}

type ToastKind = "ok" | "error" | "info";
interface Toast {
  kind: ToastKind;
  text: string;
}

async function rpc<T = unknown>(req: RpcRequest): Promise<T> {
  const r = (await chrome.runtime.sendMessage(req)) as RpcResponse | undefined;
  if (!r) throw new Error("Background did not respond");
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.data as T;
}

/**
 * Parse one of: a full magic-link URL, a `?claim=…` query string, a `#claim=…`
 * hash fragment, or a bare `t_…` token. Returns the origin (proxy URL) and
 * the token, or null if nothing usable was found. The origin defaults to
 * `https://thilko.yesh.is` when the user pastes just a bare token.
 */
function parseClaimInput(input: string): { origin: string; token: string; raw: string } | null {
  const raw = input.trim();
  if (raw.length === 0) return null;

  // Bare token, no URL
  if (/^t_[A-Za-z0-9_-]{22}$/.test(raw)) {
    return { origin: "https://thilko.yesh.is", token: raw, raw };
  }

  // Full URL form: https://thilko.yesh.is/?claim=t_…  (or with hash form)
  try {
    if (raw.startsWith("http://") || raw.startsWith("https://")) {
      const u = new URL(raw);
      const t = u.searchParams.get("claim") ?? new URLSearchParams(u.hash.replace(/^#/, "")).get("claim");
      if (t && /^t_[A-Za-z0-9_-]{22}$/.test(t)) {
        return { origin: u.origin, token: t, raw };
      }
    }
  } catch {
    /* fall through */
  }

  // Loose: `?claim=…` or `#claim=…` from a paste
  const stripped = raw.replace(/^[#?]+/, "");
  const pairs = new URLSearchParams(stripped);
  const t = pairs.get("claim");
  if (t && /^t_[A-Za-z0-9_-]{22}$/.test(t)) {
    return { origin: "https://thilko.yesh.is", token: t, raw };
  }

  return null;
}

function validateForm(form: FormState): FormErrors {
  const errors: FormErrors = {};
  const parsed = SettingsSchema.pick({
    proxyUrl: true,
    proxySecret: true,
    slot: true,
  }).safeParse(form);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const key = issue.path[0];
      if (key === "proxyUrl" || key === "proxySecret" || key === "slot") {
        errors[key] = errors[key] ?? issue.message;
      }
    }
  }
  return errors;
}

function App() {
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<FormState>({
    proxyUrl: "",
    proxySecret: "",
    slot: "",
    devMode: false,
    exclusionDomains: [...DEFAULT_EXCLUSION_DOMAINS],
    localhostEnabled: false,
    autoPersistHighlights: false,
    pdfAutoRedirect: false,
  });
  const [newDomain, setNewDomain] = useState("");
  const [showSecret, setShowSecret] = useState(false);
  const [touched, setTouched] = useState<Partial<Record<keyof FormState, boolean>>>({});
  const [status, setStatus] = useState<ConnectionStatus>({ kind: "unconfigured" });
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const [originalLoaded, setOriginalLoaded] = useState<ValidatedSettings | null>(null);

  // Initial load.
  useEffect(() => {
    (async () => {
      const [settings, current] = await Promise.all([
        loadSettings(),
        rpc<ConnectionStatus>({ kind: "getConnectionStatus" }).catch(() => ({ kind: "unconfigured" } as ConnectionStatus)),
      ]);
      if (settings) {
        setForm({
          proxyUrl: settings.proxyUrl,
          proxySecret: settings.proxySecret,
          slot: settings.slot,
          devMode: settings.devMode,
          exclusionDomains: settings.exclusionDomains,
          localhostEnabled: settings.localhostEnabled,
          autoPersistHighlights: settings.autoPersistHighlights,
          pdfAutoRedirect: settings.pdfAutoRedirect,
        });
        setOriginalLoaded(settings);
      }
      setStatus(current);
      setLoading(false);
    })();
  }, []);

  // Subscribe to settings changes (e.g. another tab edited them).
  useEffect(() => onSettingsChange((s) => {
    if (s) {
      setForm({
        proxyUrl: s.proxyUrl,
        proxySecret: s.proxySecret,
        slot: s.slot,
        devMode: s.devMode,
        exclusionDomains: s.exclusionDomains,
        localhostEnabled: s.localhostEnabled,
        autoPersistHighlights: s.autoPersistHighlights,
        pdfAutoRedirect: s.pdfAutoRedirect,
      });
      setOriginalLoaded(s);
    } else {
      setForm({
        proxyUrl: "",
        proxySecret: "",
        slot: "",
        devMode: false,
        exclusionDomains: [...DEFAULT_EXCLUSION_DOMAINS],
        localhostEnabled: false,
        autoPersistHighlights: false,
        pdfAutoRedirect: false,
      });
      setOriginalLoaded(null);
    }
  }), []);

  // Poll connection status periodically (background SW updates it).
  useEffect(() => {
    const id = setInterval(async () => {
      try {
        const s = await rpc<ConnectionStatus>({ kind: "getConnectionStatus" });
        setStatus(s);
      } catch {
        // ignore — non-fatal
      }
    }, 4000);
    return () => clearInterval(id);
  }, []);

  // Auto-dismiss toasts.
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(id);
  }, [toast]);

  // Magic-link auto-claim: if the options page was opened with
  // `?claim=<token>` or `#claim=<token>` in its URL, run the claim flow
  // automatically once on mount. Friends who get a magic-link DM from the
  // admin can land here pre-configured without ever pasting a secret.
  const [claimInput, setClaimInput] = useState("");
  const [claiming, setClaiming] = useState(false);
  const [claimMsg, setClaimMsg] = useState<{ kind: "ok" | "err" | "info"; text: string } | null>(null);

  const runClaim = useCallback(async (rawInput: string): Promise<boolean> => {
    setClaiming(true);
    setClaimMsg(null);
    try {
      const parsed = parseClaimInput(rawInput);
      if (!parsed) {
        setClaimMsg({ kind: "err", text: "Couldn't read that — paste the full magic-link URL or just the t_… token." });
        return false;
      }
      const res = await fetch(`${parsed.origin}/onboard/claim`, {
        method: "POST",
        mode: "cors",
        credentials: "omit",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: parsed.token }),
      });
      const data = await res.json().catch(() => ({})) as { ok?: boolean; proxyUrl?: string; secret?: string; slot?: string; error?: { code: string; message: string } };
      if (!res.ok || !data.ok || !data.proxyUrl || !data.secret || !data.slot) {
        setClaimMsg({ kind: "err", text: data.error?.message ?? `Claim failed (${res.status}).` });
        return false;
      }
      // Build a clean settings object and persist via the existing saver so the
      // SW picks it up + the form reflects the new values.
      const next = SettingsSchema.parse({
        proxyUrl: data.proxyUrl,
        proxySecret: data.secret,
        slot: data.slot,
        devMode: form.devMode,
        exclusionDomains: form.exclusionDomains,
        localhostEnabled: form.localhostEnabled,
        autoPersistHighlights: form.autoPersistHighlights,
        pdfAutoRedirect: form.pdfAutoRedirect,
      });
      await saveSettings(next);
      setForm({
        proxyUrl: next.proxyUrl,
        proxySecret: next.proxySecret,
        slot: next.slot,
        devMode: next.devMode,
        exclusionDomains: next.exclusionDomains,
        localhostEnabled: next.localhostEnabled,
        autoPersistHighlights: next.autoPersistHighlights,
        pdfAutoRedirect: next.pdfAutoRedirect,
      });
      setOriginalLoaded(next);
      setClaimMsg({ kind: "ok", text: `Connected to slot "${data.slot}". Testing connection…` });
      // Verify connection so the friend gets a green dot immediately.
      try {
        const status = await rpc<ConnectionStatus>({ kind: "recheckConnection" });
        setStatus(status);
      } catch {
        // non-fatal — the SW poll will catch up
      }
      return true;
    } catch (e) {
      setClaimMsg({ kind: "err", text: e instanceof Error ? e.message : "Claim failed." });
      return false;
    } finally {
      setClaiming(false);
    }
  }, [form.devMode, form.exclusionDomains, form.localhostEnabled, form.autoPersistHighlights, form.pdfAutoRedirect]);

  // Auto-claim if the page was opened with a claim token in the URL.
  useEffect(() => {
    const fromHash = parseClaimInput(window.location.hash);
    const fromSearch = parseClaimInput(window.location.search);
    const parsed = fromHash ?? fromSearch;
    if (!parsed) return;
    // Strip the claim from the URL so a refresh doesn't re-fire.
    try {
      const cleanUrl = window.location.pathname;
      window.history.replaceState({}, "", cleanUrl);
    } catch {
      /* ignore */
    }
    void runClaim(parsed.raw);
    // intentionally run-once
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const errors = useMemo(() => validateForm(form), [form]);
  const formValid = Object.values(errors).every((e) => !e);
  const isDirty = useMemo(() => {
    if (!originalLoaded) return form.proxyUrl !== "" || form.proxySecret !== "" || form.slot !== "" || form.devMode || form.autoPersistHighlights || form.pdfAutoRedirect;
    return (
      originalLoaded.proxyUrl !== form.proxyUrl ||
      originalLoaded.proxySecret !== form.proxySecret ||
      originalLoaded.slot !== form.slot ||
      originalLoaded.devMode !== form.devMode ||
      originalLoaded.localhostEnabled !== form.localhostEnabled ||
      originalLoaded.autoPersistHighlights !== form.autoPersistHighlights ||
      originalLoaded.pdfAutoRedirect !== form.pdfAutoRedirect ||
      !sameDomains(originalLoaded.exclusionDomains, form.exclusionDomains)
    );
  }, [originalLoaded, form]);

  const updateField = useCallback((key: keyof FormState, value: string) => {
    setForm((f) => ({ ...f, [key]: value }));
  }, []);

  const onBlur = useCallback((key: keyof FormState) => {
    setTouched((t) => ({ ...t, [key]: true }));
  }, []);

  const testConnection = useCallback(async () => {
    setTesting(true);
    setToast(null);
    try {
      // Save first so the background SW reads the new credentials.
      const parsed = SettingsSchema.parse({
        ...form,
        exclusionDomains: form.exclusionDomains,
        localhostEnabled: form.localhostEnabled,
        devMode: form.devMode,
      });
      await saveSettings(parsed);
      const next = await rpc<ConnectionStatus>({ kind: "recheckConnection" });
      setStatus(next);
      if (next.kind === "ok") {
        setToast({ kind: "ok", text: "Connection successful." });
      } else if (next.kind === "down") {
        setToast({ kind: "error", text: `Connection failed: ${next.reason}` });
      } else {
        setToast({ kind: "info", text: "Connection state unknown." });
      }
    } catch (e) {
      const msg = e instanceof z.ZodError ? e.issues[0]?.message ?? "Invalid" : e instanceof Error ? e.message : String(e);
      setToast({ kind: "error", text: `Couldn't test: ${msg}` });
    } finally {
      setTesting(false);
    }
  }, [form, originalLoaded]);

  const onSave = useCallback(async () => {
    setSaving(true);
    setToast(null);
    try {
      const parsed = SettingsSchema.parse({
        ...form,
        exclusionDomains: form.exclusionDomains,
        localhostEnabled: form.localhostEnabled,
        devMode: form.devMode,
      });
      await saveSettings(parsed);
      setOriginalLoaded(parsed);
      setToast({ kind: "ok", text: "Settings saved." });
    } catch (e) {
      const msg = e instanceof z.ZodError ? e.issues[0]?.message ?? "Invalid" : e instanceof Error ? e.message : String(e);
      setToast({ kind: "error", text: `Couldn't save: ${msg}` });
    } finally {
      setSaving(false);
    }
  }, [form, originalLoaded]);

  if (loading) {
    return <div className="wrap"><p>Loading…</p></div>;
  }

  const showErr = (key: keyof FormErrors): string | undefined => {
    if (!touched[key]) return undefined;
    return errors[key];
  };

  return (
    <div className="wrap">
      <h1>Thilko</h1>
      <p className="tagline">
        Highlight, comment, and chat with AI on any article. Backed by your private Supermemory.
      </p>

      <div className="panel" aria-label="Connection status">
        <p className="section-title">Status</p>
        <StatusLine status={status} />
      </div>

      <div className="panel" aria-label="Magic link">
        <p className="section-title">Got a magic link?</p>
        <div className="helper-block">
          Paste the link your friend DM'd you (or just the <code>t_…</code> token).
          Skips the proxy URL / secret / slot dance below.
        </div>
        <div className="row" style={{ alignItems: "stretch" }}>
          <input
            type="text"
            value={claimInput}
            onChange={(e) => setClaimInput(e.target.value)}
            placeholder="https://thilko.yesh.is/?claim=t_… (or just t_…)"
            autoComplete="off"
            spellCheck={false}
            disabled={claiming}
            style={{ flex: 1 }}
          />
          <button
            type="button"
            onClick={() => void runClaim(claimInput)}
            disabled={claiming || claimInput.trim().length === 0}
          >
            {claiming ? "Connecting…" : "Connect"}
          </button>
        </div>
        {claimMsg ? (
          <p
            className="field-hint"
            style={{
              marginTop: 8,
              color: claimMsg.kind === "err" ? "var(--warn)" : claimMsg.kind === "ok" ? "var(--accent)" : undefined,
            }}
          >
            {claimMsg.text}
          </p>
        ) : null}
      </div>

      <div className="panel">
        <p className="section-title">Proxy</p>
        <div className="helper-block">
          The extension talks to a Codex+Memory proxy you control. Add{" "}
          <code>SUPERMEMORY_API_KEY</code> to the proxy's env so the{" "}
          <code>/memory/*</code> routes work. v1 personal use: paste the proxy URL,
          shared secret, and slot below.
        </div>

        <label className="field">
          <span className="field-label">Proxy URL</span>
          <span className="field-hint">
            e.g. <code>http://127.0.0.1:3200</code> (local SSH tunnel) or <code>https://your-vps.example.com:3200</code>
          </span>
          <input
            type="url"
            value={form.proxyUrl}
            onChange={(e) => updateField("proxyUrl", e.target.value)}
            onBlur={() => onBlur("proxyUrl")}
            aria-invalid={!!showErr("proxyUrl")}
            placeholder="http://127.0.0.1:3200"
            autoComplete="off"
            spellCheck={false}
          />
          {showErr("proxyUrl") ? <span className="field-error">{showErr("proxyUrl")}</span> : null}
        </label>

        <label className="field">
          <span className="field-label">Proxy secret</span>
          <span className="field-hint">
            The <code>PROXY_SECRET</code> the proxy is started with.
          </span>
          <div className="row" style={{ alignItems: "stretch" }}>
            <input
              type={showSecret ? "text" : "password"}
              value={form.proxySecret}
              onChange={(e) => updateField("proxySecret", e.target.value)}
              onBlur={() => onBlur("proxySecret")}
              aria-invalid={!!showErr("proxySecret")}
              placeholder="paste secret"
              autoComplete="off"
              spellCheck={false}
              style={{ flex: 1 }}
            />
            <button type="button" onClick={() => setShowSecret((v) => !v)} aria-label="toggle visibility">
              {showSecret ? "Hide" : "Show"}
            </button>
          </div>
          {showErr("proxySecret") ? <span className="field-error">{showErr("proxySecret")}</span> : null}
        </label>

        <label className="field">
          <span className="field-label">Slot</span>
          <span className="field-hint">
            Your personal namespace tag. Used by the proxy to scope your data in Supermemory. Letters, digits, hyphen, underscore — 1 to 32 chars.
          </span>
          <input
            type="text"
            value={form.slot}
            onChange={(e) => updateField("slot", e.target.value)}
            onBlur={() => onBlur("slot")}
            aria-invalid={!!showErr("slot")}
            placeholder="e.g. alice"
            autoComplete="off"
            spellCheck={false}
          />
          {showErr("slot") ? <span className="field-error">{showErr("slot")}</span> : null}
        </label>

        <label className="field" style={{ marginTop: 12 }}>
          <span className="field-label">
            <input
              type="checkbox"
              checked={form.autoPersistHighlights}
              onChange={(e) => setForm((f) => ({ ...f, autoPersistHighlights: e.target.checked }))}
              style={{ marginRight: 8, verticalAlign: "middle" }}
            />
            Save every highlight to memory immediately
          </span>
          <span className="field-hint">
            <strong>Off by default.</strong> When off, highlighting text just paints the local marker — the highlight is only saved to Supermemory once you add a comment or send a message to Dabbis-AI. Keeps your memory clean of "empty marker" records. Turn on if you want every highlight remembered even without notes.
          </span>
        </label>

        <label className="field" style={{ marginTop: 8 }}>
          <span className="field-label">
            <input
              type="checkbox"
              checked={form.pdfAutoRedirect}
              onChange={(e) => setForm((f) => ({ ...f, pdfAutoRedirect: e.target.checked }))}
              style={{ marginRight: 8, verticalAlign: "middle" }}
            />
            Auto-open PDFs in Thilko's viewer
          </span>
          <span className="field-hint">
            <strong>Off by default.</strong> When off, PDFs open in Chrome's native viewer for best rendering quality, and clicking the extension toolbar icon on a PDF tab opens the same PDF in Thilko's viewer for annotation. Turn on if you always want Thilko's viewer to take over PDF navigations.
          </span>
        </label>

        <label className="field" style={{ marginTop: 8 }}>
          <span className="field-label">
            <input
              type="checkbox"
              checked={form.devMode}
              onChange={(e) => setForm((f) => ({ ...f, devMode: e.target.checked }))}
              style={{ marginRight: 8, verticalAlign: "middle" }}
            />
            Developer mode — expose <code>window.__thilko_dev</code> on every page
          </span>
          <span className="field-hint">
            Enables devtools-driven testing of highlight creation, search, etc. <strong>Off by default.</strong> When on, any page script can call privileged proxy operations on your behalf. Leave off unless you're actively debugging the extension.
          </span>
        </label>

        <div className="row" style={{ marginTop: 8 }}>
          <button
            type="button"
            onClick={testConnection}
            disabled={testing || saving || !formValid}
          >
            {testing ? "Testing…" : "Test connection"}
          </button>
          <button
            type="button"
            className="primary"
            onClick={onSave}
            disabled={saving || testing || !formValid || !isDirty}
          >
            {saving ? "Saving…" : "Save"}
          </button>
          <span className="meta-line" style={{ marginLeft: 4 }}>
            {isDirty ? "Unsaved changes." : "Settings synced."}
          </span>
        </div>
      </div>

      <ActivityPanel />

      <div className="panel">
        <p className="section-title">Excluded sites</p>
        <div className="helper-block">
          Domains where Thilko will not activate. Useful for chat tools, banks,
          internal apps. Hostname match (or subdomain) — no http/https prefix.
          Defaults are the built-in list; you can remove any of them.
        </div>

        <div className="exclusion-list">
          {form.exclusionDomains.length === 0 ? (
            <div className="meta-line">(empty — Thilko will activate everywhere)</div>
          ) : (
            form.exclusionDomains.map((d) => (
              <div key={d} className="exclusion-row">
                <span className="exclusion-domain">{d}</span>
                <button
                  type="button"
                  className="exclusion-remove"
                  onClick={() => setForm((f) => ({ ...f, exclusionDomains: f.exclusionDomains.filter((x) => x !== d) }))}
                  aria-label={`Remove ${d}`}
                >
                  ✕
                </button>
              </div>
            ))
          )}
        </div>

        <div className="row" style={{ marginTop: 8 }}>
          <input
            type="text"
            value={newDomain}
            onChange={(e) => setNewDomain(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addDomain();
              }
            }}
            placeholder="example.com"
            autoComplete="off"
            spellCheck={false}
            style={{ flex: 1 }}
          />
          <button type="button" onClick={addDomain} disabled={!normalizeDomain(newDomain)}>
            Add
          </button>
        </div>

        <label className="field" style={{ marginTop: 12 }}>
          <span className="field-label">
            <input
              type="checkbox"
              checked={form.localhostEnabled}
              onChange={(e) => setForm((f) => ({ ...f, localhostEnabled: e.target.checked }))}
              style={{ marginRight: 8, verticalAlign: "middle" }}
            />
            Activate on localhost
          </span>
          <span className="field-hint">
            Off by default. Enables Thilko on <code>http://localhost</code> /{" "}
            <code>127.0.0.1</code> pages — handy for previewing your own
            content, but it also means the extension runs on dev servers.
          </span>
        </label>
      </div>

      <DangerZone onToast={setToast} />

      {toast ? <div className={`toast ${toast.kind === "error" ? "error" : toast.kind === "ok" ? "ok" : ""}`} role="status">{toast.text}</div> : null}
    </div>
  );

  function addDomain() {
    const d = normalizeDomain(newDomain);
    if (!d) return;
    setForm((f) => (f.exclusionDomains.includes(d) ? f : { ...f, exclusionDomains: [...f.exclusionDomains, d] }));
    setNewDomain("");
  }
}

function DangerZone({ onToast }: { onToast: (t: Toast) => void }) {
  const [step, setStep] = useState<"idle" | "confirm" | "deleting" | "done">("idle");
  const [confirmText, setConfirmText] = useState("");

  const beginReset = useCallback(() => {
    setStep("confirm");
    setConfirmText("");
  }, []);

  const cancelReset = useCallback(() => {
    setStep("idle");
    setConfirmText("");
  }, []);

  const performReset = useCallback(async () => {
    setStep("deleting");
    try {
      const r = await rpc<{
        deleted: { highlights: number; comments: number; threads: number };
        failed: { highlights: number; comments: number; threads: number };
        firstErrorCode?: string;
      }>({ kind: "resetAllData" });

      const totalFailed = r.failed.highlights + r.failed.comments + r.failed.threads;
      const okSummary = `${r.deleted.highlights} highlight${r.deleted.highlights === 1 ? "" : "s"}, ${r.deleted.comments} comment${r.deleted.comments === 1 ? "" : "s"}, ${r.deleted.threads} thread${r.deleted.threads === 1 ? "" : "s"}`;

      if (totalFailed === 0) {
        onToast({ kind: "ok", text: `Reset complete — deleted ${okSummary}.` });
      } else {
        const codeHint = r.firstErrorCode ? ` (${r.firstErrorCode})` : "";
        onToast({
          kind: "error",
          text: `Partial reset — deleted ${okSummary}; ${totalFailed} record${totalFailed === 1 ? "" : "s"} could not be deleted${codeHint}. Re-run to retry.`,
        });
      }
      setStep("done");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      onToast({ kind: "error", text: `Reset failed: ${msg}` });
      setStep("idle");
    }
  }, [onToast]);

  return (
    <div className="panel danger-panel">
      <p className="section-title">Danger zone</p>
      <div className="helper-block">
        Reset all data deletes every highlight, comment, and AI thread stored
        for this slot. Articles remain in Supermemory (they're shared
        documents, not slot-scoped). This action cannot be undone — you'll
        need your Supermemory data to be exported separately if you want
        a backup.
      </div>

      {step === "idle" ? (
        <button type="button" className="danger" onClick={beginReset}>
          Reset all data
        </button>
      ) : null}

      {step === "confirm" ? (
        <div style={{ marginTop: 8 }}>
          <div className="helper-block" style={{ color: "var(--danger, #b91c1c)" }}>
            Type <code>RESET</code> below to confirm. This deletes every
            highlight, comment, and AI thread for this slot from Supermemory.
          </div>
          <input
            type="text"
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            placeholder="RESET"
            autoComplete="off"
            spellCheck={false}
            style={{ width: "100%", marginTop: 4 }}
          />
          <div className="row" style={{ marginTop: 8 }}>
            <button
              type="button"
              className="danger"
              disabled={confirmText !== "RESET"}
              onClick={() => void performReset()}
            >
              Yes, delete everything
            </button>
            <button type="button" onClick={cancelReset}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {step === "deleting" ? (
        <div className="meta-line" style={{ marginTop: 8 }}>Deleting all data… this can take a minute on large slots.</div>
      ) : null}

      {step === "done" ? (
        <div className="row" style={{ marginTop: 8 }}>
          <button type="button" onClick={() => setStep("idle")}>Close</button>
        </div>
      ) : null}
    </div>
  );
}

interface OpLogEntry {
  at: number;
  kind: string;
  durationMs: number;
  ok: boolean;
  errorCode?: string;
}

function ActivityPanel() {
  const [entries, setEntries] = useState<OpLogEntry[]>([]);
  const [open, setOpen] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const r = await rpc<{ entries: OpLogEntry[] }>({ kind: "readOpLog" });
      setEntries(r.entries);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void refresh();
    const id = setInterval(refresh, 3000);
    return () => clearInterval(id);
  }, [open, refresh]);

  const clear = useCallback(async () => {
    try {
      await rpc({ kind: "clearOpLog" });
      setEntries([]);
    } catch {
      // ignore
    }
  }, []);

  const sorted = useMemo(() => [...entries].sort((a, b) => b.at - a.at), [entries]);

  return (
    <div className="panel">
      <p className="section-title">
        Recent activity{" "}
        <button
          type="button"
          className="link"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          style={{ marginLeft: 8, background: "transparent", border: 0, color: "var(--accent)", cursor: "pointer" }}
        >
          {open ? "Hide" : "Show"}
        </button>
      </p>
      <div className="helper-block">
        Last {sorted.length} background operations. Stored locally; no remote
        telemetry. Use this to debug "why isn't my highlight saving?" — each
        row shows the RPC kind, duration, and error code if it failed.
      </div>
      {open ? (
        sorted.length === 0 ? (
          <div className="meta-line">No activity recorded yet.</div>
        ) : (
          <>
            <div className="op-log">
              {sorted.slice(0, 50).map((e, i) => (
                <div key={`${e.at}-${i}`} className={`op-row ${e.ok ? "ok" : "error"}`}>
                  <span className="op-when">{formatAgo(e.at)}</span>
                  <span className="op-kind">{e.kind}</span>
                  <span className="op-duration">{e.durationMs}ms</span>
                  <span className="op-status">{e.ok ? "ok" : e.errorCode ?? "error"}</span>
                </div>
              ))}
            </div>
            <div className="row" style={{ marginTop: 8 }}>
              <button type="button" onClick={() => void refresh()}>Refresh</button>
              <button type="button" onClick={() => void clear()}>Clear log</button>
            </div>
          </>
        )
      ) : null}
    </div>
  );
}

function formatAgo(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 1000) return "now";
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  return new Date(ms).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
}

/**
 * Pull a clean hostname out of whatever the user pasted. The content-script
 * matcher compares against `location.hostname`, so anything that has a path,
 * port, query, or fragment will silently never match. We parse via a
 * synthetic URL so those parts get discarded; the leading wildcard "*." is
 * stripped because the matcher already implies subdomain matching (it does
 * `hostname.endsWith(`.${rule}`)`).
 */
function normalizeDomain(input: string): string | null {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) return null;
  // Strip leading "*." or "." so users can paste either "*.example.com" or
  // "example.com" without changing semantics.
  const stripped = trimmed.replace(/^(\*\.|\.)/, "");
  if (!stripped || /\s/.test(stripped)) return null;
  let host: string;
  try {
    const candidate = /^https?:\/\//.test(stripped) ? stripped : `https://${stripped}`;
    const u = new URL(candidate);
    host = u.hostname;
  } catch {
    return null;
  }
  // URL parsing can preserve a leading "*." (e.g. `https://*.example.com`
  // round-trips with the wildcard in hostname). Strip again post-parse so
  // both bare and URL-shaped wildcard inputs collapse to the same rule.
  host = host.replace(/^(\*\.|\.)/, "");
  if (!host) return null;
  // Reject single-label entries (no TLD) except localhost — those are almost
  // always typos or pasted markdown like `*.com` and won't match anything
  // useful.
  if (!host.includes(".") && host !== "localhost") return null;
  return host;
}

function sameDomains(a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function StatusLine({ status }: { status: ConnectionStatus }) {
  if (status.kind === "ok") {
    const exp = status.tokenExpiresInSeconds;
    const expSuffix =
      exp == null
        ? ""
        : exp <= 0
          ? " · Codex token expired"
          : ` · Codex token expires in ${formatDuration(exp)}`;
    const memWarning = status.memoryReady ? null : (
      <span style={{ color: "var(--warn)", marginLeft: 8 }}>
        ⚠ Memory disabled on proxy (SUPERMEMORY_API_KEY unset)
      </span>
    );
    return (
      <div className="status">
        <span className="dot ok" aria-hidden="true" />
        <span>Connected{expSuffix}</span>
        {memWarning}
      </div>
    );
  }
  if (status.kind === "unconfigured") {
    return (
      <div className="status">
        <span className="dot warn" aria-hidden="true" />
        <span>Not configured. Fill in the fields below to connect.</span>
      </div>
    );
  }
  return (
    <div className="status">
      <span className="dot error" aria-hidden="true" />
      <span>Disconnected: {status.reason}</span>
    </div>
  );
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

const rootEl = document.getElementById("root");
if (rootEl) {
  createRoot(rootEl).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
