import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  discoverTerminalSessionBindings,
  discoverWindowsTerminalSessionBindings,
  focusTerminalSession,
  launchMacAgentTerminal,
  launchWindowsAgentTerminal,
  macTerminalInventory,
  parseWindowsProcessRows,
  terminalProcessState,
} from "../src/terminal-sessions.js";

const CODEX_ID = "11111111-1111-4111-8111-111111111111";
const CLAUDE_ID = "22222222-2222-4222-8222-222222222222";

test("terminal inventory distinguishes keyboard focus from tabs selected in other windows", () => {
  const runImpl = (_command, args) => {
    const script = args.at(-1);
    if (script.includes('tell application "Terminal"')) {
      return [
        "Frontmost\tcom.apple.Terminal",
        "Terminal\t1\t1\ttrue\ttrue\t/dev/ttys001",
        "Terminal\t2\t1\ttrue\tfalse\t/dev/ttys002",
      ].join("\n");
    }
    return "";
  };
  const rows = macTerminalInventory({ runImpl, platform: "darwin" });
  assert.equal(rows[0].keyboardFocused, true);
  assert.equal(rows[1].keyboardFocused, false);
  assert.equal(rows[1].selectedInWindow, true);
});

test("terminal session discovery maps both providers and records Codex remote ownership", () => {
  const runImpl = (command, args) => {
    if (command === "/bin/ps") return [
      `101 ttys001 S+ 101 101 /opt/codex --remote ws://127.0.0.1:45123 resume ${CODEX_ID}`,
      `202 ttys002 S 202 202 /opt/claude --resume ${CLAUDE_ID}`,
    ].join("\n");
    if (command === "/usr/bin/osascript") {
      const script = args.at(-1);
      if (script.includes('tell application "Terminal"')) return [
        "Frontmost\tcom.apple.Terminal",
        "Terminal\t1\t1\ttrue\ttrue\t/dev/ttys001",
        "Terminal\t2\t1\ttrue\tfalse\t/dev/ttys002",
      ].join("\n");
    }
    return "";
  };
  const bindings = discoverTerminalSessionBindings({ runImpl, platform: "darwin" });
  assert.equal(bindings.get(`codex:${CODEX_ID}`).managedRemote, true);
  assert.equal(bindings.get(`codex:${CODEX_ID}`).remoteEndpoint, "ws://127.0.0.1:45123");
  assert.equal(bindings.get(`codex:${CODEX_ID}`).keyboardFocused, true);
  assert.equal(bindings.get(`claude:${CLAUDE_ID}`).selectedInWindow, true);
  assert.equal(bindings.get("pid:202").tty, "ttys002");
});

test("only the foreground CLI process on a selected terminal tab is current", () => {
  const olderId = "33333333-3333-4333-8333-333333333333";
  const runImpl = (command, args) => {
    if (command === "/bin/ps") return [
      `101 ttys001 T 101 202 /opt/codex resume ${olderId}`,
      `202 ttys001 S+ 202 202 /opt/codex --remote ws://127.0.0.1:45123 resume ${CODEX_ID}`,
    ].join("\n");
    if (command === "/usr/bin/osascript" && args.at(-1).includes('tell application "Terminal"')) return [
      "Frontmost\tcom.apple.Terminal",
      "Terminal\t1\t1\ttrue\ttrue\t/dev/ttys001",
    ].join("\n");
    return "";
  };
  const bindings = discoverTerminalSessionBindings({ runImpl, platform: "darwin" });
  assert.equal(bindings.get(`codex:${olderId}`).selectedInWindow, true);
  assert.equal(bindings.get(`codex:${olderId}`).keyboardFocused, false);
  assert.equal(bindings.get(`codex:${CODEX_ID}`).keyboardFocused, true);
});

