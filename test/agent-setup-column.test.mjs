// SETUP (2026-10-07): the You page's "Your AIs" — every AI's true
// connection on this computer and on the web, and one verb for each.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  inspectAgentHostsAsync,
  claudeRelayLog,
  entryValidity,
  inspectAgentHosts,
  parseProcessTable,
  tomlRelayEntry,
} from "../src/agent-host-status.js";
import { connectAgentHost } from "../src/install.js";

const require = createRequire(import.meta.url);
const { createAgentConnections } = require("../overlay/agent-connections.cjs");
const here = path.dirname(fileURLToPath(import.meta.url));
const inbox = fs.readFileSync(path.join(here, "../overlay/inbox.html"), "utf8");
const main = fs.readFileSync(path.join(here, "../overlay/main.cjs"), "utf8");
const preload = fs.readFileSync(path.join(here, "../overlay/preload.cjs"), "utf8");

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rsc-"));
  const home = path.join(root, "home");
  const apps = path.join(root, "Applications");
  const bin = path.join(root, "bin");
  for (const dir of [home, apps, bin]) fs.mkdirSync(dir, { recursive: true });
  const app = (name) => { fs.mkdirSync(path.join(apps, `${name}.app`, "Contents", "MacOS"), { recursive: true }); return path.join(apps, `${name}.app`); };
  const launcher = path.join(home, ".relay", "bin", "mcp-launcher.cjs");
  fs.mkdirSync(path.dirname(launcher), { recursive: true });
  fs.writeFileSync(launcher, "");
  const entry = { command: process.execPath, args: ["--max-old-space-size=32", launcher, "mcp"] };
  const desktopConfig = path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
  return { root, home, apps, bin, app, launcher, entry, desktopConfig, write };
}
const at = (iso) => Date.parse(iso);
const ps = (rows) => rows.map(([pid, ppid, command, startedAt = at("2026-10-07T10:00:00Z")]) => ({ uid: process.getuid?.(), pid, ppid, command, startedAt }));

test("the process table, config readers and Claude's log are read exactly", () => {
  const rows = parseProcessTable("  501   812     1 Wed Oct  7 12:49:21 2026     /Applications/Claude.app/Contents/MacOS/Claude\n  0 1 0 Tue Oct  6 09:00:00 2026   /sbin/launchd\n");
  assert.equal(rows.length, 2);
  assert.deepEqual([rows[0].uid, rows[0].pid, rows[0].ppid, rows[0].command], [501, 812, 1, "/Applications/Claude.app/Contents/MacOS/Claude"]);
  assert.ok(rows[0].startedAt > 0);

  const toml = `[features]\nx = 1\n\n[mcp_servers.relay]\ncommand = "/Users/a/.relay/bin/mcp-bridge"\nargs = ["--descriptor", "/Users/a/.relay/run/mcp/broker-v1.json"]\n\n[mcp_servers.relay.tools.relay_topic_post]\napproval_mode = "approve"\n`;
  assert.deepEqual(tomlRelayEntry(toml), { command: "/Users/a/.relay/bin/mcp-bridge", args: ["--descriptor", "/Users/a/.relay/run/mcp/broker-v1.json"] });
  assert.equal(tomlRelayEntry("[mcp_servers.other]\ncommand = \"x\"\n"), null);

  assert.deepEqual(entryValidity({ command: "npx", args: [] }), { command: "npx", valid: false }, "a bare command cannot be found by a GUI app");
  assert.equal(entryValidity({ command: process.execPath, args: ["/nowhere/relay.js", "mcp"] }).valid, false, "a dead script is not valid");

  const log = [
    "2026-10-07T10:48:58.703Z [info] [relay] Server started and connected successfully",
    "2026-10-07T13:15:12.469Z [error] [relay] Server disconnected. For troubleshooting guidance",
    "2026-10-07T13:15:12.470Z [info] [other] Server started and connected successfully",
  ].join("\n");
  assert.deepEqual(claudeRelayLog(log, at("2026-10-07T10:00:00Z")), { started: at("2026-10-07T10:48:58.703Z"), failed: at("2026-10-07T13:15:12.469Z") });
  assert.deepEqual(claudeRelayLog(log, at("2026-10-07T14:00:00Z")), { started: 0, failed: 0 }, "only since the app's launch");
});

