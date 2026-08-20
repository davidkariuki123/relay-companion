import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  hostFromBundle,
  activationBundleCandidates,
  isRelayBundle,
  defaultClickHost,
  chooseClickHost,
  runningHostsFromProcessList,
  terminalClaudeCodeRunningFromProcessList,
} = require("../overlay/host-select.cjs");

const CLAUDE_BUNDLE = "com.anthropic.claudefordesktop";
const CODEX_BUNDLE = "com.openai.codex";
const CHATGPT_BUNDLE = "com.openai.chat";
const THIRD_PARTY = "net.whatsapp.WhatsApp"; // a real, non-host, non-relay frontmost app
const RELAY_BUNDLE = "com.github.Electron";

// Sensible defaults for a fully-installed machine; each test overrides what it exercises.
const base = {
  frontHost: null,
  bundle: null,
  lastHost: null,
  lastHostSeenAt: 0,
  now: 1_000_000,
  claudeRunning: false,
  codexRunning: false,
  codexInstalled: true,
  claudeInstalled: true,
  platform: "darwin",
};

test("hostFromBundle maps the two known bundles and nothing else", () => {
  assert.equal(hostFromBundle(CLAUDE_BUNDLE), "claude");
  assert.equal(hostFromBundle(CODEX_BUNDLE), "codex");
  assert.equal(hostFromBundle(CHATGPT_BUNDLE), "codex");
  assert.equal(hostFromBundle(THIRD_PARTY), null);
  assert.equal(hostFromBundle(null), null);
});

test("desktop activation prefers the observed ChatGPT bundle and falls back across both supported ids", () => {
  assert.deepEqual(activationBundleCandidates("codex", CHATGPT_BUNDLE), [CHATGPT_BUNDLE, CODEX_BUNDLE]);
  assert.deepEqual(activationBundleCandidates("codex", CODEX_BUNDLE), [CODEX_BUNDLE, CHATGPT_BUNDLE]);
  assert.deepEqual(activationBundleCandidates("codex", THIRD_PARTY), [CODEX_BUNDLE, CHATGPT_BUNDLE]);
  assert.deepEqual(activationBundleCandidates("claude", CHATGPT_BUNDLE), [CLAUDE_BUNDLE]);
  assert.deepEqual(activationBundleCandidates("unknown", CHATGPT_BUNDLE), []);
});

test("isRelayBundle recognizes the overlay's own Electron bundle", () => {
  assert.equal(isRelayBundle(RELAY_BUNDLE), true);
  assert.equal(isRelayBundle("work.relay.companion"), true);
  assert.equal(isRelayBundle(CLAUDE_BUNDLE), false);
  assert.equal(isRelayBundle(null), false);
});

test("defaultClickHost prefers Claude when both are installed, else the one that is", () => {
  // Product rule: with both available and neither foregrounded, prefer Claude.
  assert.equal(defaultClickHost({ platform: "darwin", codexInstalled: true, claudeInstalled: true }), "claude");
  assert.equal(defaultClickHost({ platform: "darwin", codexInstalled: true, claudeInstalled: false }), "codex");
  assert.equal(defaultClickHost({ platform: "darwin", codexInstalled: false, claudeInstalled: true }), "claude");
});

test("defaultClickHost uses Claude on Windows because Codex open is unsupported there", () => {
  assert.equal(defaultClickHost({ platform: "win32", codexInstalled: true, claudeInstalled: true }), "claude");
  assert.equal(defaultClickHost({ platform: "win32", codexInstalled: true, claudeInstalled: false }), "claude");
});

test("frontmost host always wins (strongest signal)", () => {
  assert.equal(chooseClickHost({ ...base, frontHost: "claude", bundle: CLAUDE_BUNDLE }), "claude");
  assert.equal(chooseClickHost({ ...base, frontHost: "codex", bundle: CODEX_BUNDLE }), "codex");
});

test("REGRESSION (Sven): Claude on another Space, Codex closed, third-party app frontmost -> claude, not codex", () => {
  // The bug: frontmost detection can't see Claude on another macOS Space, so frontHost
  // is null and the old code cold-started installed Codex. The running signal fixes it.
  const host = chooseClickHost({
    ...base,
    frontHost: null,
    bundle: THIRD_PARTY,
    claudeRunning: true,
    codexRunning: false,
    codexInstalled: true, // Codex installed but NOT running
    claudeInstalled: true,
  });
  assert.equal(host, "claude");
});

test("off-Space Claude wins even when the overlay itself is frontmost with no fresh capture", () => {
  const host = chooseClickHost({
    ...base,
    frontHost: null,
    bundle: RELAY_BUNDLE,
    lastHost: null,
    claudeRunning: true,
    codexRunning: false,
  });
  assert.equal(host, "claude");
});

test("single running host wins symmetrically (only Codex running -> codex), discriminating against the old default", () => {
  // Mirror of the Sven regression test. Crucially, codexInstalled:false / claudeInstalled:true
  // means the installed-preference default would pick "claude" — so returning "codex" can ONLY
  // come from the new codexRunning-and-not-claudeRunning branch. The OLD logic returned "claude"
  // here (installed default), so this test fails-old / passes-new and truly pins that branch.
  const host = chooseClickHost({
    ...base,
    bundle: THIRD_PARTY,
    claudeRunning: false,
    codexRunning: true,
    codexInstalled: false,
    claudeInstalled: true,
  });
  assert.equal(host, "codex");
});

