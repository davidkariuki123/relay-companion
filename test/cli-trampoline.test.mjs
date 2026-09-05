import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  resolveCliTrampoline,
  runCliTrampoline,
  TRAMPOLINE_ENV,
  TRAMPOLINE_EXEMPT_COMMANDS,
} from "../src/cli-trampoline.js";
import { STABLE_MCP_LAUNCHER_ENV } from "../src/mcp-launcher.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function tmpDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `relay-${label}-`));
}

/** A pointer shaped like the real one, for a release at `root`. */
function pointerFor(root, version, { node = "/usr/local/bin/node" } = {}) {
  return {
    version,
    packageRoot: root,
    bin: path.join(root, "bin", "relay.js"),
    node,
  };
}

const base = {
  platform: "linux",
  env: {},
  runningRoot: "/opt/global/node_modules/relay-companion",
  runningVersion: "0.1.265",
  exists: () => true,
  execPath: "/fallback/node",
};

test("a stale global shim hops to the active canonical release with the same node", () => {
  const current = pointerFor("/home/u/.relay/runtime/releases/0.1.269-x/node_modules/relay-companion", "0.1.269");
  const hop = resolveCliTrampoline({ ...base, command: "doctor", readCurrent: () => current });
  assert.deepEqual(hop, {
    node: current.node,
    bin: current.bin,
    from: "0.1.265",
    to: "0.1.269",
    shimRoot: path.resolve(base.runningRoot),
  });
});

test("--version hops too, so the number a person sees is the code the machine runs", () => {
  const current = pointerFor("/home/u/.relay/runtime/releases/0.1.269-x/node_modules/relay-companion", "0.1.269");
  assert.ok(resolveCliTrampoline({ ...base, command: "--version", readCurrent: () => current }));
  assert.ok(resolveCliTrampoline({ ...base, command: "update", readCurrent: () => current }), "update must hop or it can never repair itself");
  assert.ok(resolveCliTrampoline({ ...base, command: "uninstall", readCurrent: () => current }));
});

test("no canonical pointer, or a pointer to ourselves, runs in-process", () => {
  assert.equal(resolveCliTrampoline({ ...base, command: "doctor", readCurrent: () => null }), null);
  const self = pointerFor(base.runningRoot, "0.1.265");
  assert.equal(resolveCliTrampoline({ ...base, command: "doctor", readCurrent: () => self }), null);
  // Case-insensitive on Windows: the same tree spelled differently is still us.
  const selfWin = pointerFor("C:\\Users\\U\\AppData\\Roaming\\npm\\node_modules\\relay-companion", "0.1.265");
  assert.equal(
    resolveCliTrampoline({
      ...base,
      platform: "win32",
      runningRoot: "c:\\users\\u\\appdata\\roaming\\npm\\node_modules\\relay-companion",
      command: "doctor",
      readCurrent: () => selfWin,
    }),
    null,
  );
});

test("the services and updater-internal commands never hop, whatever the pointer says", () => {
  const current = pointerFor("/home/u/.relay/runtime/releases/0.1.269-x/node_modules/relay-companion", "0.1.269");
  for (const command of TRAMPOLINE_EXEMPT_COMMANDS) {
    assert.equal(resolveCliTrampoline({ ...base, command, readCurrent: () => current }), null, `${command} runs in-process`);
  }
  // The set is exactly the launched-by-exact-path surface. Adding to it is a
  // deliberate act; this pins the current membership so a drift is visible.
  assert.deepEqual(
    Array.from(TRAMPOLINE_EXEMPT_COMMANDS).sort(),
    ["claude-hook", "codex-hook", "daemon", "repair-desktop", "repair-runtime", "self-update"],
  );
});

test("generic npm or npx MCP invocations hop, while Relay's stable launcher stays exact", () => {
  const current = pointerFor("/home/u/.relay/runtime/releases/0.1.413-x/node_modules/relay-companion", "0.1.413");
  assert.ok(resolveCliTrampoline({ ...base, command: "mcp", readCurrent: () => current }));
  assert.equal(resolveCliTrampoline({
    ...base,
    command: "mcp",
    env: { [STABLE_MCP_LAUNCHER_ENV]: "1" },
    readCurrent: () => current,
  }), null);
});

test("a stale global `relay pill` opens the active canonical pill", () => {
  const current = pointerFor("/home/u/.relay/runtime/releases/0.1.376-x/node_modules/relay-companion", "0.1.376");
  const hop = resolveCliTrampoline({ ...base, command: "pill", readCurrent: () => current });
  assert.deepEqual(hop, {
    node: current.node,
    bin: current.bin,
    from: "0.1.265",
    to: "0.1.376",
    shimRoot: path.resolve(base.runningRoot),
  });
});