test("each app on this computer has one true state, from its own config and processes", () => {
  const box = sandbox();
  const claude = box.app("Claude");
  const chatgpt = box.app("ChatGPT");
  box.app("Conductor");
  fs.writeFileSync(path.join(box.bin, "claude"), "");
  const env = { HOME: box.home, RELAY_OVERLAY_TEST_APPS_DIR: box.apps, RELAY_OVERLAY_TEST_BIN_DIR: box.bin };
  const now = at("2026-10-07T12:00:00Z");
  const state = (processes = []) => Object.fromEntries(inspectAgentHosts({ env, platform: "darwin", processes: ps(processes), now }).hosts.map((host) => [host.id, host]));

  // Installed after Relay: nothing registered anywhere yet.
  let hosts = state();
  assert.deepEqual(Object.values(hosts).map((h) => [h.id, h.installed, h.state]), [
    ["claude-app", true, "available"], ["chatgpt-app", true, "available"], ["claude-code", true, "available"], ["codex", false, "absent"], ["conductor", true, "available"],
  ]);

  // Registered: the ChatGPT app (Codex) has Relay in new chats; nothing to restart.
  box.write(path.join(box.home, ".codex", "config.toml"), `[mcp_servers.relay]\ncommand = "${box.entry.command}"\nargs = ["--max-old-space-size=32", "${box.launcher}", "mcp"]\n`);
  box.write(box.desktopConfig, JSON.stringify({ mcpServers: { relay: box.entry } }));
  hosts = state();
  assert.equal(hosts["chatgpt-app"].state, "connected");
  assert.equal(hosts["conductor"].state, "connected", "Conductor has Relay through Codex");
  assert.equal(hosts["claude-app"].state, "connected", "not running: it loads Relay when it opens");

  // The Claude app was already open and has not loaded it: one restart.
  const claudeMain = [100, 1, `${claude}/Contents/MacOS/Claude`, at("2026-10-07T11:00:00Z")];
  hosts = state([claudeMain]);
  assert.equal(hosts["claude-app"].state, "restart");
  assert.equal(hosts["claude-app"].stopped, false);

  // A Relay bridge running under it is the evidence that it works right now.
  const bridge = [101, 100, `${box.home}/.relay/bin/mcp-bridge --descriptor x`];
  hosts = state([claudeMain, bridge]);
  assert.equal(hosts["claude-app"].state, "connected");
  assert.equal(hosts["claude-app"].live, true);
  // Someone else's bridge, or another home's, is not this person's.
  hosts = state([claudeMain, [102, 100, "/Users/other/.relay/bin/mcp-bridge --descriptor y"]]);
  assert.equal(hosts["claude-app"].live, false);

  // Started, then stopped (a Relay update): restart. Never started and failed: broken.
  const log = path.join(box.home, "Library", "Logs", "Claude", "mcp.log");
  box.write(log, "2026-10-07T11:00:05.000Z [info] [relay] Server started and connected successfully\n2026-10-07T11:30:00.000Z [error] [relay] Server disconnected.\n");
  hosts = state([claudeMain]);
  assert.deepEqual([hosts["claude-app"].state, hosts["claude-app"].stopped], ["restart", true]);
  box.write(log, "2026-10-07T11:00:05.000Z [error] [relay] spawn ENOENT\n");
  assert.equal(state([claudeMain])["claude-app"].state, "broken");

  // A registration pointing at a deleted checkout is broken, not connected.
  box.write(path.join(box.home, ".claude.json"), JSON.stringify({ mcpServers: { relay: { command: process.execPath, args: ["/Users/old/relay/bin/relay.js", "mcp"] } } }));
  assert.equal(state()["claude-code"].state, "broken");

  // Codex in the ChatGPT app: a bridge under its app-server is live.
  hosts = state([[200, 1, `${chatgpt}/Contents/MacOS/ChatGPT`], [201, 200, `${chatgpt}/Contents/Resources/codex app-server`], [202, 201, `${box.home}/.relay/bin/mcp-bridge --descriptor x`]]);
  assert.equal(hosts["chatgpt-app"].live, true);
  assert.equal(hosts["claude-app"].live, false);
  fs.rmSync(box.root, { recursive: true, force: true });
});

