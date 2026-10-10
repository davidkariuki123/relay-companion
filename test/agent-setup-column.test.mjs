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
  entryValidity,
  inspectAgentHosts,
  parseProcessTable,
  tomlRelayEntry,
} from "../src/agent-host-status.js";
import { connectAgentHost } from "../src/install.js";

const require = createRequire(import.meta.url);
const { createAgentConnections, claudeConnectorState, withClaudeConnector } = require("../overlay/agent-connections.cjs");
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

test("the process table and config readers are read exactly", () => {
  const rows = parseProcessTable("  501   812     1 Wed Oct  7 12:49:21 2026     /Applications/Claude.app/Contents/MacOS/Claude\n  0 1 0 Tue Oct  6 09:00:00 2026   /sbin/launchd\n");
  assert.equal(rows.length, 2);
  assert.deepEqual([rows[0].uid, rows[0].pid, rows[0].ppid, rows[0].command], [501, 812, 1, "/Applications/Claude.app/Contents/MacOS/Claude"]);
  assert.ok(rows[0].startedAt > 0);

  const toml = `[features]\nx = 1\n\n[mcp_servers.relay]\ncommand = "/Users/a/.relay/bin/mcp-bridge"\nargs = ["--descriptor", "/Users/a/.relay/run/mcp/broker-v1.json"]\n\n[mcp_servers.relay.tools.relay_topic_post]\napproval_mode = "approve"\n`;
  assert.deepEqual(tomlRelayEntry(toml), { command: "/Users/a/.relay/bin/mcp-bridge", args: ["--descriptor", "/Users/a/.relay/run/mcp/broker-v1.json"] });
  assert.equal(tomlRelayEntry("[mcp_servers.other]\ncommand = \"x\"\n"), null);

  assert.deepEqual(entryValidity({ command: "npx", args: [] }), { command: "npx", valid: false }, "a bare command cannot be found by a GUI app");
  assert.equal(entryValidity({ command: process.execPath, args: ["/nowhere/relay.js", "mcp"] }).valid, false, "a dead script is not valid");
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

  // Installed after Relay: nothing registered anywhere yet. The Claude app's
  // chats use Relay's connector, which only the server knows: "checking".
  let hosts = state();
  assert.deepEqual(Object.values(hosts).map((h) => [h.id, h.installed, h.state]), [
    ["claude-app", true, "checking"], ["chatgpt-app", true, "available"], ["claude-code", true, "available"], ["codex", false, "absent"], ["conductor", true, "available"],
  ]);

  // Registered: the ChatGPT app (Codex) has Relay in new chats; nothing to restart.
  box.write(path.join(box.home, ".codex", "config.toml"), `[mcp_servers.relay]\ncommand = "${box.entry.command}"\nargs = ["--max-old-space-size=32", "${box.launcher}", "mcp"]\n`);
  box.write(box.desktopConfig, JSON.stringify({ mcpServers: { relay: box.entry } }));
  hosts = state();
  assert.equal(hosts["chatgpt-app"].state, "connected");
  assert.equal(hosts["conductor"].state, "connected", "Conductor has Relay through Codex");
  // A local Relay entry an older Relay wrote in the Claude app's config, a
  // running app with no Relay since it opened, or a bridge still under it:
  // none of it says anything about the connector, never a restart or a fix.
  const claudeMain = [100, 1, `${claude}/Contents/MacOS/Claude`, at("2026-10-07T11:00:00Z")];
  const bridge = [101, 100, `${box.home}/.relay/bin/mcp-bridge --descriptor x`];
  const log = path.join(box.home, "Library", "Logs", "Claude", "mcp.log");
  box.write(log, "2026-10-07T11:00:05.000Z [info] [relay] Server started and connected successfully\n2026-10-07T11:30:00.000Z [error] [relay] Server disconnected.\n");
  for (const rows of [[], [claudeMain], [claudeMain, bridge]]) {
    const scan = inspectAgentHosts({ env, platform: "darwin", processes: ps(rows), now });
    const app = scan.hosts.find((host) => host.id === "claude-app");
    assert.deepEqual([app.state, app.registered, app.live, app.via, app.configPath], ["checking", false, false, "connector", ""]);
    assert.equal(app.running, rows.length > 0);
    assert.deepEqual([scan.places["claude-chat"].connected, scan.places["claude-chat"].action, scan.places["claude-chat"].reason], [null, undefined, undefined]);
  }

  // A registration pointing at a deleted checkout is broken, not connected.
  box.write(path.join(box.home, ".claude.json"), JSON.stringify({ mcpServers: { relay: { command: process.execPath, args: ["/Users/old/relay/bin/relay.js", "mcp"] } } }));
  assert.equal(state()["claude-code"].state, "broken");

  // Codex in the ChatGPT app: a bridge under its app-server is live.
  hosts = state([[200, 1, `${chatgpt}/Contents/MacOS/ChatGPT`], [201, 200, `${chatgpt}/Contents/Resources/codex app-server`], [202, 201, `${box.home}/.relay/bin/mcp-bridge --descriptor x`]]);
  assert.equal(hosts["chatgpt-app"].live, true);
  assert.equal(hosts["claude-app"].live, false);
  // No Claude app here: absent, and its chats are not a place on this computer.
  fs.rmSync(claude, { recursive: true, force: true });
  const gone = inspectAgentHosts({ env, platform: "darwin", processes: [], now });
  assert.equal(gone.hosts.find((host) => host.id === "claude-app").state, "absent");
  assert.deepEqual([gone.places["claude-chat"].installed, gone.places["claude-chat"].connected], [false, false]);
  fs.rmSync(box.root, { recursive: true, force: true });
});

