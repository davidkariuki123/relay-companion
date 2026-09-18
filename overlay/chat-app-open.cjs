// Where a chat app's tile sends a Relay: the app on this computer when it
// owns its scheme, the web app otherwise. Extracted from main.cjs so the
// decision is unit-testable without Electron.
//
// The https link never reaches the app on a computer. Neither Claude nor
// ChatGPT on macOS carries an associated-domains entitlement (read from the
// code signatures, 2026-09-17), so LaunchServices hands https://claude.ai/new
// to the default browser: David clicked Open in Claude and got Chrome. A phone
// is different, and the web share page keeps the universal link there.
//
// Claude Desktop registers claude:// and its router accepts
//   claude://claude.ai/new?surface=chat&q=<prompt>
// which is the app's own Dock-menu "New Chat" link. The app loads /new with
// the prompt in the composer, not sent, capped at 14,336 characters by the
// app itself (read from 2.110.0). ChatGPT registers no chatgpt:// on a
// computer, only codex://, and codex://threads/new is the Codex surface, so
// the ChatGPT tile stays the web app.
//
// Whether the app is here is the OS's answer, not a path check: Electron's
// app.getApplicationNameForProtocol asks LaunchServices (the registry on
// Windows), which is exactly what shell.openExternal will consult. An app
// that was copied but never launched has no registration and would leave the
// click a dead end, so the caller also falls back to the web link when the
// scheme is refused after all.

const CLAUDE_SCHEME = "claude://";

function ownsScheme(schemeOwner, scheme) {
  if (typeof schemeOwner !== "function") return false;
  try {
    return String(schemeOwner(scheme) || "").trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * @param {"claude"|"chatgpt"} app the tile that was pressed
 * @param {string} prompt the sentence the chat's composer opens with
 * @param {{ schemeOwner?: (scheme: string) => string }} options
 *   schemeOwner answers with the name of the app registered for a scheme,
 *   or "" when nothing is.
 * @returns {{ primary: string, fallback: string, via: "app"|"web" }}
 *   primary is opened first; fallback, when non-empty, is opened only when
 *   the primary is refused by the OS.
 */
function chatAppTargets(app, prompt, { schemeOwner } = {}) {
  const q = encodeURIComponent(String(prompt || ""));
  if (app === "chatgpt") {
    // mode=work: the reply has to be fetched and posted, which is what
    // ChatGPT Work does and Chat does not (David, 2026-09-17).
    return { primary: `https://chatgpt.com/?q=${q}&mode=work`, fallback: "", via: "web" };
  }
  const web = `https://claude.ai/new?q=${q}`;
  if (!ownsScheme(schemeOwner, CLAUDE_SCHEME)) return { primary: web, fallback: "", via: "web" };
  return { primary: `claude://claude.ai/new?surface=chat&q=${q}`, fallback: web, via: "app" };
}

module.exports = { CLAUDE_SCHEME, chatAppTargets };