test("the pill's main process gets the same answer without blocking on a child process", async () => {
  const box = sandbox();
  box.app("Claude");
  const env = { HOME: box.home, RELAY_OVERLAY_TEST_APPS_DIR: box.apps, RELAY_OVERLAY_TEST_BIN_DIR: box.bin };
  const answer = await inspectAgentHostsAsync({ env, platform: "darwin" });
  assert.deepEqual(answer.hosts.map((host) => [host.id, host.state]), [["claude-app", "available"], ["chatgpt-app", "absent"], ["claude-code", "absent"], ["codex", "absent"], ["conductor", "absent"]]);
  fs.rmSync(box.root, { recursive: true, force: true });
});

test("Connect writes exactly what setup writes, for that one app", () => {
  const box = sandbox();
  const env = { HOME: box.home, RELAY_CONFIG_DIR: path.join(box.root, "relay"), CLAUDE_USER_DATA_DIR: path.join(box.home, "ClaudeData") };
  fs.mkdirSync(env.CLAUDE_USER_DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(env.CLAUDE_USER_DATA_DIR, "claude_desktop_config.json"), JSON.stringify({ preferences: { keep: true }, mcpServers: { other: { command: "/bin/echo" } } }));
  const options = { homeDir: box.home, env, node: process.execPath };

  assert.deepEqual(connectAgentHost("anything", options), { ok: false, reason: "unknown_host" });
  const claude = connectAgentHost("claude-app", options);
  assert.equal(claude.ok, true, JSON.stringify(claude));
  assert.equal(claude.restart, true, "the Claude app reads its config at launch");
  const desktop = JSON.parse(fs.readFileSync(path.join(env.CLAUDE_USER_DATA_DIR, "claude_desktop_config.json"), "utf8"));
  assert.deepEqual(desktop.preferences, { keep: true }, "merged, never replaced");
  assert.ok(desktop.mcpServers.other && desktop.mcpServers.relay);
  assert.deepEqual(Object.keys(desktop.mcpServers.relay).sort().filter((key) => !["command", "args", "env"].includes(key)), [], "only the keys Claude accepts");

  // The ChatGPT app before Codex has ever run: ~/.codex is created.
  const codex = connectAgentHost("chatgpt-app", options);
  assert.equal(codex.ok, true, JSON.stringify(codex));
  assert.match(fs.readFileSync(path.join(box.home, ".codex", "config.toml"), "utf8"), /\[mcp_servers\.relay\]/);
  assert.equal(fs.existsSync(path.join(box.home, ".claude.json")), false, "no other app is opted in");

  fs.writeFileSync(path.join(box.home, ".claude.json"), JSON.stringify({ numStartups: 4 }));
  const code = connectAgentHost("claude-code", options);
  assert.equal(code.ok, true, JSON.stringify(code));
  const claudeJson = JSON.parse(fs.readFileSync(path.join(box.home, ".claude.json"), "utf8"));
  assert.equal(claudeJson.numStartups, 4);
  assert.ok(claudeJson.mcpServers.relay);
  fs.rmSync(box.root, { recursive: true, force: true });
});