test("the pill's main process gets the same answer without blocking on a child process", async () => {
  const box = sandbox();
  box.app("Claude");
  const env = { HOME: box.home, RELAY_OVERLAY_TEST_APPS_DIR: box.apps, RELAY_OVERLAY_TEST_BIN_DIR: box.bin };
  const answer = await inspectAgentHostsAsync({ env, platform: "darwin" });
  assert.deepEqual(answer.hosts.map((host) => [host.id, host.state]), [["claude-app", "checking"], ["chatgpt-app", "absent"], ["claude-code", "absent"], ["codex", "absent"], ["conductor", "absent"]]);
  fs.rmSync(box.root, { recursive: true, force: true });
});

test("Connect writes exactly what setup writes, for that one app, and never the Claude app's config", () => {
  const box = sandbox();
  const env = { HOME: box.home, RELAY_CONFIG_DIR: path.join(box.root, "relay"), CLAUDE_USER_DATA_DIR: path.join(box.home, "ClaudeData") };
  fs.mkdirSync(env.CLAUDE_USER_DATA_DIR, { recursive: true });
  const desktopFile = path.join(env.CLAUDE_USER_DATA_DIR, "claude_desktop_config.json");
  fs.writeFileSync(desktopFile, JSON.stringify({ preferences: { keep: true }, mcpServers: { other: { command: "/bin/echo" }, relay: { command: `${box.home}/.relay/bin/mcp-bridge`, args: ["--descriptor", "x"] } } }));
  const options = { homeDir: box.home, env, node: process.execPath };

  assert.deepEqual(connectAgentHost("anything", options), { ok: false, reason: "unknown_host" });
  // The Claude app's chats use Relay's connector: nothing is written, and the
  // local entry an older Relay wrote is taken out.
  const claude = connectAgentHost("claude-app", options);
  assert.deepEqual([claude.ok, claude.reason, claude.restart], [false, "claude_app_uses_connector", false]);
  const desktop = JSON.parse(fs.readFileSync(desktopFile, "utf8"));
  assert.deepEqual(desktop, { preferences: { keep: true }, mcpServers: { other: { command: "/bin/echo" } } });
  assert.equal(fs.existsSync(path.join(box.home, ".relay", "bin", "mcp-launcher.cjs")), true, "the sandbox's launcher, untouched");

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
    { id: "claude-app", installed: true, state: "checking", running: true, live: false },
    { id: "chatgpt-app", installed: true, state: "available", running: false, live: false },
    { id: "conductor", installed: true, state: "available" },
    { id: "codex", installed: false, state: "absent" },
  ];
  const places = { "claude-chat": { installed: true, host: "claude-app", connected: null, live: false, usedAt: 0 } };
  const store = {};
  const connected = [];
  const claudeOpened = [];
  let serverConnections = [];
  const connections = createAgentConnections({
    inspect: async () => ({ hosts: hosts.map((host) => ({ ...host })), places, scannedAt: 1 }),
    client: async () => ({ agentConnections: async () => ({ connections: serverConnections }), disconnectAgentConnection: async () => ({ ok: true }) }),
    runConnect: async (id) => {
      connected.push(id);
      hosts = hosts.map((host) => host.id === id ? { ...host, state: "connected" } : host);
      return { ok: true };
    },
    connectClaude: async (key) => { claudeOpened.push(key); },
    store,
    persist: () => {},
  });
  // Before the server has answered, the Claude app is never a nudge.
  assert.deepEqual(connections.nudge("user:a"), null);
  await connections.refresh("user:a", { force: true });
  // The account has no Claude connector: the Claude app is worth connecting.
  assert.deepEqual(connections.nudge("user:a"), { id: "claude-app", state: "available" });
  assert.deepEqual(connections.snapshot("user:a").places["claude-chat"], { installed: true, host: "claude-app", connected: false, action: "connect", live: false, usedAt: 0 });
  connections.dismissNudge("user:a", "claude-app", "available");
  assert.deepEqual(connections.nudge("user:a"), { id: "chatgpt-app", state: "available" }, "waved away: the next one, never the same one again");
  assert.ok(store["user:a"].dismissed["claude-app:available"]);

  // Connecting the Claude app opens Claude's add-connector screen; it never
  // registers anything on this computer.
  await connections.connect("user:a", "claude-app");
  assert.deepEqual([connected, claudeOpened], [[], ["user:a"]]);
  assert.deepEqual(connections.snapshot("user:a").notes["claude-app"], { tone: "next", text: "" }, "Claude's screen is open: the next step is there");
  assert.equal(connections.snapshot("user:a").busy["claude-app"], undefined);
  // The server's list says the connector is there: Connected, no nudge.
  serverConnections = [{ id: "c1", kind: "connector", surface: "claude", name: "Claude", createdAt: new Date().toISOString(), lastUsedAt: null }];
  await connections.refresh("user:a", { force: true });
  const snap = connections.snapshot("user:a");
  assert.equal(snap.hosts.find((host) => host.id === "claude-app").state, "connected");
  assert.equal(snap.places["claude-chat"].connected, true);
  assert.equal(snap.places["claude-chat"].action, undefined);
  assert.deepEqual(connections.nudge("user:a"), { id: "chatgpt-app", state: "available" });
  await connections.connect("user:a", "chatgpt-app");
  assert.deepEqual(connected, ["chatgpt-app"]);
  assert.equal(connections.snapshot("user:a").notes["chatgpt-app"].tone, "done");

  // Conductor is a developer preview: never its own nudge without the row.
  hosts = hosts.map((host) => ({ ...host, state: host.id === "conductor" ? "available" : host.id === "claude-app" ? "checking" : host.installed ? "connected" : host.state }));
  await connections.refresh("user:a", { force: true });
  assert.equal(connections.nudge("user:a"), null);
  assert.deepEqual(connections.nudge("user:a", { rider: true }), { id: "conductor", state: "available" });
  assert.equal(typeof connections.restart, "undefined", "there is no restart to ask for");
});