test("process preflight recognizes suspended sessions", () => {
  assert.deepEqual(
    terminalProcessState(77, { platform: "darwin", runImpl: () => "T+ ttys003\n" }),
    { alive: true, suspended: true, zombie: false, pid: 77, state: "T+", tty: "ttys003" },
  );
});

test("Codex terminal launch uses the supported remote resume command", async () => {
  if (process.platform !== "darwin") return;
  const previous = {
    RELAY_HOME: process.env.RELAY_HOME,
    CODEX_CLI_PATH: process.env.CODEX_CLI_PATH,
  };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-terminal-launch-"));
  const fakeCodex = path.join(root, "codex");
  fs.writeFileSync(fakeCodex, "#!/bin/sh\n", { mode: 0o755 });
  process.env.RELAY_HOME = root;
  process.env.CODEX_CLI_PATH = fakeCodex;
  let invocation = null;
  try {
    const result = await launchMacAgentTerminal({
      provider: "codex",
      nativeId: CODEX_ID,
      cwd: root,
      remoteEndpoint: "ws://127.0.0.1:45123",
      spawnImpl: (command, args) => {
        invocation = { command, args };
        const child = new EventEmitter();
        queueMicrotask(() => child.emit("exit", 0));
        return child;
      },
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.args, ["--remote", "ws://127.0.0.1:45123", "resume", CODEX_ID]);
    assert.deepEqual(invocation.args.slice(0, 2), ["-a", "Terminal"]);
    assert.match(fs.readFileSync(invocation.args[2], "utf8"), /--remote/);
  } finally {
    if (previous.RELAY_HOME === undefined) delete process.env.RELAY_HOME;
    else process.env.RELAY_HOME = previous.RELAY_HOME;
    if (previous.CODEX_CLI_PATH === undefined) delete process.env.CODEX_CLI_PATH;
    else process.env.CODEX_CLI_PATH = previous.CODEX_CLI_PATH;
  }
});

// ---------- Windows (2026-10-09) ----------

test("Windows: only the CLIs a person runs in a console are terminal sessions", () => {
  const rows = parseWindowsProcessRows([
    `101\t9\tC:\\Users\\me\\.local\\bin\\claude.exe\t"C:\\Users\\me\\.local\\bin\\claude.exe" --resume ${CLAUDE_ID}`,
    `102\t9\tC:\\Users\\me\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe\tcodex --remote ws://127.0.0.1:45123 resume ${CODEX_ID}`,
    // The Claude app's Code tab, the Codex app's app-server, and Relay's headless runs are not.
    `201\t9\tC:\\Users\\me\\AppData\\Roaming\\Claude\\claude-code\\2.1.293\\83cb0bd7fed4\\claude.exe\tclaude.exe --output-format stream-json`,
    `202\t9\tC:\\Users\\me\\AppData\\Local\\OpenAI\\Codex\\bin\\9691020b546a15b2\\codex.exe\tcodex.exe app-server`,
    `203\t9\tC:\\Users\\me\\.local\\bin\\claude.exe\tclaude.exe -p "count the TODOs"`,
    `204\t9\tC:\\Windows\\notepad.exe\tnotepad.exe`,
  ].join("\r\n"));
  assert.deepEqual(rows.map((row) => [row.provider, row.pid]), [["claude", 101], ["codex", 102]]);

  const bindings = discoverWindowsTerminalSessionBindings({ processes: rows });
  assert.equal(bindings.get(`claude:${CLAUDE_ID}`).pid, 101);
  assert.equal(bindings.get(`claude:${CLAUDE_ID}`).platform, "win32");
  assert.equal(bindings.get(`codex:${CODEX_ID}`).managedRemote, true);
  assert.equal(bindings.get(`codex:${CODEX_ID}`).remoteEndpoint, "ws://127.0.0.1:45123");
  assert.equal(bindings.get("pid:101").tty, "", "Windows has no TTY; the process id is the handle");
});

test("Windows: with no CLI running, discovery never starts PowerShell", () => {
  const calls = [];
  const bindings = discoverTerminalSessionBindings({ platform: "win32", runImpl: (command) => { calls.push(command); return "INFO: No tasks are running"; } });
  assert.equal(bindings.size, 0);
  assert.deepEqual(calls, ["tasklist", "tasklist"]);
});

test("Windows: a console process is alive or gone, never suspended", () => {
  assert.deepEqual(terminalProcessState(77, { platform: "win32", isAlive: () => true }), { alive: true, suspended: false, zombie: false, pid: 77, state: "", tty: "" });
  assert.equal(terminalProcessState(77, { platform: "win32", isAlive: () => false }).alive, false);
});

test("Windows: focusing a session asks for its window by process id", () => {
  let script = "";
  const ok = focusTerminalSession({ pid: 4242, platform: "win32" }, { platform: "win32", runImpl: (_command, args) => { script = args.at(-1); return "ok\r\n"; } });
  assert.deepEqual(ok, { ok: true, app: "Terminal", pid: 4242 });
  assert.match(script, /AttachConsole\(4242\)/);
  assert.equal(focusTerminalSession({ pid: 4242 }, { platform: "win32", runImpl: () => "none" }).reason, "terminal-session-not-found");
  assert.equal(focusTerminalSession({ pid: 4242 }, { platform: "win32", runImpl: () => "refused" }).reason, "terminal-focus-refused");
  assert.equal(focusTerminalSession({}, { platform: "win32", runImpl: () => "ok" }).ok, false, "no process, nothing to focus");
});

test("Windows: a new terminal session opens through start, in the Task's folder", async () => {
  let invocation = null;
  const spawnImpl = (command, args, options) => {
    invocation = { command, args, options };
    const child = new EventEmitter();
    queueMicrotask(() => child.emit("exit", 0));
    return child;
  };
  const env = { ComSpec: String.raw`C:\Windows\System32\cmd.exe`, CODEX_CLI_PATH: String.raw`C:\Tools\codex.exe`, RELAY_CLAUDE_CLI_PATH: String.raw`C:\Users\me\.local\bin\claude.exe`, CLAUDECODE: "1" };
  const codex = await launchWindowsAgentTerminal({ provider: "codex", nativeId: CODEX_ID, cwd: String.raw`C:\Users\me\Documents\relay`, remoteEndpoint: "ws://127.0.0.1:45123", spawnImpl, env });
  assert.equal(codex.ok, true);
  assert.deepEqual(codex.args, ["--remote", "ws://127.0.0.1:45123", "resume", CODEX_ID]);
  assert.equal(invocation.command, String.raw`C:\Windows\System32\cmd.exe`);
  assert.equal(invocation.args[0], `/d /c start "Relay" /D "C:\\Users\\me\\Documents\\relay" "C:\\Tools\\codex.exe" --remote ws://127.0.0.1:45123 resume ${CODEX_ID}`);
  assert.equal(invocation.options.windowsVerbatimArguments, true);
  assert.equal(invocation.options.env.CLAUDECODE, undefined, "a Claude session's own variables stay behind");

  const claude = await launchWindowsAgentTerminal({ provider: "claude", nativeId: CLAUDE_ID, cwd: String.raw`C:\work`, spawnImpl, env });
  assert.deepEqual(claude.args, ["--resume", CLAUDE_ID]);

  // Anything cmd.exe would read as its own syntax is refused, never quoted around.
  const unsafe = await launchWindowsAgentTerminal({ provider: "claude", nativeId: CLAUDE_ID, cwd: String.raw`C:\a & b`, spawnImpl, env });
  assert.equal(unsafe.reason, "terminal-launch-unsafe-path");
  const noCli = await launchWindowsAgentTerminal({ provider: "codex", nativeId: CODEX_ID, cwd: "C:\\work", spawnImpl, env: { PATH: "" } });
  assert.equal(noCli.reason, "codex-cli-not-found");
});
