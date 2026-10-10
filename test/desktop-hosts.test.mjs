import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import {
  claudeDesktopConfigDirs,
  isRelayOwnedDesktopEntry,
  retireRelayFromClaudeDesktopConfig,
} from "../src/desktop-hosts.js";
import installedApps from "../src/installed-apps.cjs";

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

// THE CLAUDE APP USES RELAY'S CONNECTOR (David, 2026-10-10): Relay never
// writes claude_desktop_config.json, and takes out only the entry it wrote.

test("every shape Relay ever wrote is recognised as Relay's, and nothing else is", () => {
  const owned = [
    { command: "/Users/x/.relay/bin/mcp-bridge", args: ["--descriptor", "/Users/x/.relay/run/mcp/broker-v1.json"] },
    { command: "/Users/x/.relay/bin/mcp-bridge-0123456789abcdef", args: [] },
    { command: "C:\\Users\\x\\.relay\\bin\\mcp-bridge.exe", args: [] },
    { command: "/opt/homebrew/bin/node", args: ["--max-old-space-size=32", "/Users/x/.relay/bin/mcp-launcher.cjs", "mcp"], env: { RELAY_HOME: "/h" } },
    { command: "/n", args: ["/opt/homebrew/lib/node_modules/relay-companion/bin/relay.js", "mcp"] },
    { command: "/n", args: ["/Users/x/src/relay/packages/companion/bin/relay.js", "mcp"] },
    { command: "npx", args: ["-y", "relay-companion@latest", "mcp"] },
  ];
  for (const entry of owned) {
    assert.equal(isRelayOwnedDesktopEntry("relay", entry), true, JSON.stringify(entry));
    assert.equal(isRelayOwnedDesktopEntry("relay_companion", entry), true, JSON.stringify(entry));
  }
  // Another name is someone else's, whatever it runs.
  assert.equal(isRelayOwnedDesktopEntry("my_relay_fork", owned[0]), false);
  assert.equal(isRelayOwnedDesktopEntry("postgres", owned[3]), false);
  // Relay's name pointing at something that is not Relay stays.
  assert.equal(isRelayOwnedDesktopEntry("relay", { command: "/opt/other/mcp-bridge", args: [] }), false);
  assert.equal(isRelayOwnedDesktopEntry("relay", { command: "/n", args: ["/srv/other-tool.js"] }), false);
  assert.equal(isRelayOwnedDesktopEntry("relay", { url: "https://relay.example/mcp" }), false);
  assert.equal(isRelayOwnedDesktopEntry("relay", null), false);
});

test("retiring takes out only Relay's entries and keeps every other server and key", () => {
  const existing = JSON.stringify({
    mcpServers: {
      someoneElse: { command: "/bin/other" },
      relay: { command: "/Users/x/.relay/bin/mcp-bridge", args: ["--descriptor", "/d"] },
      relay_companion: { command: "/n", args: ["/Users/x/.relay/bin/mcp-launcher.cjs", "mcp"] },
    },
    coworkUserFilesPath: "/Users/tester/Claude",
    preferences: { deviceId: "abc", epitaxyPrefs: { "/repo": "ask" } },
    unknownKey: [1, 2],
  });
  const { text, removed } = retireRelayFromClaudeDesktopConfig(existing);
  assert.deepEqual(removed, ["relay", "relay_companion"]);
  assert.deepEqual(JSON.parse(text), {
    mcpServers: { someoneElse: { command: "/bin/other" } },
    coworkUserFilesPath: "/Users/tester/Claude",
    preferences: { deviceId: "abc", epitaxyPrefs: { "/repo": "ask" } },
    unknownKey: [1, 2],
  });
  // Idempotent: the second pass finds nothing and asks for no write.
  assert.deepEqual(retireRelayFromClaudeDesktopConfig(text), { text: null, removed: [] });
});

test("nothing of Relay's means nothing to write; an unparseable file is refused, never clobbered", () => {
  assert.deepEqual(retireRelayFromClaudeDesktopConfig(""), { text: null, removed: [] });
  assert.deepEqual(retireRelayFromClaudeDesktopConfig(JSON.stringify({ preferences: {} })), { text: null, removed: [] });
  assert.deepEqual(retireRelayFromClaudeDesktopConfig(JSON.stringify({ mcpServers: { relay: { command: "/srv/mine" } } })), { text: null, removed: [] });
  assert.throws(() => retireRelayFromClaudeDesktopConfig("{not json"), /refusing to rewrite malformed/);
  assert.throws(() => retireRelayFromClaudeDesktopConfig("[1,2]"), /not a JSON object/);
});

test("the codex binary bundled in the ChatGPT app is found, so desktop-only users are covered", () => {
  const found = (present, platform = "darwin", env = { HOME }) => installedApps.codexAppBinary({ env, platform, exists: (p) => present.includes(p),
    readdir: (dir) => (dir === String.raw`C:\Local\OpenAI\Codex\bin` ? ["aaa", "bbb"] : []) });
  assert.equal(found(["/Applications/ChatGPT.app/Contents/Resources/codex"]), "/Applications/ChatGPT.app/Contents/Resources/codex");
  const mine = path.posix.join(HOME, "Applications", "ChatGPT.app", "Contents", "Resources", "codex");
  assert.equal(found([mine]), mine);
  // Windows: the Store app keeps its codex.exe under %LOCALAPPDATA%\OpenAI\Codex\bin\<build>.
  const win = String.raw`C:\Local\OpenAI\Codex\bin\bbb\codex.exe`;
  assert.equal(found([win], "win32", { LOCALAPPDATA: String.raw`C:\Local` }), win);
  assert.equal(found([], "linux"), "");
});
