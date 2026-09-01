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
// NOTHING here needs an API key. Every surface rides the user's own installed,
// already-logged-in tooling, so a run draws down THEIR subscription — which is
// also why "installed" and "logged in" are different questions and both matter.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function firstExisting(paths) {
  for (const p of paths) {
    try {
      if (p && fs.existsSync(p)) return p;
    } catch {}
  }
  return "";
}

function onPath(binary, env = process.env) {
  try {
    const out = execFileSync("/usr/bin/which", [binary], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env });
    return String(out).trim();
  } catch {
    return "";
  }
}

export function claudeCliPath({ env = process.env, homedir = os.homedir() } = {}) {
  return (
    String(env.RELAY_CLAUDE_CLI_PATH || "").trim() ||
    firstExisting([
      path.join(homedir, ".claude", "local", "claude"),
      "/opt/homebrew/bin/claude",
      "/usr/local/bin/claude",
    ]) ||
    onPath("claude", env)
  );
}

export function codexCliPath({ env = process.env } = {}) {
  return (
    String(env.CODEX_CLI_PATH || "").trim() ||
    firstExisting(["/opt/homebrew/bin/codex", "/usr/local/bin/codex"]) ||
    onPath("codex", env)
  );
}

export function appPath(appName, { platform = process.platform, homedir = os.homedir() } = {}) {
  if (platform !== "darwin") return "";
  const names = appName === "Codex" ? ["ChatGPT", "Codex"] : [appName];
  const roots = ["/Applications", path.join(homedir, "Applications")];
  for (const name of names) {
    const hit = firstExisting(roots.map((root) => path.join(root, `${name}.app`)));
    if (hit) return hit;
  }
  return "";
}

/**
 * @returns {{ [app: string]: { available: boolean, reason: string, via: string } }}
 *   keyed by the exact names the pill's picker shows.
 */
export function detectAgentSurfaces(options = {}) {
  const codexCli = codexCliPath(options);
  const claudeCli = claudeCliPath(options);
  const chatgptApp = appPath("Codex", options); // ChatGPT.app (or Codex.app)
  const claudeApp = appPath("Claude", options);

  return {
    "Claude Code": claudeCli || claudeApp
      ? { available: true, reason: "", via: claudeCli || claudeApp }
      : { available: false, reason: "Claude Code isn’t installed on this Mac", via: "" },
    "Claude Cowork": {
      available: false,
      reason: "Claude Cowork is temporarily unavailable in Relay",
      via: "",
    },
    Codex: codexCli || chatgptApp
      ? { available: true, reason: "", via: codexCli || chatgptApp }
      : { available: false, reason: "Codex isn’t installed on this Mac", via: "" },
    // Provider availability and presentation surface are deliberately separate.
    // A CLI-only machine can still open a Relay in a real provider session; when
    // both are installed the desktop app remains the default and Terminal is an
    // explicit alternative. Settings must never infer either from branding.
    _claudeCli: cliSurface("Claude Code", claudeCli),
    _codexCli: cliSurface("Codex", codexCli),
    _claudeDesktop: desktopSurface("Claude", claudeApp, options),
    _codexDesktop: desktopSurface("Codex", chatgptApp, options),
  };
}

function cliSurface(label, hit) {
  return hit
    ? { available: true, reason: "", via: hit }
    : { available: false, reason: `${label} CLI isn’t installed on this computer`, via: "" };
}

function desktopSurface(label, hit, { platform = process.platform } = {}) {
  if (platform !== "darwin") return { available: false, reason: `${label} Desktop isn’t available on this computer`, via: "" };
  return hit
    ? { available: true, reason: "", via: hit }
    : { available: false, reason: `${label} isn’t installed on this Mac`, via: "" };
}
