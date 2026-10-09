// WHERE RELAY HAS ACTUALLY WORKED (2026-10-09): every green on Your AIs is
// proof from the place it names, never a config file read as a connection.
// The process chains and log lines below were measured on a real Mac.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ancestryOf,
  createHostWitness,
  placeOfAncestry,
  readHostEvidence,
  writeHostEvidence,
} from "../src/host-evidence.js";
import {
  claudePlace,
  claudeTranscriptFacts,
  codexPlace,
  codexRolloutFacts,
  lastMatchingLine,
  readHostHistory,
} from "../src/host-history.js";
import { claudeCheckFromOutput, codexCheckFromOutput, inspectAgentHosts } from "../src/agent-host-status.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const inbox = fs.readFileSync(path.join(here, "../overlay/inbox.html"), "utf8");
const APPS = { claude: "/Applications/Claude.app", chatgpt: "/Applications/ChatGPT.app", conductor: "/Applications/Conductor.app" };
const HOME = "/Users/a";
const SUPPORT = `${HOME}/Library/Application Support`;
const BRIDGE = `${HOME}/.relay/bin/mcp-bridge --descriptor ${HOME}/.relay/run/mcp/broker-v1.json`;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "rhe-"));

test("a session's place is its host, read from the process that started it", () => {
  const place = (chain, clientName) => placeOfAncestry(chain, { apps: APPS, clientName });
  // The Claude app's Code tab runs the CLI it downloaded, under its helper.
  assert.equal(place([`${SUPPORT}/Claude/claude-code/2.1.293/8433d0d9cd0d/claude.app/Contents/MacOS/claude --output-format stream-json`,
    "/Applications/Claude.app/Contents/Helpers/disclaimer --pgroup", "/Applications/Claude.app/Contents/MacOS/Claude"]), "claude-code:app");
  // Its chats start Relay from the helper directly.
  assert.equal(place(["/Applications/Claude.app/Contents/Helpers/disclaimer --pgroup -- " + BRIDGE, "/Applications/Claude.app/Contents/MacOS/Claude"]), "claude-chat");
  // The ChatGPT app's own codex lives inside its bundle.
  assert.equal(place(["/Applications/ChatGPT.app/Contents/Resources/codex app-server --analytics-default-enabled", "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT"]), "codex:chatgpt-app");
  assert.equal(place(["/opt/homebrew/bin/claude", "-zsh", "/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal"]), "claude-code:terminal");
  assert.equal(place(["/opt/homebrew/bin/claude -p hi", "/bin/zsh", `${SUPPORT}/Claude/claude-code/2.1.293/claude.app/Contents/MacOS/claude`,
    "/Applications/Claude.app/Contents/Helpers/disclaimer", "/Applications/Claude.app/Contents/MacOS/Claude"]), "claude-code:terminal",
    "a claude typed into a shell the Code tab opened is still Terminal");
  assert.equal(place([`${HOME}/.local/bin/codex exec hi`, "-zsh"]), "codex:terminal");
  // Conductor runs its own agents from its own data folder (measured 0.61.1).
  assert.equal(place([`${SUPPORT}/com.conductor.app/agent-binaries/claude/2.1.156/claude --output-format stream-json --verbose`,
    `${SUPPORT}/com.conductor.app/bin/.internal/conductor-runtime sidecar`, "/Applications/Conductor.app/Contents/MacOS/conductor"]), "claude-code:conductor");
  assert.equal(place([`${SUPPORT}/com.conductor.app/agent-binaries/codex/0.130.0/codex app-server --listen stdio://`]), "codex:conductor");
  // …and its Codex names itself in the handshake.
  assert.equal(place([`${HOME}/.local/bin/codex app-server`], "codex-local"), "codex:conductor");
  // Relay's own launcher between a host and its session is looked past.
  assert.equal(place([`/usr/local/bin/node ${HOME}/.relay/bin/mcp-launcher.cjs mcp`, "/opt/homebrew/bin/claude"]), "claude-code:terminal");
  // Only the PARENT is the host: tests run from a Claude Code terminal are not Claude Code.
  assert.equal(place(["node --test test/x.test.mjs", "npm test", "/opt/homebrew/bin/claude"]), "");
  assert.equal(place(["/bin/zsh", "/Applications/Claude.app/Contents/MacOS/Claude"]), "");
  assert.equal(place([]), "");

  const table = [{ pid: 1, ppid: 0, command: "/sbin/launchd" }, { pid: 10, ppid: 1, command: "/opt/homebrew/bin/claude" }, { pid: 11, ppid: 10, command: BRIDGE }];
  assert.deepEqual(ancestryOf(11, table), { command: BRIDGE, chain: ["/opt/homebrew/bin/claude", "/sbin/launchd"] });
});

