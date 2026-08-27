import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

import {
  desktopExecQuote,
  linuxApplicationDesktopText,
  linuxAutostartDesktopText,
  linuxDaemonUnitText,
  linuxDesktopPreflight,
  linuxDesktopPaths,
  linuxPillStarterText,
  linuxPillUnitText,
  systemdExecQuote,
} from "../src/install.js";
import { readAutostartDaemonRoot } from "../src/autostart-registration.js";
import { activateCanonicalRuntime, spawnCanonicalUpdate } from "../src/canonical-updater.js";

const require = createRequire(import.meta.url);
const { releasePlatform } = require("../bootstrap/relay-setup.cjs");
const credentialStore = require("../src/credential-store.cjs");
const { launchLinuxAgentTerminal, linuxAgentResume } = require("../overlay/linux-terminal.cjs");
const { quitRelayCommand } = require("../overlay/visibility.cjs");

test("Linux release identity covers x64 and arm64 and rejects unsupported architectures", () => {
  assert.equal(releasePlatform("linux", "x64"), "linux-x64");
  assert.equal(releasePlatform("linux", "arm64"), "linux-arm64");
  assert.throws(() => releasePlatform("linux", "ia32"), /64-bit macOS, Windows, and Linux/);
});

test("Linux setup fails closed outside its supported graphical systemd contract", () => {
  const ready = linuxDesktopPreflight({
    platform: "linux",
    arch: "x64",
    env: { WAYLAND_DISPLAY: "wayland-0" },
    glibcVersion: "2.39",
    runCommand: (command, args) => {
      assert.deepEqual([command, ...args], ["systemctl", "--user", "show-environment"]);
      return { ok: true, out: "" };
    },
  });
  assert.deepEqual(ready, { ok: true, glibcVersion: "2.39", session: "wayland" });
  assert.equal(linuxDesktopPreflight({ platform: "linux", arch: "ia32", env: {}, glibcVersion: "2.39" }).reason, "linux_arch_unsupported");
  assert.equal(linuxDesktopPreflight({ platform: "linux", arch: "x64", env: {}, glibcVersion: "" }).reason, "linux_libc_unsupported");
  assert.equal(linuxDesktopPreflight({ platform: "linux", arch: "x64", env: {}, glibcVersion: "2.39" }).reason, "linux_graphical_session_missing");
  assert.equal(linuxDesktopPreflight({
    platform: "linux",
    arch: "arm64",
    env: { DISPLAY: ":0" },
    glibcVersion: "2.39",
    runCommand: () => ({ ok: false, out: "no user bus" }),
  }).reason, "systemd_user_unavailable");
});

test("Linux credentials use the owner-only local store without invoking a native vault", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-linux-credentials-"));
  const file = path.join(root, "credentials.json");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const options = {
    platform: "linux",
    file,
    account: "device-token-linux",
    run: () => { throw new Error("Linux credentials must not invoke a platform vault"); },
  };
  assert.equal(credentialStore.writeDeviceToken("linux-secret", options).ok, true);
  assert.deepEqual(credentialStore.readDeviceToken(options), { ok: true, value: "linux-secret", detail: "" });
  assert.equal(credentialStore.deleteDeviceToken(options).ok, true);
  assert.equal(credentialStore.readDeviceToken(options).code, "credential_not_found");
});

