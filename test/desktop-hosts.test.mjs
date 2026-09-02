import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import {
  claudeDesktopConfigDirs,
  claudeDesktopEntry,
  codexBinaryCandidates,
  isDeadRelayEntry,
  isLegacyRelayCompanionEntry,
  mergeClaudeDesktopConfig,
  resolveStableNode,
} from "../src/desktop-hosts.js";

const HOME = "/Users/tester";

test("an explicit CLAUDE_USER_DATA_DIR is used verbatim, with no app-name suffix", () => {
  const dirs = claudeDesktopConfigDirs({
    env: { CLAUDE_USER_DATA_DIR: "/custom/dir", HOME },
    platform: "darwin",
    exists: () => true,
  });
  assert.deepEqual(dirs, ["/custom/dir"]);
});

test("macOS finds Claude and the enterprise Claude-3p build, and only ones that exist", () => {
  const base = `${HOME}/Library/Application Support`;
  const present = new Set([`${base}/Claude`]);
  assert.deepEqual(
    claudeDesktopConfigDirs({ env: { HOME }, platform: "darwin", exists: (d) => present.has(d) }),
    [`${base}/Claude`],
  );
  present.add(`${base}/Claude-3p`);
  assert.deepEqual(
    claudeDesktopConfigDirs({ env: { HOME }, platform: "darwin", exists: (d) => present.has(d) }),
    [`${base}/Claude`, `${base}/Claude-3p`],
  );
});

test("Windows writes BOTH the MSIX and roaming locations when both exist", () => {
  // The app reads the virtualised MSIX path while its own Edit Config button
  // opens %APPDATA%; they never sync, so picking one registers nothing for half
  // of users.
  const env = { LOCALAPPDATA: "C:\\Local", APPDATA: "C:\\Roaming", HOME };
  const dirs = claudeDesktopConfigDirs({ env, platform: "win32", exists: () => true });
  assert.ok(dirs.some((d) => d.includes("Roaming\\Claude") || d.includes("Roaming/Claude")), "roaming path present");
});

test("Linux is skipped rather than guessed", () => {
  assert.deepEqual(claudeDesktopConfigDirs({ env: { HOME }, platform: "linux", exists: () => true }), []);
});

test("the entry carries only the four keys Claude Desktop accepts", () => {
  const entry = claudeDesktopEntry({ node: "/opt/homebrew/bin/node", script: "/pkg/bin/relay.js", relayHome: "/h/.relay" });
  assert.deepEqual(Object.keys(entry).sort(), ["args", "command", "env"]);
  // A url/type/transport key can make the app rewrite the file and drop the
  // whole mcpServers section, taking other tools' servers with it.
  for (const banned of ["url", "type", "transport"]) {
    assert.ok(!(banned in entry), `${banned} must never be emitted`);
  }
  assert.equal(entry.command, "/opt/homebrew/bin/node");
  assert.deepEqual(entry.args, ["--max-old-space-size=32", "/pkg/bin/relay.js", "mcp"]);
});

test("merging preserves cowork settings and preferences, and only touches our key", () => {
  const existing = JSON.stringify({
    mcpServers: { someoneElse: { command: "/bin/other" } },
    coworkUserFilesPath: "/Users/tester/Claude",
    preferences: { deviceId: "abc", epitaxyPrefs: { "/repo": "ask" } },
  });
  const { text } = mergeClaudeDesktopConfig(existing, { command: "/n", args: [] }, { exists: () => true });
  const out = JSON.parse(text);
  assert.equal(out.coworkUserFilesPath, "/Users/tester/Claude");
  assert.deepEqual(out.preferences, { deviceId: "abc", epitaxyPrefs: { "/repo": "ask" } });
  assert.deepEqual(out.mcpServers.someoneElse, { command: "/bin/other" });
  assert.deepEqual(out.mcpServers.relay, { command: "/n", args: [] });
});

test("a missing or empty config produces a valid one rather than failing", () => {
  const { text } = mergeClaudeDesktopConfig("", { command: "/n", args: [] }, { exists: () => true });
  assert.deepEqual(JSON.parse(text).mcpServers.relay, { command: "/n", args: [] });
  assert.deepEqual(Object.keys(JSON.parse(text)), ["mcpServers"]);
});

test("malformed JSON is refused, never clobbered", () => {
  assert.throws(
    () => mergeClaudeDesktopConfig("{not json", { command: "/n" }, { exists: () => true }),
    /refusing to overwrite malformed/,
  );
  assert.throws(() => mergeClaudeDesktopConfig("[1,2]", { command: "/n" }, { exists: () => true }), /not a JSON object/);
});

test("our own key is overwritten every run so a stale path self-heals", () => {
  const existing = JSON.stringify({ mcpServers: { relay: { command: "/old/node", args: ["/gone/relay.js", "mcp"] } } });
  const { text } = mergeClaudeDesktopConfig(existing, { command: "/new/node", args: ["/pkg/relay.js", "mcp"] }, {
    exists: () => true,
  });
  assert.equal(JSON.parse(text).mcpServers.relay.command, "/new/node");
});