test("retired commands typed from muscle memory still hop and get the current usage text", () => {
  // `answer-question` / `open-notification` were deleted with the retired
  // question flow; someone pasting an ancient notification command should land
  // in the CURRENT release (which says the command is gone), not in stale code.
  const current = pointerFor("/home/u/.relay/runtime/releases/0.1.269-x/node_modules/relay-companion", "0.1.269");
  for (const command of ["answer", "answer-question", "open-notification"]) {
    assert.ok(resolveCliTrampoline({ ...base, command, readCurrent: () => current }), `${command} hops`);
  }
});

test("a bare `relay` hops too, so the usage text describes the code the machine runs", () => {
  const current = pointerFor("/home/u/.relay/runtime/releases/0.1.269-x/node_modules/relay-companion", "0.1.269");
  assert.ok(resolveCliTrampoline({ ...base, command: undefined, readCurrent: () => current }));
});

test("--no-trampoline is the documented escape hatch: the invoked tree runs itself", () => {
  // A deliberately downgraded `npm install -g relay-companion@<older>` would
  // otherwise silently hop into the newer runtime and be impossible to test.
  const current = pointerFor("/home/u/.relay/runtime/releases/0.1.269-x/node_modules/relay-companion", "0.1.269");
  assert.equal(
    resolveCliTrampoline({ ...base, command: "doctor", argv: ["--no-trampoline"], readCurrent: () => current }),
    null,
  );
});

test("a dev checkout never hops: it is the developer's own code, and its version cannot be trusted", () => {
  // main's package.json lags npm (CI assigns versions on publish), so a
  // checkout looks OLDER than the fleet — the version rule alone would hop
  // David's working tree into the canonical runtime. The install-shape rule
  // must catch it first.
  const newer = pointerFor("/home/u/.relay/runtime/releases/0.1.269-x/node_modules/relay-companion", "0.1.269");
  for (const checkout of ["/home/u/code/relay/packages/companion", "C:\\Users\\u\\Documents\\relay\\packages\\companion"]) {
    assert.equal(
      resolveCliTrampoline({ ...base, runningRoot: checkout, runningVersion: "0.1.209", command: "doctor", readCurrent: () => newer }),
      null,
      `${checkout} runs in-process`,
    );
  }
});

test("a NEWER managed invoker runs itself: a just-installed shim wins over an older runtime", () => {
  const older = pointerFor("/home/u/.relay/runtime/releases/0.1.260-x/node_modules/relay-companion", "0.1.260");
  assert.equal(resolveCliTrampoline({ ...base, runningVersion: "0.1.265", command: "doctor", readCurrent: () => older }), null);
  // Equal versions at different paths still hop: the runtime is the machine's
  // code, and the shim is only a way in.
  const equal = pointerFor("/home/u/.relay/runtime/releases/0.1.265-x/node_modules/relay-companion", "0.1.265");
  assert.ok(resolveCliTrampoline({ ...base, runningVersion: "0.1.265", command: "doctor", readCurrent: () => equal }));
});

test("the hop is guarded against loops and against a half-swapped release", () => {
  const current = pointerFor("/home/u/.relay/runtime/releases/0.1.269-x/node_modules/relay-companion", "0.1.269");
  // The env the trampoline sets on its child forbids a second hop.
  assert.equal(resolveCliTrampoline({ ...base, command: "doctor", env: { [TRAMPOLINE_ENV]: "1" }, readCurrent: () => current }), null);
  // Pointer names a bin that is not on disk (mid-activation): run what we have.
  assert.equal(
    resolveCliTrampoline({ ...base, command: "doctor", readCurrent: () => current, exists: (p) => p !== current.bin }),
    null,
  );
  // Pointer names a node that is not on disk: hop with our own node instead.
  const hop = resolveCliTrampoline({ ...base, command: "doctor", readCurrent: () => current, exists: (p) => p !== current.node });
  assert.equal(hop.node, "/fallback/node");
  assert.equal(hop.bin, current.bin);
});

test("runCliTrampoline forwards argv, marks the child, inherits stdio, and mirrors the exit code", () => {
  const calls = [];
  const code = runCliTrampoline(
    { node: "/n", bin: "/b/relay.js", from: "0.1.265", shimRoot: "/opt/global/node_modules/relay-companion" },
    {
      argv: ["doctor", "--json"],
      env: { PATH: "/usr/bin" },
      spawn: (cmd, args, opts) => {
        calls.push({ cmd, args, opts });
        return { status: 3 };
      },
    },
  );
  assert.equal(code, 3);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, "/n");
  assert.deepEqual(calls[0].args, ["/b/relay.js", "doctor", "--json"]);
  assert.equal(calls[0].opts.stdio, "inherit");
  assert.equal(calls[0].opts.env.PATH, "/usr/bin", "parent env preserved");
  assert.equal(calls[0].opts.env[TRAMPOLINE_ENV], "1", "child cannot hop again");
  assert.equal(calls[0].opts.env.RELAY_CLI_SHIM_VERSION, "0.1.265", "doctor can report the typed shim");
  assert.equal(calls[0].opts.env.RELAY_CLI_SHIM_ROOT, "/opt/global/node_modules/relay-companion");
  assert.equal(runCliTrampoline({ node: "/n", bin: "/b" }, { spawn: () => ({ status: null }) }), 1, "null status is failure");
});

