import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  discoverTerminalSessionBindings,
  launchMacAgentTerminal,
  macTerminalInventory,
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
    terminalProcessState(77, { runImpl: () => "T+ ttys003\n" }),
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
