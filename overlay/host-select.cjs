// Pure host-selection logic for pill click-to-open, extracted from main.cjs so the
// decision matrix is unit-testable without Electron.
//
// A relay opens inside a running desktop agent (Claude Desktop or Codex). The pill
// must decide WHICH one. The naive signal — the macOS frontmost app — is Space-blind:
// `lsappinfo front` only ever names the single globally-frontmost app, so an agent
// running on a DIFFERENT macOS Space is invisible to it. When that happens the old
// code fell straight through to an installed-preference default that cold-started
// Codex even when Codex was closed and Claude was the only agent running (observed
// live: "relay is forcing me into codex, not claude … with claude in a different
// desktop it breaks"). The running-process signal (from `ps`, which is Space-agnostic)
// is the reliable tiebreaker, so it now sits ahead of the installed-preference default.

const CLAUDE_DESKTOP_BUNDLE = "com.anthropic.claudefordesktop";
const CODEX_DESKTOP_BUNDLES = ["com.openai.codex", "com.openai.chat"];

function hostFromBundle(bundle) {
  if (bundle === CLAUDE_DESKTOP_BUNDLE) return "claude";
  if (CODEX_DESKTOP_BUNDLES.includes(bundle)) return "codex";
  return null;
}

function activationBundleCandidates(host, observedBundle = null) {
  if (host === "claude") return [CLAUDE_DESKTOP_BUNDLE];
  if (host !== "codex") return [];
  const observed = CODEX_DESKTOP_BUNDLES.includes(observedBundle) ? observedBundle : null;
  return [...new Set([observed, ...CODEX_DESKTOP_BUNDLES].filter(Boolean))];
}

function isRelayBundle(bundle) {
  const clean = String(bundle || "").toLowerCase();
  return clean.includes("relay") || clean.includes("electron");
}

// Cold-start choice when NEITHER agent is foregrounded/running: pick by what's
// installed. When BOTH are available and neither is foregrounded, prefer Claude
// (per the product rule: "if I have claude and codex and neither is foregrounded,
// foreground claude"). Windows is Claude-only for now: the Codex materializer still
// depends on macOS Codex Desktop paths/app-server behavior, while Claude's claude://
// resume handler is registered by Claude Desktop on Windows.
function defaultClickHost({ codexInstalled = false, claudeInstalled = false, platform = process.platform } = {}) {
  if (platform === "win32") return "claude";
  if (claudeInstalled) return "claude";
  if (codexInstalled) return "codex";
  return "claude";
}

// Decide which host a pill click should open into. Precedence, strongest signal first:
//   1. The frontmost app IS a host — the user is literally looking at it, so open there.
//      (Codex frontmost -> Codex; Claude frontmost -> Claude.)
//   2. The click momentarily activated the accessory overlay (or no frontmost app could
//      be read) AND a host was foregrounded moments ago — use that just-foregrounded host.
//   3. Exactly one host PROCESS is running — route to it. This is the off-Space fix:
//      `ps` sees a host on any Space, so a running-but-not-frontmost Claude wins over a
//      closed Codex instead of cold-starting Codex. (Only Codex up -> Codex; only Claude
//      up -> Claude.)
//   4. Both hosts are running but NEITHER is foregrounded — prefer Claude (product rule).
//   5. Nothing running — installed-preference default (true cold start; prefers Claude
//      when both are installed).
function chooseClickHost({
  frontHost = null,
  bundle = null,
  lastHost = null,
  lastHostSeenAt = 0,
  now = 0,
  claudeRunning = false,
  codexRunning = false,
  codexInstalled = false,
  claudeInstalled = false,
  platform = process.platform,
} = {}) {
  const codexSupported = platform !== "win32";
  const effectiveCodexRunning = codexSupported && codexRunning;
  const effectiveCodexInstalled = codexSupported && codexInstalled;

  if (frontHost) return frontHost;

  // The pointer can sit over the pill while the human reads a row before clicking.
  // Keep the foreground capture long enough for that normal interaction; re-entering
  // the pill refreshes it, and a directly detected frontmost host still wins above.
  const capturedHostIsFresh = lastHost && now - lastHostSeenAt < 30000;
  if ((!bundle || isRelayBundle(bundle)) && capturedHostIsFresh) return lastHost;

  if (claudeRunning && !effectiveCodexRunning) return "claude";
  if (effectiveCodexRunning && !claudeRunning) return "codex";
  // Both running, neither foregrounded (and none foregrounded moments ago): prefer Claude.
  if (claudeRunning && effectiveCodexRunning) return "claude";

  return defaultClickHost({ codexInstalled: effectiveCodexInstalled, claudeInstalled, platform });
}

function runningHostsFromProcessList(text, platform = process.platform) {
  const value = String(text || "");
  if (platform === "darwin") {
    return {
      claudeRunning: /\/Claude\.app\/Contents\/MacOS\/Claude(\n|$)/.test(value),
      codexRunning:
        /\/ChatGPT\.app\/Contents\/MacOS\/ChatGPT(\n|$)/.test(value) ||
        /\/Codex\.app\/Contents\/MacOS\/Codex(\n|$)/.test(value),
    };
  }
  if (platform === "win32") {
    return {
      claudeRunning: /"Claude\.exe"/i.test(value),
      codexRunning: /"(?:ChatGPT|Codex)\.exe"/i.test(value),
    };
  }
  return {
    claudeRunning: /(^|\n)Claude(\n|$)/.test(value) || /(^|\n)claude(\n|$)/.test(value),
    codexRunning:
      /(^|\n)(?:ChatGPT|Codex)(\n|$)/.test(value) ||
      /(^|\n)(?:chatgpt|codex)(\n|$)/.test(value),
  };
}

// Terminal Claude Code is useful diagnostic state, but it is not a desktop surface
// Relay can foreground: Relay's Claude materializer opens a claude:// resume link in
// Claude Desktop. Keep this separate from runningHostsFromProcessList so a terminal-
// only process never diverts a click away from a usable Codex/ChatGPT desktop window.
function terminalClaudeCodeRunningFromProcessList(text, platform = process.platform) {
  const lines = String(text || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (platform === "darwin") {
    return lines.some(
      (line) =>
        !/\.app\/Contents\//i.test(line) &&
        /(?:^|\/)claude(?:-code)?(?:\.exe)?$/i.test(line),
    );
  }
  if (platform === "win32") {
    return lines.some((line) => /(?:^|[\\/\"])(?:claude-code|claude)(?:\.exe)?(?:\"|$)/i.test(line));
  }
  return lines.some((line) => /(?:^|\/)claude(?:-code)?$/i.test(line));
}

module.exports = {
  hostFromBundle,
  activationBundleCandidates,
  isRelayBundle,
  defaultClickHost,
  chooseClickHost,
  runningHostsFromProcessList,
  terminalClaudeCodeRunningFromProcessList,
};
