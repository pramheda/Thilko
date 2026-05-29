/**
 * declarativeNetRequest redirect: intercept top-level navigations to PDF
 * URLs and redirect them to our in-extension viewer, which mounts the same
 * highlight/comment lifecycle the content script uses.
 *
 * Why dynamic (not static): the redirect target is
 * `chrome-extension://<id>/src/pdf-viewer/viewer.html?file=…`, but the
 * extension ID isn't known when static rules are bundled. We install the
 * rule at SW boot using chrome.runtime.getURL.
 *
 * URL preservation:
 *   - The capture group includes the OPTIONAL query string and fragment so
 *     `https://host/file.pdf?token=abc#page=3` survives intact as the
 *     redirect's file= value. Chrome's regexSubstitution does no URL
 *     encoding — it's a textual splice. That's why the viewer reads the
 *     original URL via a raw `location.search.slice("?file=".length)` plus
 *     `location.hash` rather than URLSearchParams (which would decode `+`
 *     to space and split on `&`).
 *
 * Scope:
 *   - `resourceTypes: ["main_frame"]` — only redirect when the PDF is the
 *     user's top-level navigation (i.e., they clicked a PDF link). We do
 *     NOT redirect sub-frames or fetches; those keep working as-is for any
 *     site that embeds PDFs as iframes (we'll revisit in M10 if needed).
 *
 * Toggling:
 *   - Tied to the `pdfRedirect` setting (planned for M10 polish; defaults
 *     ON when the setting is absent). If the user wants Chrome's built-in
 *     viewer back, they can turn it off and we'll remove the rule.
 */

const RULE_ID_EXT = 1001;       // URLs whose path ends in .pdf (case-insensitive)
const RULE_ID_ARXIV = 1002;     // arxiv.org/pdf/<id> — no .pdf suffix needed

/** All rule IDs the installer manages — used for atomic remove/add. */
const ALL_RULE_IDS = [RULE_ID_EXT, RULE_ID_ARXIV];

function buildRules(): chrome.declarativeNetRequest.Rule[] {
  // `\1` captures the full original URL — path + optional query + optional
  // fragment. Chrome's regexSubstitution is a textual splice (no encoding),
  // so the viewer reads `location.search` raw and recombines with
  // `location.hash` to recover the URL byte-for-byte.
  const viewerBase = chrome.runtime.getURL("src/pdf-viewer/viewer.html");
  const redirectUrl = `${viewerBase}?file=\\1`;

  const REDIRECT = chrome.declarativeNetRequest.RuleActionType.REDIRECT;
  const MAIN_FRAME = chrome.declarativeNetRequest.ResourceType.MAIN_FRAME;

  return [
    {
      // Path ends in .pdf, .PDF, .Pdf, etc. — the common form for most
      // publishers and direct PDF links.
      id: RULE_ID_EXT,
      priority: 1,
      action: { type: REDIRECT, redirect: { regexSubstitution: redirectUrl } },
      condition: {
        regexFilter: "^(https?://[^?#]+\\.[pP][dD][fF](?:[?#].*)?)$",
        resourceTypes: [MAIN_FRAME],
      },
    },
    {
      // arxiv.org serves PDFs at /pdf/<id> WITHOUT a .pdf extension. The
      // existing extension-based rule misses these — adding a host-scoped
      // pattern catches them without false positives on /abs/<id>.
      id: RULE_ID_ARXIV,
      priority: 1,
      action: { type: REDIRECT, redirect: { regexSubstitution: redirectUrl } },
      condition: {
        regexFilter: "^(https?://arxiv\\.org/pdf/[^?#]+(?:[?#].*)?)$",
        resourceTypes: [MAIN_FRAME],
      },
    },
  ];
}

/**
 * Install (or refresh) the PDF redirect rule. Safe to call repeatedly —
 * uses removeRuleIds to clear any prior incarnation before adding.
 */
export async function installPdfRedirectRule(): Promise<void> {
  if (!chrome.declarativeNetRequest?.updateDynamicRules) {
    console.warn("[thilko] declarativeNetRequest unavailable — PDF redirect disabled");
    return;
  }
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: ALL_RULE_IDS,
      addRules: buildRules(),
    });
  } catch (e) {
    console.error("[thilko] failed to install PDF redirect rules", e);
  }
}

/**
 * Remove the PDF redirect rules (used when the user disables PDF support in
 * settings — wired in M10).
 */
export async function removePdfRedirectRule(): Promise<void> {
  if (!chrome.declarativeNetRequest?.updateDynamicRules) return;
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: ALL_RULE_IDS });
  } catch (e) {
    console.error("[thilko] failed to remove PDF redirect rules", e);
  }
}
