// Which agent surfaces this machine can actually reach.
//
// The pill offers three destinations: Claude Code, Claude Cowork, and Codex.
// Offering one the user does not have is a promise the verb cannot keep, so the
// picker greys what is missing and says why.
//
// Detection is by RUNTIME, not by branding — each surface is reachable through a
// different thing, and the thing that runs the work is what must exist:
//
//   Claude Code   — the Claude Code CLI or Claude Desktop's Code surface.
//   Claude Cowork — Claude Desktop's Cowork surface and the same existing login.
//   Codex         — the `codex` CLI (its app-server creates threads) or the
//                   ChatGPT/Codex desktop app.
//
// WHAT IS INSTALLED is installed-apps.cjs's answer, the one Relay uses
// everywhere (2026-10-09). What this file adds is only where Relay can OPEN a
// Relay: on macOS in the app or in Terminal, on Linux in a terminal. Windows
// has neither hand-off yet (the terminal launch and the Codex app refresh are
// macOS-only), so an installed app there says so instead of offering a verb
// that cannot work. Running a Task is a separate question
// (native-task-launch.js) and works on Windows.
//
// NOTHING here needs an API key. Every surface rides the user's own installed,
// already-logged-in tooling, so a run draws down THEIR subscription — which is
// also why "installed" and "logged in" are different questions and both matter.

import installedApps from "./installed-apps.cjs";

export function claudeCliPath(options = {}) {
  return installedApps.claudeCliPath(options);
}

export function codexCliPath(options = {}) {
  return installedApps.codexCliPath(options);
}

/**
 * @returns {{ [app: string]: { available: boolean, reason: string, via: string, installed?: boolean } }}
 *   keyed by the exact names the pill's picker shows.
 */
export function detectAgentSurfaces(options = {}) {
  const platform = options.platform || process.platform;
  const machine = machineNoun(platform);
  const apps = installedApps.installedAiApps({ ...options, platform });
  const claudeApp = platform === "darwin" ? apps.claudeApp : "";
  const chatgptApp = platform === "darwin" ? apps.chatgptApp : "";

  return {
    "Claude Code": provider("Claude Code", { platform, machine, installed: apps.claudeCli || apps.claudeApp, opens: apps.claudeCli || claudeApp }),
    "Claude Cowork": {
      available: false,
      reason: "Claude Cowork is temporarily unavailable in Relay",
      via: "",
    },
    Codex: provider("Codex", { platform, machine, installed: apps.codexCli || apps.chatgptApp, opens: apps.codexCli || chatgptApp }),
    // Provider availability and presentation surface are deliberately separate.
    // A CLI-only machine can still open a Relay in a real provider session; when
    // both are installed the desktop app remains the default and Terminal is an
    // explicit alternative. Settings must never infer either from branding.
    _claudeCli: cliSurface("Claude Code", apps.claudeCli, platform),
    _codexCli: cliSurface("Codex", apps.codexCli, platform),
    _claudeDesktop: desktopSurface("Claude", claudeApp, platform),
    _codexDesktop: desktopSurface("Codex", chatgptApp, platform),
  };
}

/** The word the picker uses for this machine: only macOS is a "Mac". */
function machineNoun(platform = process.platform) {
  return platform === "darwin" ? "Mac" : "computer";
}

const WINDOWS_OPEN = (label) => `Opening a Relay in ${label} isn’t available on Windows yet`;

function provider(label, { platform, machine, installed, opens }) {
  if (platform === "win32" && installed) return { available: false, installed: true, reason: WINDOWS_OPEN(label), via: "" };
  return opens
    ? { available: true, installed: true, reason: "", via: opens }
    : { available: false, installed: Boolean(installed), reason: `${label} isn’t installed on this ${machine}`, via: "" };
}

function cliSurface(label, hit, platform) {
  if (platform === "win32" && hit) return { available: false, reason: WINDOWS_OPEN(label), via: "" };
  return hit
    ? { available: true, reason: "", via: hit }
    : { available: false, reason: `${label} CLI isn’t installed on this computer`, via: "" };
}

function desktopSurface(label, hit, platform) {
  if (platform !== "darwin") return { available: false, reason: `${label} Desktop isn’t available on this computer`, via: "" };
  return hit
    ? { available: true, reason: "", via: hit }
    : { available: false, reason: `${label} isn’t installed on this Mac`, via: "" };
}