test("end to end: a managed shim hands `--version` to a fake canonical release and reports ITS version", () => {
  // Build a fake HOME with a canonical pointer to a stub release, and a fake
  // npm-managed install (<prefix>/node_modules/relay-companion) whose bin is
  // THIS checkout's real bin/relay.js. Run that managed bin with that HOME. It
  // must print the stub release's version, proving the hop happens through the
  // genuine startup path rather than through the pure resolver alone.
  const home = tmpDir("e2e");
  const managedRoot = path.join(home, "prefix", "node_modules", "relay-companion");
  // Copy this checkout's bin + bootstrap + src under a node_modules path so the running
  // root reads as an npm-managed install, and point its node_modules at the
  // repo's hoisted deps so the real import graph resolves.
  for (const dir of ["bin", "bootstrap", "src", "skill"]) fs.cpSync(path.join(packageRoot, dir), path.join(managedRoot, dir), { recursive: true });
  fs.writeFileSync(path.join(managedRoot, "package.json"), JSON.stringify({ name: "relay-companion", version: "0.1.1", type: "module" }));
  const repoNodeModules = findRepoNodeModules(packageRoot);
  fs.symlinkSync(repoNodeModules, path.join(managedRoot, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  const releaseRoot = path.join(home, ".relay", "runtime", "releases", "9.9.9-test-1-abc", "node_modules", "relay-companion");
  fs.mkdirSync(path.join(releaseRoot, "bin"), { recursive: true });
  // The fake release only needs to answer `--version`; a stub bin keeps the
  // test independent of the real bin's import graph.
  fs.writeFileSync(
    path.join(releaseRoot, "bin", "relay.js"),
    'console.log("9.9.9-from-canonical"); console.log(process.env["RELAY_CLI_TRAMPOLINED"] || "unmarked");\n',
  );
  fs.writeFileSync(path.join(releaseRoot, "package.json"), JSON.stringify({ name: "relay-companion", version: "9.9.9" }));
  const pointer = {
    schema: 1,
    active: true,
    state: "active",
    version: "9.9.9",
    releaseId: "9.9.9-test-1-abc",
    releaseRoot: path.resolve(releaseRoot, "..", ".."),
    packageRoot: releaseRoot,
    bin: path.join(releaseRoot, "bin", "relay.js"),
    node: process.execPath,
  };
  fs.writeFileSync(path.join(home, ".relay", "runtime", "current.json"), JSON.stringify(pointer));

  const env = { ...process.env, HOME: home, USERPROFILE: home };
  delete env[TRAMPOLINE_ENV];
  const managedBin = path.join(managedRoot, "bin", "relay.js");
  const res = spawnSync(process.execPath, [managedBin, "--version"], { env, encoding: "utf8", timeout: 60_000 });
  assert.equal(res.status, 0, res.stderr);
  const lines = res.stdout.trim().split(/\r?\n/);
  assert.equal(lines[0], "9.9.9-from-canonical", `hopped to the canonical release; got stdout: ${res.stdout} stderr: ${res.stderr}`);
  assert.equal(lines[1], "1", "child is marked so it cannot hop again");

  // The SAME managed bin, run from the checkout path instead, must not hop:
  // a dev checkout is the developer's own code.
  const checkout = spawnSync(process.execPath, [path.join(packageRoot, "bin", "relay.js"), "--version"], {
    env,
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(checkout.status, 0, checkout.stderr);
  assert.doesNotMatch(checkout.stdout, /from-canonical/, "checkout runs in-process");

  // And the trampoline marker stops a second hop even from the managed bin.
  const marked = spawnSync(process.execPath, [managedBin, "--version"], {
    env: { ...env, [TRAMPOLINE_ENV]: "1" },
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(marked.stdout.trim(), "0.1.1", "marked process prints its own version");
});

/** Walk up from the package to the nearest node_modules holding the hoisted deps. */
function findRepoNodeModules(start) {
  let dir = start;
  for (let i = 0; i < 6; i += 1) {
    const candidate = path.join(dir, "node_modules");
    if (fs.existsSync(path.join(candidate, "@modelcontextprotocol"))) return candidate;
    dir = path.dirname(dir);
  }
  throw new Error("could not locate hoisted node_modules with @modelcontextprotocol");
}
