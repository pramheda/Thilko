/**
 * Per-article sidebar — slim right-edge panel listing all highlights, comments,
 * and threads for the current article.
 *
 * The component is pure: it receives a SidebarState snapshot + a callback for
 * row clicks (manager handles scroll + popover open). No direct network calls.
 */

import { useEffect, useMemo, useState } from "react";
import { type SidebarState } from "./sidebar-state.js";
import { NoteRow, type PreviewMode } from "./note-row.js";
import type { HandoffResult } from "../../shared/claude-handoff.js";
import { Glyph } from "../ui/glyph.js";

type FilterMode = "all" | "comments" | "threads";
type ClaudeToast = { kind: "ok" | "error"; text: string };

function previewModeFor(filter: FilterMode): PreviewMode {
  if (filter === "comments") return "comment";
  if (filter === "threads") return "thread";
  return "auto";
}

export interface SidebarProps {
  state: SidebarState;
  onClose: () => void;
  onNoteClick: (highlightId: string) => void;
  /**
   * Optional — when present, renders the "Open article in Claude" header
   * action. Must return the granular handoff result so the sidebar can show
   * an inline toast (clipboard ok? tab ok?) without each call site
   * reinventing the messaging.
   */
  onSendArticleToClaude?: () => Promise<HandoffResult>;
}

export function Sidebar({ state, onClose, onNoteClick, onSendArticleToClaude }: SidebarProps) {
  const [filter, setFilter] = useState<FilterMode>("all");
  const [claudeBusy, setClaudeBusy] = useState(false);
  const [claudeToast, setClaudeToast] = useState<ClaudeToast | null>(null);

  useEffect(() => {
    if (!claudeToast) return;
    const id = window.setTimeout(() => setClaudeToast(null), 4000);
    return () => window.clearTimeout(id);
  }, [claudeToast]);

  const filteredLive = useMemo(() => {
    if (filter === "all") return state.live;
    if (filter === "comments") return state.live.filter((e) => e.commentCount > 0);
    return state.live.filter((e) => e.threadCount > 0);
  }, [filter, state.live]);

  const totalLive = state.live.length;
  const totalOrphans = state.orphans.length;

  return (
    <div className="sidebar" role="complementary" aria-label="Thilko notes for this article">
      <div className="sidebar-header">
        <div className="sidebar-header-title-row">
          <div className="sidebar-header-title" title={state.articleTitle}>
            {state.articleTitle || "(untitled)"}
          </div>
          {onSendArticleToClaude && totalLive + totalOrphans > 0 ? (
            <button
              type="button"
              className="sidebar-claude"
              onClick={async () => {
                if (claudeBusy) return;
                setClaudeBusy(true);
                try {
                  const r = await onSendArticleToClaude();
                  if (r.clipboardOk && r.tabOk) setClaudeToast({ kind: "ok", text: "Copied — paste into Claude." });
                  else if (!r.clipboardOk && r.tabOk) setClaudeToast({ kind: "error", text: "Clipboard blocked. Tab opened — copy manually." });
                  else if (r.clipboardOk && !r.tabOk) setClaudeToast({ kind: "error", text: "Copied. Couldn't open Claude tab." });
                  else setClaudeToast({ kind: "error", text: "Couldn't copy or open Claude." });
                } finally {
                  setClaudeBusy(false);
                }
              }}
              disabled={claudeBusy}
              aria-label="Open this article in Claude"
              title="Copy a summary of this article's notes and open Claude"
            >
              📤
            </button>
          ) : null}
          <button type="button" className="sidebar-close" onClick={onClose} aria-label="Close sidebar" title="Close (Cmd/Ctrl+Shift+S)">
            ✕
          </button>
        </div>
        <div className="sidebar-counts">
          {totalLive} note{totalLive === 1 ? "" : "s"}
          {totalOrphans > 0 ? <span className="sidebar-orphans-count"> · {totalOrphans} orphan{totalOrphans === 1 ? "" : "s"}</span> : null}
        </div>
        <div className="sidebar-filters" role="tablist" aria-label="Filter notes">
          <FilterChip active={filter === "all"} onClick={() => setFilter("all")} label={`All (${totalLive})`} />
          <FilterChip
            active={filter === "comments"}
            onClick={() => setFilter("comments")}
            label={<><Glyph kind="note" size={14} className="filter-chip-glyph" />{state.live.filter((e) => e.commentCount > 0).length}</>}
          />
          <FilterChip
            active={filter === "threads"}
            onClick={() => setFilter("threads")}
            label={<><Glyph kind="thread" size={14} className="filter-chip-glyph" />{state.live.filter((e) => e.threadCount > 0).length}</>}
          />
        </div>
      </div>

      <div className="sidebar-body">
        {filteredLive.length > 0 ? (
          <div className="sidebar-list">
            {filteredLive.map((entry) => (
              <NoteRow
                key={entry.highlight.id}
                entry={entry}
                previewMode={previewModeFor(filter)}
                onClick={() => onNoteClick(entry.highlight.id)}
              />
            ))}
          </div>
        ) : (
          <div className="sidebar-empty">
            {state.live.length === 0
              ? "No notes on this article yet. Select text and click Comment or Ask Dabbis-AI."
              : "No matches for this filter."}
          </div>
        )}

        {claudeToast ? (
          <div className={`sidebar-claude-toast ${claudeToast.kind === "ok" ? "ok" : "error"}`} role="status">
            {claudeToast.text}
          </div>
        ) : null}

        {totalOrphans > 0 ? (
          <div className="sidebar-orphans">
            <div className="sidebar-orphans-header">⚠ Orphaned highlights</div>
            <div className="sidebar-orphans-hint">
              These highlights couldn't be re-anchored on this page (article text may have changed). They're still saved.
            </div>
            <div className="sidebar-list">
              {state.orphans.map((entry) => (
                <NoteRow
                  key={entry.highlight.id}
                  entry={entry}
                  previewMode="auto"
                  onClick={() => onNoteClick(entry.highlight.id)}
                />
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function FilterChip({ active, onClick, label }: { active: boolean; onClick: () => void; label: React.ReactNode }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      className={`filter-chip${active ? " active" : ""}`}
      onClick={onClick}
    >
      {label}
    </button>
  );
}
