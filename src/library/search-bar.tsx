/**
 * Search bar with 250ms debounce.
 *
 * Owns the input string locally; emits a debounced `onSearch(q)` upward so
 * the parent only sees the stable query and isn't tempted to fire a network
 * request per keystroke.
 */

import { useEffect, useState } from "react";

export interface SearchBarProps {
  /** Initial query, e.g. from URL state. */
  initialQuery?: string;
  /** Fired with the debounced query whenever it changes. Empty string = clear. */
  onSearch: (q: string) => void;
  /** When true, show a small spinner suffix. */
  loading?: boolean;
  /** Placeholder text. */
  placeholder?: string;
}

const DEBOUNCE_MS = 250;

export function SearchBar({ initialQuery = "", onSearch, loading, placeholder }: SearchBarProps) {
  const [value, setValue] = useState(initialQuery);

  useEffect(() => {
    const id = window.setTimeout(() => onSearch(value.trim()), DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [value, onSearch]);

  return (
    <div className="search-bar">
      <span className="search-bar-icon" aria-hidden="true">🔍</span>
      <input
        type="search"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={placeholder ?? "Search across all notes…"}
        aria-label="Search library"
        autoFocus
      />
      {loading ? <span className="search-bar-spinner">searching…</span> : null}
    </div>
  );
}
