/**
 * The floating toggle button in the bottom-right corner of the viewport.
 *
 * Visible whenever the article has at least one annotation (live or orphan).
 * Click → toggles the sidebar panel.
 */

export interface ToggleButtonProps {
  count: number;
  sidebarOpen: boolean;
  onClick: () => void;
}

export function ToggleButton({ count, sidebarOpen, onClick }: ToggleButtonProps) {
  return (
    <button
      type="button"
      className={`sidebar-toggle${sidebarOpen ? " open" : ""}`}
      onClick={onClick}
      aria-label={sidebarOpen ? "Close Thilko sidebar" : "Open Thilko sidebar"}
      title={`${sidebarOpen ? "Close" : "Open"} sidebar (Cmd/Ctrl+Shift+S)`}
    >
      <span className="sidebar-toggle-icon" aria-hidden="true">📑</span>
      {count > 0 ? <span className="sidebar-toggle-badge">{count}</span> : null}
    </button>
  );
}