test("the record only moves forward, one small file per place", () => {
  const home = tmp();
  writeHostEvidence(home, "codex:terminal", { connectedAt: 100, client: { name: "codex-mcp-client", version: "0.153.4" }, bridge: BRIDGE }, { now: 100 });
  writeHostEvidence(home, "codex:terminal", { connectedAt: 50, listedAt: 120, toolCount: 41 }, { now: 120 });
  writeHostEvidence(home, "codex:terminal", { refusedAt: 130, refusal: "account_drift" }, { now: 130 });
  let record = readHostEvidence(home)["codex:terminal"];
  assert.equal(record.connectedAt, 100, "an older observation never rewinds a time");
  assert.equal(record.listedAt, 120);
  assert.equal(record.toolCount, 41);
  assert.equal(record.client.name, "codex-mcp-client");
  assert.equal(record.refusal, "account_drift");
  writeHostEvidence(home, "codex:terminal", { calledAt: 140 }, { now: 140 });
  record = readHostEvidence(home)["codex:terminal"];
  assert.equal(record.refusal, undefined, "a later answered call clears an old refusal");
  assert.equal(writeHostEvidence(home, "nowhere", { connectedAt: 1 }), null, "unknown places are never filed");
  assert.deepEqual(Object.keys(readHostEvidence(home)), ["codex:terminal"]);
  assert.deepEqual(fs.readdirSync(path.join(home, "host-evidence")), ["codex@terminal.json"], "no temp file left behind");
});

test("a session writes what its host did, at its place, and Relay's own probe writes nothing", async () => {
  const home = tmp();
  const table = async () => [{ pid: 20, ppid: 1, command: "/opt/homebrew/bin/claude" }, { pid: 21, ppid: 20, command: BRIDGE }];
  let clock = 1_000;
  const witness = createHostWitness({ homeDir: home, bridgePid: 21, apps: APPS, processTable: table, now: () => clock, disabled: false });
  witness.connected({ name: "claude-code", version: "2.1.293" });
  clock = 2_000; witness.listed(40);
  clock = 3_000; witness.called();
  clock = 4_000; witness.called(); // within the minute: not written again
  assert.equal(await witness.place(), "claude-code:terminal");
  await new Promise((resolve) => setTimeout(resolve, 20));
  const record = readHostEvidence(home)["claude-code:terminal"];
  assert.deepEqual([record.connectedAt, record.listedAt, record.calledAt, record.toolCount, record.client.name], [1_000, 2_000, 3_000, 40, "claude-code"]);
  assert.equal(record.bridge, BRIDGE);

  const probeHome = tmp();
  const probe = createHostWitness({ homeDir: probeHome, bridgePid: 21, apps: APPS, processTable: table, disabled: false });
  probe.connected({ name: "relay-probe", version: "1" });
  probe.listed(40);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(fs.existsSync(path.join(probeHome, "host-evidence")), false);
});