test("the nudge names one app worth connecting, once, and connecting says what happens next", async () => {
  let hosts = [
    { id: "claude-app", installed: true, state: "available", running: true, live: false },
    { id: "chatgpt-app", installed: true, state: "available", running: false, live: false },
    { id: "conductor", installed: true, state: "available" },
    { id: "codex", installed: false, state: "absent" },
  ];
  const store = {};
  let connected = [];
  const connections = createAgentConnections({
    inspect: async () => ({ hosts: hosts.map((host) => ({ ...host })), scannedAt: 1 }),
    client: async () => ({ agentConnections: async () => ({ connections: [] }), disconnectAgentConnection: async () => ({ ok: true }) }),
    runConnect: async (id) => {
      connected.push(id);
      hosts = hosts.map((host) => host.id === id ? { ...host, state: id === "claude-app" ? "restart" : "connected" } : host);
      return { ok: true, restart: id === "claude-app" };
    },
    restartApp: async () => {},
    store,
    persist: () => {},
  });
  await connections.refresh("user:a", { force: true });
  assert.deepEqual(connections.nudge("user:a"), { id: "claude-app", state: "available" });
  connections.dismissNudge("user:a", "claude-app", "available");
  assert.deepEqual(connections.nudge("user:a"), { id: "chatgpt-app", state: "available" }, "waved away: the next one, never the same one again");
  assert.ok(store["user:a"].dismissed["claude-app:available"]);

  await connections.connect("user:a", "claude-app");
  assert.deepEqual(connected, ["claude-app"]);
  assert.deepEqual(connections.snapshot("user:a").notes["claude-app"], { tone: "next", text: "" }, "registered, and a restart is the next step");
  assert.deepEqual(connections.nudge("user:a"), { id: "claude-app", state: "restart" }, "a new state may be said once more");
  await connections.connect("user:a", "chatgpt-app");
  assert.equal(connections.snapshot("user:a").notes["chatgpt-app"].tone, "done");

  // Conductor is a developer preview: never its own nudge without the row.
  hosts = hosts.map((host) => ({ ...host, state: host.id === "conductor" ? "available" : host.installed ? "connected" : host.state }));
  await connections.refresh("user:a", { force: true });
  assert.equal(connections.nudge("user:a"), null);
  assert.deepEqual(connections.nudge("user:a", { rider: true }), { id: "conductor", state: "available" });
  await assert.rejects(connections.restart("user:a", "chatgpt-app"), /Only the Claude app/);
});

test("the pill draws Your AIs from that evidence, first on the You page, with the inbox's one quiet word", () => {
  for (const method of ["setupSnapshot", "setupConnect", "setupRestart", "setupDisconnect", "setupDismissNudge", "setupPrepareRun", "setupPollRun", "setupCopyRun", "setupOpenRun", "setupCancelRun"]) {
    assert.match(preload, new RegExp(`${method}: \\(userId`), `${method} is bridged with the account it is for`);
  }
  // Every verb answers only for the account still on screen.
  assert.match(main, /function setupIpc\(operation\) \{\s*return async \(_event, expectedUserId, \.\.\.args\) => \{\s*if \(!expectedUserId \|\| account\(\)\.userId !== expectedUserId\) throw/);
  // Chat AIs connect through the first-run chooser's own setup request: one flow.
  assert.match(main, /ipcMain\.handle\("relay:setupPrepareRun", setupIpc\(async \(key, surface, place\) => \{\s*await agentOnboarding\.prepareRun\(/);
  // Connecting runs Relay's own registration code, never a hand edit.
  assert.match(main, /spawn\(node\.command, \[RELAY_CLI, "connect-host", hostId\]/);
  // The test seam never touches a real app.
  assert.match(main, /if \(testApps && !String\(host\.where \|\| ""\)\.startsWith\(testApps\)\) throw/);

  const settings = inbox.slice(inbox.indexOf("function renderSettings()"), inbox.indexOf("function wireSettings()"));
  assert.match(settings, /if \(window\.relay\.setupSnapshot\) html \+= setupEntryHtml\(\);\s*html \+= yourLinkHtml\(\);/);
  assert.match(inbox, /<div id="relaysIntro" hidden><div id="relaysRequestsSummary"><\/div><div id="setupNudge"><\/div><div id="relayAnyoneTip" hidden><\/div><\/div>/);

  // "Connected" only from a registered, valid entry; "working now" only from a live bridge.
  const status = inbox.slice(inbox.indexOf("function setupLocalStatus(host)"), inbox.indexOf("function setupDotHtml("));
  assert.match(status, /if \(host\.state === "available"\)/);
  assert.match(status, /if \(host\.state === "broken"\)/);
  assert.match(status, /if \(host\.state === "restart"\)/);
  assert.match(status, /if \(host\.live\) return \{ dot:"live", text:`Connected · /);
  // Disconnect asks twice; restart says what it does.
  assert.match(inbox, /if \(setupArmed !== id\) \{ setupArmed = id; renderSettings\(\); return; \}/);
  assert.match(inbox, /title:"Quits and reopens Claude"/);
  // Conductor exists here only for accounts offered it.
  assert.match(inbox, /const SETUP_RIDER = "conductor"; const setupRiderOffered = \(\) => payload\.features\?\.conductor === true;/);
});