test("the Claude app's chats are the account's Claude connector, from the server's own list", () => {
  const now = Date.parse("2026-10-10T12:00:00Z");
  const iso = (days) => new Date(now - days * 24 * 60 * 60 * 1000).toISOString();
  assert.equal(claudeConnectorState(null, now), null, "not known is never a guess");
  assert.equal(claudeConnectorState([], now), false);
  assert.equal(claudeConnectorState([{ kind: "credential", surface: "claude", createdAt: iso(1) }], now), false, "a setup code is not the connector");
  assert.equal(claudeConnectorState([{ kind: "connector", surface: "chatgpt", createdAt: iso(1) }], now), false);
  assert.equal(claudeConnectorState([{ kind: "connector", surface: "claude", createdAt: iso(90), lastUsedAt: iso(2) }], now), true);
  assert.equal(claudeConnectorState([{ kind: "connector", surface: "claude", createdAt: iso(90), lastUsedAt: iso(45) }], now), false, "a leftover Claude has not reached in 30 days");

  const scan = { hosts: [{ id: "claude-app", installed: true, state: "checking" }, { id: "codex", installed: true, state: "connected" }],
    places: { "claude-chat": { installed: true, connected: null }, "codex:terminal": { installed: true, connected: true } } };
  assert.deepEqual(withClaudeConnector(scan, true).hosts[0], { id: "claude-app", installed: true, state: "connected", registered: true, valid: true });
  assert.deepEqual(withClaudeConnector(scan, false).places["claude-chat"], { installed: true, connected: false, action: "connect" });
  assert.deepEqual(withClaudeConnector(scan, null).hosts[0].state, "checking");
  assert.deepEqual(withClaudeConnector(scan, null).places["claude-chat"].connected, null);
  assert.equal(withClaudeConnector(scan, false).hosts[1], scan.hosts[1], "every other app is its own config's answer");
  const absent = { hosts: [{ id: "claude-app", installed: false, state: "absent" }], places: { "claude-chat": { installed: false, connected: false } } };
  assert.deepEqual(withClaudeConnector(absent, true).hosts[0].state, "absent");
  assert.deepEqual(withClaudeConnector(absent, true).places["claude-chat"].connected, false);
});