test("a dead legacy relay entry is detected and swept", () => {
  const dead = { command: "/n", args: ["/Users/x/src/snitch/relay-companion/bin/relay.js", "mcp"] };
  const live = { command: "/n", args: ["/opt/homebrew/lib/node_modules/relay-companion/bin/relay.js", "mcp"] };
  const onDisk = (p) => p.startsWith("/opt/homebrew");

  assert.equal(isDeadRelayEntry("relay_companion", dead, onDisk), true);
  assert.equal(isDeadRelayEntry("relay_companion", live, onDisk), false);
  // Someone else's server is never touched, whatever state it is in.
  assert.equal(isDeadRelayEntry("postgres", { command: "/n", args: ["/gone/relay.js"] }, onDisk), false);

  const existing = JSON.stringify({ mcpServers: { relay_companion: dead, other: { command: "/keep" } } });
  const { text, removed } = mergeClaudeDesktopConfig(existing, { command: "/n", args: [] }, { exists: onDisk });
  const out = JSON.parse(text);
  assert.deepEqual(removed, ["relay_companion"]);
  assert.ok(!("relay_companion" in out.mcpServers), "crash-looping stale entry swept");
  assert.deepEqual(out.mcpServers.other, { command: "/keep" });
});

test("a LIVE relay_companion entry is a duplicate of relay and is retired on install", () => {
  const live = { command: "/n", args: ["/opt/homebrew/lib/node_modules/relay-companion/bin/relay.js", "mcp"] };
  const launcher = { command: "/n", args: ["--max-old-space-size=96", "/Users/x/.relay/bin/mcp-launcher.cjs", "mcp"] };
  const onDisk = () => true;

  assert.equal(isLegacyRelayCompanionEntry("relay_companion", live), true);
  assert.equal(isLegacyRelayCompanionEntry("relay_companion", launcher), true);
  // Only the legacy NAME is ours to retire; a live relay-shaped server under
  // another name belongs to whoever wrote it.
  assert.equal(isLegacyRelayCompanionEntry("my_relay_fork", live), false);
  // The legacy name pointing at something that is not our product stays.
  assert.equal(isLegacyRelayCompanionEntry("relay_companion", { command: "/n", args: ["/srv/other-tool.js"] }), false);

  const existing = JSON.stringify({ mcpServers: { relay_companion: live, other: { command: "/keep" } } });
  const { text, removed } = mergeClaudeDesktopConfig(existing, { command: "/n", args: [] }, { exists: onDisk });
  const out = JSON.parse(text);
  assert.deepEqual(removed, ["relay_companion"]);
  assert.ok(!("relay_companion" in out.mcpServers), "live duplicate retired");
  assert.deepEqual(out.mcpServers.other, { command: "/keep" });
});

test("both bridge filenames are recognised, so an update never orphans a registration", () => {
  // The installed bridge used to carry a hash in its name; entries written by
  // those releases are still in people's configs alongside the stable name, and
  // both have to be matched or a dead one is left crash-looping forever.
  const stable = { command: "/Users/x/.relay/bin/mcp-bridge", args: ["--descriptor", "/Users/x/.relay/run/mcp/broker-v1.json"] };
  const stableExe = { command: "C:\\Users\\x\\.relay\\bin\\mcp-bridge.exe", args: [] };
  const fingerprinted = { command: "/Users/x/.relay/bin/mcp-bridge-0123456789abcdef", args: [] };

  assert.equal(isDeadRelayEntry("relay", stable, () => false), true);
  assert.equal(isDeadRelayEntry("relay", stable, () => true), false);
  assert.equal(isDeadRelayEntry("relay", stableExe, () => false), true);
  assert.equal(isDeadRelayEntry("relay", fingerprinted, () => false), true);
  assert.equal(isLegacyRelayCompanionEntry("relay_companion", stable), true);
  assert.equal(isLegacyRelayCompanionEntry("relay_companion", stableExe), true);

  // A bridge-shaped path outside ~/.relay/bin is not ours to declare dead.
  assert.equal(isDeadRelayEntry("relay", { command: "/opt/other/mcp-bridge", args: [] }, () => false), false);
});

test("the relay key is rewritten to the stable bridge even when it already holds a fingerprinted one", () => {
  const existing = JSON.stringify({
    mcpServers: { relay: { command: "/Users/x/.relay/bin/mcp-bridge-0123456789abcdef", args: ["--descriptor", "/d"] } },
  });
  const entry = { command: "/Users/x/.relay/bin/mcp-bridge", args: ["--descriptor", "/d"] };
  const { text } = mergeClaudeDesktopConfig(existing, entry, { exists: () => true });
  assert.deepEqual(JSON.parse(text).mcpServers.relay, entry);
});

test("node resolves to a stable symlink rather than a version-pinned Cellar path", () => {
  // Claude Desktop's curated PATH has no nvm/fnm shims, and /opt/homebrew/bin/node
  // survives a `brew upgrade node` where the Cellar path does not.
  const node = resolveStableNode({
    execPath: "/opt/homebrew/Cellar/node/26.0.0/bin/node",
    candidates: ["/opt/homebrew/bin/node"],
    exists: () => true,
    realpath: () => "/opt/homebrew/Cellar/node/26.0.0/bin/node",
  });
  assert.equal(node, "/opt/homebrew/bin/node");
});

test("a stable candidate pointing at a DIFFERENT node is not used", () => {
  const node = resolveStableNode({
    execPath: "/Users/x/.nvm/versions/node/v22/bin/node",
    candidates: ["/opt/homebrew/bin/node"],
    exists: () => true,
    realpath: (p) => (p === "/opt/homebrew/bin/node" ? "/opt/homebrew/Cellar/node/26/bin/node" : p),
  });
  assert.equal(node, "/Users/x/.nvm/versions/node/v22/bin/node", "falls back rather than pointing at the wrong runtime");
});

test("the codex binary bundled in the ChatGPT app is a candidate, so desktop-only users are covered", () => {
  const candidates = codexBinaryCandidates({ env: { HOME }, platform: "darwin" });
  assert.ok(candidates.includes("/Applications/ChatGPT.app/Contents/Resources/codex"));
  assert.ok(candidates.includes(path.join(HOME, "Applications", "ChatGPT.app", "Contents", "Resources", "codex")));
});