test("fresh captured host wins over running-state when the overlay grabbed focus on click", () => {
  const host = chooseClickHost({
    ...base,
    bundle: RELAY_BUNDLE,
    lastHost: "claude",
    lastHostSeenAt: base.now - 1000, // 1s ago, inside the capture window
    claudeRunning: true,
    codexRunning: true,
  });
  assert.equal(host, "claude");
});

test("stale captured host does NOT hijack: expired capture falls through to running-state", () => {
  const host = chooseClickHost({
    ...base,
    bundle: RELAY_BUNDLE,
    lastHost: "claude",
    lastHostSeenAt: base.now - 31000, // 31s ago, expired
    claudeRunning: false,
    codexRunning: true, // only Codex actually running now
  });
  assert.equal(host, "codex");
});

test("foreground capture survives a normal read-before-click pause", () => {
  assert.equal(chooseClickHost({
    ...base,
    bundle: RELAY_BUNDLE,
    lastHost: "codex",
    lastHostSeenAt: base.now - 10000,
    claudeRunning: true,
    codexRunning: true,
  }), "codex");
});

test("running process detection recognizes ChatGPT as the current Codex desktop app", () => {
  const current = runningHostsFromProcessList(
    "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT\n/Applications/Claude.app/Contents/MacOS/Claude\n",
    "darwin",
  );
  assert.deepEqual(current, { claudeRunning: true, codexRunning: true });
  const legacy = runningHostsFromProcessList("/Applications/Codex.app/Contents/MacOS/Codex\n", "darwin");
  assert.deepEqual(legacy, { claudeRunning: false, codexRunning: true });
});

test("terminal Claude Code is diagnostic state, not a foregroundable Claude Desktop host", () => {
  const homebrew = runningHostsFromProcessList("/opt/homebrew/bin/claude\n/usr/bin/zsh\n", "darwin");
  assert.deepEqual(homebrew, { claudeRunning: false, codexRunning: false });
  const local = runningHostsFromProcessList("/Users/josh/.local/bin/claude-code\n", "darwin");
  assert.deepEqual(local, { claudeRunning: false, codexRunning: false });
  assert.equal(terminalClaudeCodeRunningFromProcessList("/opt/homebrew/bin/claude\n/usr/bin/zsh\n", "darwin"), true);
  assert.equal(terminalClaudeCodeRunningFromProcessList("/Users/josh/.local/bin/claude-code\n", "darwin"), true);
  assert.equal(
    terminalClaudeCodeRunningFromProcessList("/Applications/Claude.app/Contents/MacOS/Claude\n", "darwin"),
    false,
  );
});

test("capture is only honored for the overlay/unknown frontmost, not a real third-party app", () => {
  // A real non-host app is frontmost: the user moved on, so a moment-ago capture must
  // NOT win. Running-state decides instead.
  const host = chooseClickHost({
    ...base,
    bundle: THIRD_PARTY,
    lastHost: "claude",
    lastHostSeenAt: base.now - 1000, // fresh, but bundle is a real third-party app
    claudeRunning: false,
    codexRunning: true,
  });
  assert.equal(host, "codex");
});

test("both running, neither foregrounded, no fresh capture -> Claude (product rule)", () => {
  // Even if the most-recently-seen host was Codex, an expired capture must not
  // win: with both up and neither foregrounded, prefer Claude.
  const host = chooseClickHost({
    ...base,
    bundle: THIRD_PARTY,
    lastHost: "codex",
    lastHostSeenAt: base.now - 999999, // ancient, expired capture
    claudeRunning: true,
    codexRunning: true,
  });
  assert.equal(host, "claude");
});

test("both running, neither foregrounded, never captured a host -> Claude", () => {
  const host = chooseClickHost({
    ...base,
    bundle: THIRD_PARTY,
    lastHost: null,
    claudeRunning: true,
    codexRunning: true,
  });
  assert.equal(host, "claude");
});

test("cold start (neither running), both installed -> Claude; only Codex installed -> Codex", () => {
  assert.equal(
    chooseClickHost({ ...base, platform: "darwin", bundle: THIRD_PARTY, claudeRunning: false, codexRunning: false }),
    "claude",
  );
  assert.equal(
    chooseClickHost({ ...base, platform: "darwin", bundle: THIRD_PARTY, claudeInstalled: false, claudeRunning: false, codexRunning: false }),
    "codex",
  );
});

test("Codex foregrounded -> Codex even though Claude is the default preference", () => {
  // Frontmost always wins: if the user is looking at Codex, open in Codex.
  assert.equal(chooseClickHost({ ...base, frontHost: "codex", bundle: CODEX_BUNDLE, claudeRunning: true, codexRunning: true }), "codex");
});

test("Windows click routing ignores Codex signals and opens Claude", () => {
  assert.equal(
    chooseClickHost({
      ...base,
      platform: "win32",
      bundle: THIRD_PARTY,
      claudeRunning: false,
      codexRunning: true,
      codexInstalled: true,
      claudeInstalled: false,
    }),
    "claude",
  );
});