test("each app's own records say where Relay worked before Relay kept one", async () => {
  const home = tmp();
  const project = path.join(home, ".claude", "projects", "-Users-a-src-x");
  fs.mkdirSync(project, { recursive: true });
  const filler = `${JSON.stringify({ type: "user", message: { content: "x".repeat(300_000) }, timestamp: "2026-10-09T07:00:00.000Z" })}\n`;
  fs.writeFileSync(path.join(project, "s1.jsonl"), [
    JSON.stringify({ type: "user", entrypoint: "cli", cwd: "/Users/a/src/x", timestamp: "2026-08-13T07:00:00.000Z" }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "t", name: "mcp__relay__relay_send", input: { note: "{\"timestamp\":\"1999-01-01T00:00:00Z\"}" } }] }, timestamp: "2026-08-13T08:00:49.155Z" }),
  ].join("\n") + "\n" + filler);
  const conductor = path.join(home, ".claude", "projects", "-Users-a-conductor-workspaces-q");
  fs.mkdirSync(conductor, { recursive: true });
  fs.writeFileSync(path.join(conductor, "s2.jsonl"), [
    JSON.stringify({ type: "user", entrypoint: "sdk-ts", cwd: path.join(home, "conductor", "workspaces", "q"), timestamp: "2026-10-09T10:00:00.000Z" }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "t", name: "mcp__relay__relay_session_updates", input: {} }] }, timestamp: "2026-10-09T10:01:00.000Z" }),
  ].join("\n") + "\n");
  const day = path.join(home, ".codex", "sessions", "2026", "10", "03");
  fs.mkdirSync(day, { recursive: true });
  fs.writeFileSync(path.join(day, "rollout-a.jsonl"), [
    JSON.stringify({ timestamp: "2026-10-03T11:53:57.000Z", type: "session_meta", payload: { originator: "Codex Desktop", cwd: "/Users/a" } }),
    JSON.stringify({ timestamp: "2026-10-03T11:54:09.631Z", type: "event_msg", payload: { type: "item_completed", item: { type: "McpToolCall", server: "relay", tool: "relay_session_updates", status: "completed" } } }),
    JSON.stringify({ timestamp: "2026-10-03T11:59:00.000Z", type: "event_msg", payload: { type: "item_completed", item: { type: "McpToolCall", server: "relay", tool: "relay_send", status: "failed" } } }),
  ].join("\n") + "\n");
  const logs = path.join(home, "Library", "Logs", "Claude");
  fs.mkdirSync(logs, { recursive: true });
  fs.writeFileSync(path.join(logs, "mcp.log"), [
    "2026-10-09T09:39:30.779Z [info] [relay] Message from client: method=\"tools/list\" id=96 params",
    "2026-10-09T09:39:30.782Z [info] [relay] Message from server: id=96 result",
    "2026-10-09T09:40:00.000Z [info] [other] Message from client: method=\"tools/list\" id=3 params",
  ].join("\n") + "\n");

  const facts = await claudeTranscriptFacts(path.join(project, "s1.jsonl"));
  assert.deepEqual(facts, { entrypoint: "cli", cwd: "/Users/a/src/x", usedAt: Date.parse("2026-08-13T08:00:49.155Z") },
    "found across a chunk boundary, at the record's own time (not one quoted in its input)");
  assert.equal((await codexRolloutFacts(path.join(day, "rollout-a.jsonl"))).usedAt, Date.parse("2026-10-03T11:54:09.631Z"), "a failed call is not Relay working");

  const root = path.join(home, "conductor") + path.sep;
  assert.equal(claudePlace({ entrypoint: "claude-desktop" }, { conductorRoot: root }), "claude-code:app");
  assert.equal(claudePlace({ entrypoint: "sdk-ts", cwd: "/Users/a/src" }, { conductorRoot: root }), "", "sdk-ts alone says nothing about where");
  assert.equal(claudePlace({ entrypoint: "relay-companion" }, { conductorRoot: root }), "", "Relay's own runs are not a host using Relay");
  assert.equal(codexPlace({ originator: "codex_exec" }, { conductorRoot: root }), "codex:terminal");
  assert.equal(codexPlace({ originator: "relay_execute" }, { conductorRoot: root }), "");

  const cache = {};
  const history = await readHostHistory({ homeDir: home, now: Date.parse("2026-10-09T12:00:00Z"), cache });
  const iso = (at) => (at ? new Date(at).toISOString() : 0);
  assert.deepEqual(Object.fromEntries(Object.entries(history).map(([place, value]) => [place, [iso(value.usedAt), iso(value.loadedAt)]])), {
    "claude-code:terminal": ["2026-08-13T08:00:49.155Z", 0],
    "claude-code:conductor": ["2026-10-09T10:01:00.000Z", 0],
    "codex:chatgpt-app": ["2026-10-03T11:54:09.631Z", 0],
    // The Claude app's log proves Relay LOADED in its chats, never that it was used.
    "claude-chat": [0, "2026-10-09T09:39:30.779Z"],
  });
  assert.equal(Object.keys(cache).length, 3, "every transcript's answer is cached by size and mtime");

  assert.equal(await lastMatchingLine(path.join(home, "missing.jsonl"), () => true), "");
});

test("each app answers for itself: Codex reads its config, Claude Code connects to Relay", () => {
  // Measured: Conductor's bundled codex 0.130.0 on a config Relay wrote.
  const stderr = "Error: failed to load configuration\n\nCaused by:\n    0: /Users/a/.codex/config.toml:497:1: invalid type: map, expected a boolean in `features`\n";
  assert.deepEqual(codexCheckFromOutput(1, "", stderr), { ok: false, reason: "settings_unreadable", detail: "line 497: invalid type: map, expected a boolean in `features`" });
  assert.deepEqual(codexCheckFromOutput(0, JSON.stringify({ name: "relay", enabled: false, disabled_reason: "turned off" }), ""), { ok: false, reason: "turned_off", detail: "turned off" });
  assert.deepEqual(codexCheckFromOutput(0, JSON.stringify({ name: "relay", enabled: true, disabled_reason: null }), ""), { ok: true });
  assert.equal(codexCheckFromOutput(1, "", "Error: unexpected argument '--json'"), null, "no answer is not an answer");
  // Measured: `claude mcp get relay` (2.1.270, 2.1.286, 2.1.293).
  const connected = "relay:\n  Scope: User config (available in all your projects)\n  Status: ✔ Connected\n  Type: stdio\n";
  assert.deepEqual(claudeCheckFromOutput(0, connected, ""), { ok: true });
  assert.deepEqual(claudeCheckFromOutput(0, "relay:\n  Status: ✘ Failed to connect\n", ""), { ok: false, reason: "app_check_failed", detail: "Failed to connect" });
  assert.equal(claudeCheckFromOutput(1, "", "boom"), null);
});

