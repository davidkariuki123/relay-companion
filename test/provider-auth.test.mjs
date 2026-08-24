import { EventEmitter } from "node:events";
import { spawn as spawnActual } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  assertProviderReady,
  connectProvider,
  providerAuthStatus,
  providerAuthStatuses,
  providerInventoryStatuses,
  setProviderEnabled,
  _test,
} from "../src/provider-auth.js";

function tempPrefs() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "relay-provider-auth-")), "provider-connections.json");
}

async function disconnectedExec(_command, args) {
  return args[0] === "auth"
    ? { stdout: JSON.stringify({ loggedIn: false, authMethod: "none", apiProvider: "firstParty" }) }
    : { stdout: "Not logged in" };
}

test("Claude status accepts only the official first-party subscription login", async () => {
  const prefsFile = tempPrefs();
  const connected = await providerAuthStatus("claude", {
    command: "/opt/homebrew/bin/claude",
    prefsFile,
    execFile: async () => ({ stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty" }) }),
  });
  assert.equal(connected.connected, true);
  assert.equal(connected.subscription, true);
  assert.equal(connected.authState, "subscription");
  assert.equal(connected.detail, "Claude subscription");

  const apiBilled = await providerAuthStatus("claude", {
    command: "/opt/homebrew/bin/claude",
    prefsFile,
    execFile: async () => ({ stdout: JSON.stringify({ loggedIn: true, authMethod: "api_key", apiProvider: "firstParty" }) }),
  });
  assert.equal(apiBilled.connected, false);
  assert.equal(apiBilled.authState, "api_billing");
  assert.match(apiBilled.detail, /API billing/);
});

test("Codex status accepts ChatGPT subscription login and rejects API-key billing", async () => {
  const prefsFile = tempPrefs();
  const connected = await providerAuthStatus("codex", {
    command: "/Applications/ChatGPT.app/Contents/Resources/codex",
    prefsFile,
    execFile: async () => ({ stdout: "Logged in using ChatGPT" }),
  });
  assert.equal(connected.connected, true);
  assert.equal(connected.authState, "subscription");
  assert.equal(connected.detail, "ChatGPT subscription");

  const apiBilled = await providerAuthStatus("codex", {
    command: "/opt/homebrew/bin/codex",
    prefsFile,
    execFile: async () => ({ stdout: "Logged in using an API key" }),
  });
  assert.equal(apiBilled.connected, false);
  assert.equal(apiBilled.authState, "api_billing");
  assert.match(apiBilled.detail, /API billing/);
});

test("Relay enablement is local, durable, and does not log the provider out", async () => {
  const prefsFile = tempPrefs();
  await setProviderEnabled("claude", false, { prefsFile });
  const status = await providerAuthStatus("claude", {
    command: "/opt/homebrew/bin/claude",
    prefsFile,
    execFile: async () => ({ stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty" }) }),
  });
  assert.equal(status.connected, true, "provider authentication remains intact");
  assert.equal(status.enabled, false, "only Relay use is disabled");
  if (process.platform !== "win32") assert.equal(fs.statSync(prefsFile).mode & 0o777, 0o600);
  await assert.rejects(assertProviderReady("claude", {
    command: "/opt/homebrew/bin/claude",
    prefsFile,
    execFile: async () => ({ stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty" }) }),
  }), /disabled in Relay/);
});

test("non-desktop fallback launches each official subscription login inside a macOS PTY and stores no token", async () => {
  const prefsFile = tempPrefs();
  const expectCommand = "/bin/sh";
  const calls = [];
  function spawn(command, args, options) {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.stdin = new EventEmitter();
    child.stdout = Object.assign(new EventEmitter(), { resume() {} });
    child.stderr = Object.assign(new EventEmitter(), { resume() {} });
    return child;
  }
  await connectProvider("claude", { command: "/opt/homebrew/bin/claude", prefsFile, spawn, platform: "darwin", expectCommand, openCommand: "", execFile: disconnectedExec });
  await connectProvider("codex", { command: "/opt/homebrew/bin/codex", prefsFile, spawn, platform: "darwin", expectCommand, openCommand: "", execFile: disconnectedExec });
  assert.deepEqual(calls.map(({ command, args }) => ({ command, args })), [
    {
      command: expectCommand,
      args: ["-f", calls[0].args[1], "--", "/opt/homebrew/bin/claude", "auth", "login", "--claudeai"],
    },
    {
      command: expectCommand,
      args: ["-f", calls[1].args[1], "--", "/opt/homebrew/bin/codex", "login"],
    },
  ]);
  assert.equal(calls.every((call) => call.args[1].endsWith("provider-auth-runner.exp")), true);
  assert.equal(calls.every((call) => call.options.stdio[0] === "pipe"), true);
  assert.doesNotMatch(fs.readFileSync(prefsFile, "utf8"), /token|credential|secret/i);
  for (const state of _test.activeLogins.values()) {
    clearTimeout(state.timer);
    state.child.emit("close", 1);
  }
  _test.activeLogins.clear();
  _test.lastAttempts.clear();
});

test("desktop sign-in opens each official CLI subscription flow and monitors only a non-secret result marker", async () => {
  const prefsFile = tempPrefs();
  const calls = [];
  function spawn(command, args, options) {
    const child = new EventEmitter();
    child.stdin = new EventEmitter();
    child.stdout = Object.assign(new EventEmitter(), { resume() {} });
    child.stderr = Object.assign(new EventEmitter(), { resume() {} });
    calls.push({ command, args, options, child });
    return child;
  }

  const claudeStart = await connectProvider("claude", {
    command: "/opt/homebrew/bin/claude",
    prefsFile,
    spawn,
    platform: "darwin",
    openCommand: "/bin/sh",
    terminalApp: "Test Terminal",
    execFile: disconnectedExec,
  });
  assert.equal(claudeStart.interaction, "terminal");
  const busyStatus = await providerAuthStatus("claude", {
    command: "/opt/homebrew/bin/claude",
    prefsFile,
    execFile: async () => ({ stdout: JSON.stringify({ loggedIn: false, authMethod: "none", apiProvider: "firstParty" }) }),
  });
  assert.equal(busyStatus.busy, true);
  assert.equal(busyStatus.busyDetail, "Finish Claude Code sign-in in Terminal.");
  assert.deepEqual(calls[0].args.slice(0, 2), ["-a", "Test Terminal"]);
  const claudeScript = calls[0].args[2];
  if (process.platform !== "win32") assert.equal(fs.statSync(claudeScript).mode & 0o777, 0o700);
  const claudeSource = fs.readFileSync(claudeScript, "utf8");
  assert.match(claudeSource, /claude' 'auth' 'login' '--claudeai'/);
  assert.doesNotMatch(claudeSource, /security|keychain/i, "Relay never manipulates the shared login Keychain");
  assert.doesNotMatch(claudeSource, /access[_-]?token|oauth[_-]?code|client[_-]?secret/i);
  calls[0].child.emit("close", 0);
  assert.equal(_test.activeLogins.has("claude"), true, "launcher exit does not pretend the external login finished");
  const claudeAttempt = _test.activeLogins.get("claude");
  fs.writeFileSync(claudeAttempt.markerPath, "0\n", { mode: 0o600 });
  const claudeStatus = await providerAuthStatus("claude", {
    command: "/opt/homebrew/bin/claude",
    prefsFile,
    execFile: async () => ({ stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty" }) }),
  });
  assert.equal(claudeStatus.connected, true);
  assert.equal(fs.existsSync(claudeScript), false, "temporary command is removed after the marker is consumed");

  const codexStart = await connectProvider("codex", {
    command: "/opt/homebrew/bin/codex",
    prefsFile,
    spawn,
    platform: "darwin",
    openCommand: "/bin/sh",
    terminalApp: "Test Terminal",
    execFile: disconnectedExec,
  });
  assert.equal(codexStart.interaction, "terminal");
  assert.deepEqual(calls[1].args.slice(0, 2), ["-a", "Test Terminal"]);
  const codexScript = calls[1].args[2];
  if (process.platform !== "win32") assert.equal(fs.statSync(codexScript).mode & 0o777, 0o700);
  const codexSource = fs.readFileSync(codexScript, "utf8");
  assert.match(codexSource, /codex' 'login'/);
  assert.doesNotMatch(codexSource, /with-api-key|access[_-]?token|oauth[_-]?code|client[_-]?secret/i);
  calls[1].child.emit("close", 0);
  const codexAttempt = _test.activeLogins.get("codex");
  fs.writeFileSync(codexAttempt.markerPath, "0\n", { mode: 0o600 });
  const codexStatus = await providerAuthStatus("codex", {
    command: "/opt/homebrew/bin/codex",
    prefsFile,
    execFile: async () => ({ stdout: "Logged in using ChatGPT" }),
  });
  assert.equal(codexStatus.connected, true);
  assert.equal(fs.existsSync(codexScript), false, "temporary Codex command is removed after the marker is consumed");
  _test.activeLogins.clear();
  _test.lastAttempts.clear();
});

test("Sign in is a no-op when the required subscription is already connected", async () => {
  const prefsFile = tempPrefs();
  let spawned = false;
  const result = await connectProvider("codex", {
    command: "/opt/homebrew/bin/codex",
    prefsFile,
    spawn() { spawned = true; throw new Error("must not spawn"); },
    execFile: async () => ({ stdout: "Logged in using ChatGPT" }),
  });
  assert.equal(result.alreadyConnected, true);
  assert.equal(spawned, false);
});

test("a synchronous Terminal launch failure removes the generated command and result marker", async () => {
  const prefsFile = tempPrefs();
  let generatedScript = "";
  await assert.rejects(connectProvider("claude", {
    command: "/opt/homebrew/bin/claude",
    prefsFile,
    platform: "darwin",
    openCommand: "/bin/sh",
    spawn(_command, args) {
      generatedScript = args[2];
      throw new Error("launch exploded");
    },
    execFile: disconnectedExec,
  }), /Could not start Claude Code authorization: launch exploded/);
  assert.equal(fs.existsSync(generatedScript), false);
  const authDirectory = path.dirname(generatedScript);
  assert.deepEqual(fs.readdirSync(authDirectory), []);
  assert.equal(_test.activeLogins.has("claude"), false);
});

test("the packaged macOS runner owns a real PTY even when its parent uses pipes", async (t) => {
  if (process.platform !== "darwin") return t.skip("macOS PTY contract");
  const invocation = _test.loginInvocation("/bin/sh", ["-c", "test -t 0 && test -t 1 && test -t 2"]);
  const code = await new Promise((resolve, reject) => {
    const child = spawnActual(invocation.command, invocation.args, { stdio: ["pipe", "pipe", "pipe"] });
    child.once("error", reject);
    child.once("close", resolve);
  });
  assert.equal(code, 0, "provider process keeps a real stdin/stdout/stderr TTY");
});

test("a provider sign-in that does not persist subscription auth surfaces an explicit failure", async () => {
  const prefsFile = tempPrefs();
  let child;
  function spawn() {
    child = new EventEmitter();
    child.stdin = new EventEmitter();
    child.stdout = Object.assign(new EventEmitter(), { resume() {} });
    child.stderr = Object.assign(new EventEmitter(), { resume() {} });
    return child;
  }
  await connectProvider("claude", {
    command: "/opt/homebrew/bin/claude",
    prefsFile,
    spawn,
    platform: "darwin",
    expectCommand: "/bin/sh",
    openCommand: "",
    execFile: disconnectedExec,
  });
  child.emit("close", 0);
  const status = await providerAuthStatus("claude", {
    command: "/opt/homebrew/bin/claude",
    prefsFile,
    execFile: async () => ({ stdout: JSON.stringify({ loggedIn: false, authMethod: "none", apiProvider: "firstParty" }) }),
  });
  assert.equal(status.connected, false);
  assert.match(status.detail, /was not saved/i);
  _test.lastAttempts.clear();
});

test("the Task gate names the exact subscription recovery for signed-out and API-billed providers", async () => {
  const prefsFile = tempPrefs();
  await assert.rejects(assertProviderReady("claude", {
    command: "/opt/homebrew/bin/claude",
    prefsFile,
    execFile: disconnectedExec,
  }), /needs your Claude subscription[\s\S]*Agent connections[\s\S]*Sign in to Claude Code/);

  await assert.rejects(assertProviderReady("codex", {
    command: "/opt/homebrew/bin/codex",
    prefsFile,
    execFile: async () => ({ stdout: "Logged in using an API key" }),
  }), /API billing[\s\S]*ChatGPT subscription[\s\S]*Sign in to Codex/);
});

test("Settings auth status is cheap and does not inventory integrations", async () => {
  const prefsFile = tempPrefs();
  const calls = [];
  const result = await providerAuthStatuses({
    prefsFile,
    command: "/opt/homebrew/bin/ignored",
    execFile: async (command, args) => {
      calls.push(args);
      return args[0] === "auth"
        ? { stdout: JSON.stringify({ loggedIn: false, authMethod: "none", apiProvider: "firstParty" }) }
        : { stdout: "Logged in using ChatGPT" };
    },
  });
  assert.deepEqual(Object.keys(result.providers).sort(), ["claude", "codex"]);
  assert.equal(result.providers.claude.connected, false);
  assert.equal(result.providers.codex.connected, true);
  assert.deepEqual(result.providers.claude.integrations.mcpServers, []);
  assert.equal(calls.some((args) => args[0] === "mcp"), false);
});

test("Settings inventory preserves exact safe provider integration status", async () => {
  let claudeOptions = null;
  const result = await providerInventoryStatuses({
    command: "/opt/homebrew/bin/ignored",
    execFile: async (command, args, options) => {
      if (args[0] === "mcp") claudeOptions = options;
      return { stdout: "claude.ai Gmail: https://gmail.example/mcp - ✔ Connected\nrelay: node relay.js - ✔ Connected" };
    },
    codexApps: async () => [
      { name: "Gmail", status: "Connected", source: "account" },
      { name: "GitHub", status: "Connected", source: "account" },
    ],
  });
  assert.deepEqual(result.providers.claude.integrations.mcpServers, [
    { name: "Gmail", status: "Connected", source: "account" },
    { name: "relay", status: "Connected", source: "local" },
  ]);
  assert.deepEqual(result.providers.codex.integrations.apps.map((app) => app.name), ["Gmail", "GitHub"]);
  assert.equal(claudeOptions.env.MCP_SERVER_CONNECTION_BATCH_SIZE, process.env.MCP_SERVER_CONNECTION_BATCH_SIZE || "8");
  assert.equal(JSON.stringify(result).includes("accessToken"), false);
});

test("Claude's provider-owned MCP inventory preserves account scope and authentication status", () => {
  assert.deepEqual(_test.parseClaudeMcpList(`Checking MCP server health…
claude.ai Gmail: https://gmailmcp.googleapis.com/mcp/v1 - ✔ Connected
claude.ai Snitch: https://mcp.snitch.blog/mcp - ! Needs authentication
relay: /opt/homebrew/bin/node relay.js mcp - ✔ Connected
`), [
    { name: "Gmail", status: "Connected", source: "account" },
    { name: "relay", status: "Connected", source: "local" },
    { name: "Snitch", status: "Needs authentication", source: "account" },
  ]);
});