test("the pill draws Your AIs from that evidence, first on the You page, with the inbox's one quiet word", () => {
  for (const method of ["setupSnapshot", "setupConnect", "setupDisconnect", "setupDismissNudge", "setupPrepareRun", "setupPollRun", "setupCopyRun", "setupOpenRun", "setupCancelRun"]) {
    assert.match(preload, new RegExp(`${method}: \\(userId`), `${method} is bridged with the account it is for`);
  }
  // Every verb answers only for the account still on screen.
  assert.match(main, /function setupIpc\(operation\) \{\s*return async \(_event, expectedUserId, \.\.\.args\) => \{\s*if \(!expectedUserId \|\| account\(\)\.userId !== expectedUserId\) throw/);
  // Chat AIs connect through the first-run chooser's own setup request: one flow.
  assert.match(main, /ipcMain\.handle\("relay:setupPrepareRun", setupIpc\(async \(key, surface, place\) => \{\s*await agentOnboarding\.prepareRun\(/);
  // Connecting runs Relay's own registration code, never a hand edit.
  assert.match(main, /spawn\(node\.command, \[RELAY_CLI, "connect-host", hostId\]/);
  // The Claude app's Connect is Claude's connector, never a local registration,
  // and Relay never quits and reopens Claude.
  assert.match(main, /connectClaude: \(key\) => agentOnboarding\.connectClaude\(key\)/);
  assert.doesNotMatch(main, /restartAgentApp|relay:setupRestart|tell application id/);
  assert.doesNotMatch(preload, /setupRestart/);

  const settings = inbox.slice(inbox.indexOf("function renderSettings()"), inbox.indexOf("function wireSettings()"));
  // Your AIs first; Slack, the other thing Relay connects to, shares its card
  // right after it, and the invite link follows that card.
  assert.match(settings, /const connections = `\$\{window\.relay\.setupSnapshot \? setupEntryHtml\(\) : ""\}\$\{slackSettingsHtml\(info\)\}`;\s*if \(connections\) html \+= `<div class="sv-group" data-stop="1"><div class="sv-open-list">\$\{connections\}<\/div><\/div>`;\s*html \+= yourLinkHtml\(\);/);
  // Nothing on You sits above that card but your name.
  assert.ok(settings.indexOf('<div class="sv-profile">') < settings.indexOf("const connections ="), "the profile heads the page");
  assert.match(settings, /if \(info\.paired\) \{\s*const connections =/, "the connections card is the paired page's first card");
  // The door is one row: "Your AIs", a line only when something needs doing
  // (warn when an app does), otherwise the app marks; then the chevron.
  const entry = inbox.slice(inbox.indexOf("function setupEntryHtml()"), inbox.indexOf("async function refreshSetup("));
  assert.match(entry, /<button class="sv-row setup-entry" type="button" id="setupEntry">/);
  assert.match(entry, /<span class="sv-row-name">Your AIs<\/span>\$\{attention \? `<span class="sv-row-sub\$\{first \? " warn" : ""\}">/);
  assert.match(entry, /\$\{!attention && shown\.length \? `<span class="setup-marks" aria-hidden="true">/);
  assert.match(entry, /<svg class="sv-row-chev"/);
  // The inbox's one quiet word is the setup nudge; the Slack row is its sibling.
  assert.match(inbox, /<div id="relaysIntro" hidden><div id="relaysRequestsSummary"><\/div><div id="setupNudge"><\/div><div id="slackNudge"><\/div><div id="relayAnyoneTip" hidden><\/div><\/div>/);

  // "Connected" only from a registered, valid entry; "working now" only from a live bridge.
  const status = inbox.slice(inbox.indexOf("function setupLocalStatus(host)"), inbox.indexOf("function setupDotHtml("));
  assert.match(status, /if \(host\.state === "available"\)/);
  assert.match(status, /if \(host\.state === "broken"\)/);
  assert.match(status, /if \(host\.live\) return \{ dot:"live", text:`Connected · /);
  // Disconnect asks twice.
  assert.match(inbox, /if \(setupArmed !== id\) \{ setupArmed = id; renderSettings\(\); return; \}/);
  // No restart, no "stopped" alarm for the Claude app, anywhere in the pill.
  for (const gone of [/Relay stopped in Claude’s chats/, /Restart Claude/, /data-setup-restart/, /setupRestart/, /Quits and reopens/, /"not_loaded"/, /state === "restart"/]) {
    assert.doesNotMatch(inbox, gone);
  }
  // Connect all never opens Claude's connector screen behind the person's back.
  assert.match(inbox, /host\.installed && host\.id !== "claude-app" && \["available", "broken"\]\.includes\(host\.state\)/);
  // Conductor exists here only for accounts offered it.
  assert.match(inbox, /const SETUP_RIDER = "conductor"; const setupRiderOffered = \(\) => payload\.features\?\.conductor === true;/);
});