function sandbox() {
  const root = tmp();
  const home = path.join(root, "home");
  const apps = path.join(root, "Applications");
  const bin = path.join(root, "bin");
  for (const dir of [home, apps, bin]) fs.mkdirSync(dir, { recursive: true });
  for (const name of ["Claude", "ChatGPT", "Conductor"]) fs.mkdirSync(path.join(apps, `${name}.app`, "Contents", "MacOS"), { recursive: true });
  for (const name of ["claude", "codex"]) fs.writeFileSync(path.join(bin, name), "");
  fs.mkdirSync(path.join(home, "Library", "Application Support", "Claude", "claude-code"), { recursive: true });
  const conductorBin = path.join(home, "Library", "Application Support", "com.conductor.app", "bin");
  fs.mkdirSync(conductorBin, { recursive: true });
  for (const name of ["claude", "codex"]) fs.writeFileSync(path.join(conductorBin, name), "");
  const launcher = path.join(home, ".relay", "bin", "mcp-launcher.cjs");
  fs.mkdirSync(path.dirname(launcher), { recursive: true });
  fs.writeFileSync(launcher, "");
  const entry = { command: process.execPath, args: [launcher, "mcp"] };
  fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ mcpServers: { relay: entry } }));
  fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
  fs.writeFileSync(path.join(home, ".codex", "config.toml"), `[mcp_servers.relay]\ncommand = "${entry.command}"\nargs = ["${launcher}", "mcp"]\n`);
  return { home, apps, bin };
}

test("each place is Connected only when its own app says so, else Not connected with one way out", () => {
  const box = sandbox();
  const claudeApp = path.join(box.apps, "Claude.app");
  const base = { env: { HOME: box.home }, homeDir: box.home, platform: "darwin", appsDir: box.apps, binDir: box.bin, evidence: {}, history: {} };
  const processes = [
    { uid: process.getuid?.(), pid: 100, ppid: 1, command: `${claudeApp}/Contents/MacOS/Claude`, startedAt: 0 },
    { uid: process.getuid?.(), pid: 101, ppid: 100, command: `${claudeApp}/Contents/Helpers/disclaimer --pgroup`, startedAt: 0 },
    { uid: process.getuid?.(), pid: 102, ppid: 101, command: `${box.home}/Library/Application Support/Claude/claude-code/2.1.293/claude.app/Contents/MacOS/claude`, startedAt: 0 },
    { uid: process.getuid?.(), pid: 103, ppid: 102, command: `${process.execPath} ${box.home}/.relay/bin/mcp-launcher.cjs mcp`, startedAt: 0 },
  ];
  const hostChecks = {
    "claude-code:app": { ok: true },
    "claude-code:terminal": { ok: false, reason: "app_check_failed", detail: "Failed to connect" },
    "codex:chatgpt-app": { ok: true },
    "codex:terminal": { ok: false, reason: "turned_off" },
    "codex:conductor": { ok: false, reason: "settings_unreadable", detail: "line 497: invalid type", version: "0.130.0" },
  };
  const { places } = inspectAgentHosts({ ...base, processes, hostChecks });
  const answer = (id) => [places[id].connected, places[id].action || "", places[id].reason || ""];
  assert.deepEqual(answer("claude-code:app"), [true, "", ""]);
  assert.deepEqual(answer("claude-code:terminal"), [false, "fix", "app_check_failed"], "Terminal is judged on its own, not on the Code tab");
  assert.deepEqual(answer("codex:chatgpt-app"), [true, "", ""]);
  assert.deepEqual(answer("codex:terminal"), [false, "fix", "turned_off"]);
  assert.deepEqual(answer("codex:conductor"), [false, "fix", "settings_unreadable"]);
  assert.deepEqual(answer("claude-code:conductor"), [null, "", ""], "not asked yet is not known: never a guess");
  assert.equal(places["claude-code:app"].live, true);

  // A Relay call in a session open right now is proof while its app is unasked.
  const called = inspectAgentHosts({ ...base, processes, hostChecks: {}, evidence: { "claude-code:app": { place: "claude-code:app", calledAt: 5_000 } } });
  assert.equal(called.places["claude-code:app"].connected, true);
  // A running bridge with no call is not.
  assert.equal(inspectAgentHosts({ ...base, processes, hostChecks: {} }).places["claude-code:app"].connected, null);

  // Unregistered: Not connected, Connect.
  fs.writeFileSync(path.join(box.home, ".claude.json"), "{}");
  assert.deepEqual([inspectAgentHosts({ ...base, processes, hostChecks }).places["claude-code:app"].connected, inspectAgentHosts({ ...base, processes, hostChecks }).places["claude-code:app"].action], [false, "connect"]);
});