test("Linux desktop files are XDG-scoped, injection-safe, and preserve canonical runtime identity", () => {
  const homeDir = "/home/al ex";
  const env = {
    XDG_CONFIG_HOME: "/home/al ex/config",
    XDG_DATA_HOME: "/home/al ex/data",
    PATH: "/custom/bin:/usr/bin:/bin",
  };
  const bin = "/home/al ex/.relay/runtime/releases/7/node_modules/relay-companion/bin/relay.js";
  const node = "/usr/bin/node";
  const electronPath = "/home/al ex/runtime/electron";
  const overlayMain = "/home/al ex/runtime/overlay/main.cjs";
  const paths = linuxDesktopPaths({ homeDir, env });
  assert.equal(paths.daemonUnitPath, "/home/al ex/config/systemd/user/work.relay.companion.service");
  assert.equal(paths.applicationPath, "/home/al ex/data/applications/relay.desktop");

  const daemon = linuxDaemonUnitText({ bin, node, homeDir, env });
  assert.match(daemon, /ExecStart="\/usr\/bin\/node" "--max-old-space-size=128" .* "daemon"/);
  assert.match(daemon, /# RelayBinBase64=/);
  assert.match(daemon, /Environment="HOME=\/home\/al ex"/);
  assert.match(daemon, /Environment="XDG_CONFIG_HOME=\/home\/al ex\/config"/);
  const registration = readAutostartDaemonRoot({
    platform: "linux",
    homeDir,
    env,
    readFileImpl: (file) => {
      assert.equal(file, paths.daemonUnitPath);
      return daemon;
    },
  });
  assert.equal(registration.bin, bin);

  const pill = linuxPillUnitText({ electronPath, overlayMain, homeDir, env });
  assert.match(pill, /After=graphical-session\.target/);
  assert.match(pill, /Restart=on-failure/);
  const application = linuxApplicationDesktopText({ node, bin, iconPath: "/tmp/Relay Icon.svg" });
  assert.match(application, /MimeType=x-scheme-handler\/relay;/);
  assert.match(application, / pill %u/);
  assert.match(linuxAutostartDesktopText({ pillStarterPath: paths.pillStarterPath }), /X-GNOME-Autostart-enabled=true/);
  assert.match(linuxPillStarterText(), /import-environment DISPLAY WAYLAND_DISPLAY/);
  assert.throws(() => systemdExecQuote("bad\nargument"), /control characters/);
  assert.throws(() => desktopExecQuote("bad\0argument"), /control characters/);
});

test("Linux canonical activation repairs, restarts pill then daemon, and proves exact-root health", async () => {
  const target = {
    node: "/usr/bin/node",
    bin: "/home/test/.relay/runtime/releases/8/node_modules/relay-companion/bin/relay.js",
    packageRoot: "/home/test/.relay/runtime/releases/8/node_modules/relay-companion",
  };
  const calls = [];
  let processReads = 0;
  const run = (command, args) => {
    calls.push([command, ...args]);
    if (command === "/bin/ps") {
      processReads += 1;
      return processReads === 1
        ? { status: 0, stdout: "", stderr: "" }
        : {
            status: 0,
            stdout: `node ${target.bin} daemon\nElectron ${target.packageRoot}/overlay/main.cjs\n`,
            stderr: "",
          };
    }
    return { status: 0, stdout: "", stderr: "" };
  };
  const result = await activateCanonicalRuntime(target, { platform: "linux", run, attempts: 1 });
  assert.equal(result.ok, true);
  const starts = calls.filter(([command, user, verb]) => command === "systemctl" && user === "--user" && verb === "start");
  assert.match(starts[0].join(" "), /pill\.service/);
  assert.match(starts[1].join(" "), /companion\.service/);
});

test("Linux update workers run in an independent transient systemd user unit", () => {
  const calls = [];
  const files = new Map();
  const fsImpl = {
    mkdirSync() {},
    writeFileSync(file, value) { files.set(file, String(value)); },
    renameSync(from, to) { files.set(to, files.get(from)); files.delete(from); },
    readFileSync(file) { return files.get(file); },
    openSync() { throw Object.assign(new Error("exists"), { code: "EEXIST" }); },
  };
  const result = spawnCanonicalUpdate({
    version: "1.2.4",
    runningVersion: "1.2.3",
    runningPackageRoot: "/opt/relay/node_modules/relay-companion",
    node: "/usr/bin/node",
    homeDir: "/home/test",
    platform: "linux",
    requestId: "request-linux",
    workerId: "worker-linux",
    fsImpl,
    run(command, args) {
      calls.push([command, ...args]);
      return { status: 0, stdout: "", stderr: "" };
    },
    waitForAdmission(requestPath, options) {
      const request = JSON.parse(options.fsImpl.readFileSync(requestPath, "utf8"));
      return { ...request, state: "admitted", admittedAt: Date.now() };
    },
  });
  assert.equal(result.status, "admitted");
  const launch = calls.find(([command]) => command === "systemd-run");
  assert.ok(launch);
  assert.ok(launch.includes("--user"));
  assert.ok(launch.some((value) => String(value).includes("work.relay.companion.update.request-linux")));
});

test("Linux opens forged Claude and Codex sessions through an available terminal", () => {
  assert.deepEqual(linuxAgentResume("claude://resume?session=abc-123", "claude", {}), {
    command: "claude",
    args: ["--resume", "abc-123"],
  });
  assert.deepEqual(linuxAgentResume("codex://threads/thread-7", "codex", {}), {
    command: "codex",
    args: ["resume", "thread-7"],
  });
  const calls = [];
  const launched = launchLinuxAgentTerminal({
    url: "codex://threads/thread-7",
    host: "codex",
    cwd: "/work/project",
    env: {},
    available: (command) => ["codex", "kgx"].includes(command),
    spawnImpl(command, args, options) {
      calls.push({ command, args, options });
      return { unref() {} };
    },
  });
  assert.equal(launched.ok, true);
  assert.deepEqual(calls[0].args, ["--", "codex", "resume", "thread-7"]);
  assert.equal(calls[0].options.cwd, "/work/project");
  assert.match(quitRelayCommand({ platform: "linux" })[1][1], /systemctl --user stop/);
});
