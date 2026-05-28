/**
 * Library page entry. Mounts the React app in #root.
 *
 * Per plan §6 M7 reviewer-checks, all data flows through background RPC
 * (chrome.runtime.sendMessage) — never directly to Supermemory.
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app.js";
import "./library.css";

const rootEl = document.getElementById("root");
if (rootEl) {
  createRoot(rootEl).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