test("the pill says only Connected or Not connected, and Conductor never borrows it", () => {
  const status = inbox.slice(inbox.indexOf("function setupPlaceStatus(place, host)"), inbox.indexOf("function setupModeStatus("));
  const words = new Set([...status.matchAll(/text:\s*(?:"([^"]+)"|`([^`$]+)`)/g)].map((match) => match[1] || match[2]));
  assert.deepEqual([...words].sort(), ["Checking…", "Connected", "Not connected"]);
  assert.match(status, /`Not connected · update \$\{app\}`/, "or what will fix it, in a few words");
  assert.equal([...status.matchAll(/dot:"ok"/g)].length, 1, "green has exactly one source: connected === true");
  assert.match(status, /if \(place\.connected === true\) return \{ dot:"ok", text:"Connected" \}/);
  const groups = inbox.slice(inbox.indexOf("function setupAppGroups(hosts)"), inbox.indexOf("function setupPlaceWhy("));
  for (const place of ["claude-chat", "claude-code:app", "claude-code:terminal", "codex:chatgpt-app", "codex:terminal", "claude-code:${SETUP_RIDER}", "codex:${SETUP_RIDER}"]) {
    assert.ok(groups.includes(place), `${place} has a row`);
  }
  assert.doesNotMatch(inbox, /dot:"ok", text:"Connected · through Claude Code and Codex"/);
});

test("a host whose API refused Relay's tools is broken there until a later call works", async () => {
  // Measured: Conductor 0.61.1's Claude Code 2.1.156, then the same chat
  // resumed on 2.1.286 after Conductor updated, where Relay worked.
  const home = tmp();
  const dir = path.join(home, ".claude", "projects", "-Users-a-conductor-workspaces-q");
  fs.mkdirSync(dir, { recursive: true });
  const cwd = path.join(home, "conductor", "workspaces", "q");
  const refusal = { type: "assistant", isApiErrorMessage: true, error: "unknown", version: "2.1.156", cwd,
    message: { model: "<synthetic>", content: [{ type: "text", text: "API Error: 400 tools.16.custom.input_schema: input_schema does not support oneOf, allOf, or anyOf at the top level" }] } };
  const first = JSON.stringify({ type: "user", entrypoint: "sdk-ts", cwd, timestamp: "2026-10-09T10:20:00.000Z" });
  fs.writeFileSync(path.join(dir, "old.jsonl"), [first, JSON.stringify({ ...refusal, timestamp: "2026-10-09T10:21:00.000Z" })].join("\n") + "\n");
  const now = Date.parse("2026-10-09T12:00:00Z");
  let history = await readHostHistory({ homeDir: home, now });
  assert.equal(history["claude-code:conductor"].refusedAt, Date.parse("2026-10-09T10:21:00.000Z"));
  assert.equal(history["claude-code:conductor"].refusedVersion, "2.1.156");

  const box = sandbox();
  const scan = (past) => inspectAgentHosts({ env: { HOME: box.home }, homeDir: box.home, platform: "darwin", appsDir: box.apps, binDir: box.bin,
    processes: [], evidence: {}, hostChecks: { "claude-code:conductor": { ok: true } }, history: { "claude-code:conductor": past } }).places["claude-code:conductor"];
  // Its own `mcp get` passes (the server starts), yet the API refuses the tools.
  assert.deepEqual([scan(history["claude-code:conductor"]).connected, scan(history["claude-code:conductor"]).reason], [false, "app_too_old"]);

  fs.appendFileSync(path.join(dir, "old.jsonl"), JSON.stringify({ type: "assistant", version: "2.1.286", cwd, timestamp: "2026-10-09T10:40:00.000Z",
    message: { content: [{ type: "tool_use", id: "t", name: "mcp__relay__relay_session_updates", input: {} }] } }) + "\n");
  history = await readHostHistory({ homeDir: home, now });
  assert.equal(scan(history["claude-code:conductor"]).connected, true, "the later working call supersedes the refusal");
});
