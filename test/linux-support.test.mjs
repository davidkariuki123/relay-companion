import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import test from "node:test";

import {
  desktopExecQuote,
  ensureLinuxElectronSandbox,
  linkLinuxUserUnit,
  linuxApplicationDesktopText,
  linuxAutostartDesktopText,
  linuxDaemonUnitText,
  linuxDesktopPreflight,
  linuxDesktopPaths,
  linuxElectronRuntimePreflight,
  linuxPillStarterText,
  linuxPillUnitText,
  prepareLinuxElectronSandbox,
  registerLinuxProtocolHandler,
  removeLinuxRelayMimeDefaults,
  stopLinuxRelayServices,
  systemdExecQuote,
  systemdUnitQuote,
} from "../src/install.js";
import { readAutostartDaemonRoot } from "../src/autostart-registration.js";
import { activateCanonicalRuntime, spawnCanonicalUpdate } from "../src/canonical-updater.js";

const require = createRequire(import.meta.url);
const { releasePlatform } = require("../bootstrap/relay-setup.cjs");
const { activateLinuxRuntimeServices } = require("../bootstrap/runtime-health.cjs");
const { systemdRunEnvironmentArgs } = require("../bootstrap/linux-systemd.cjs");
const credentialStore = require("../src/credential-store.cjs");
const {
  commandAvailable,
  commandPath,
  launchLinuxAgentTerminal,
  linuxAgentResume,
  linuxTerminalEnvironment,
  linuxTerminalInvocation,
  terminalCandidates,
} = require("../overlay/linux-terminal.cjs");
const { quitRelayCommand } = require("../overlay/visibility.cjs");

test("Linux release identity covers x64 and arm64 and rejects unsupported architectures", () => {
  assert.equal(releasePlatform("linux", "x64"), "linux-x64");
  assert.equal(releasePlatform("linux", "arm64"), "linux-arm64");
  assert.throws(() => releasePlatform("linux", "ia32"), /64-bit macOS, Windows, and Linux/);
});

test("Linux setup fails closed outside its supported graphical systemd contract", () => {
  const preflightCalls = [];
  const ready = linuxDesktopPreflight({
    platform: "linux",
    arch: "x64",
    env: { WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" },
    glibcVersion: "2.39",
    runCommand: (command, args) => {
      preflightCalls.push([command, ...args]);
      return { ok: true, out: "" };
    },
  });
  assert.deepEqual(ready, { ok: true, glibcVersion: "2.39", session: "wayland-xwayland" });
  assert.deepEqual(preflightCalls, [
    ["systemctl", "--user", "show-environment"],
    ["systemd-run", "--version"],
    ["xdg-mime", "--version"],
  ]);
  assert.equal(linuxDesktopPreflight({ platform: "linux", arch: "ia32", env: {}, glibcVersion: "2.39" }).reason, "linux_arch_unsupported");
  assert.equal(linuxDesktopPreflight({ platform: "linux", arch: "x64", env: {}, glibcVersion: "" }).reason, "linux_libc_unsupported");
  assert.equal(linuxDesktopPreflight({ platform: "linux", arch: "x64", env: {}, glibcVersion: "2.39" }).reason, "linux_graphical_session_missing");
  assert.equal(linuxDesktopPreflight({ platform: "linux", arch: "x64", env: { WAYLAND_DISPLAY: "wayland-0" }, glibcVersion: "2.39" }).reason, "linux_xwayland_unavailable");
  assert.equal(linuxDesktopPreflight({
    platform: "linux",
    arch: "arm64",
    env: { DISPLAY: ":0" },
    glibcVersion: "2.39",
    runCommand: () => ({ ok: false, out: "no user bus" }),
  }).reason, "systemd_user_unavailable");
  const missingXdg = linuxDesktopPreflight({
    platform: "linux",
    arch: "x64",
    env: { DISPLAY: ":0" },
    glibcVersion: "2.39",
    runCommand: (command) => ({ ok: command !== "xdg-mime", out: "" }),
  });
  assert.equal(missingXdg.reason, "linux_desktop_dependency_missing");
  assert.equal(missingXdg.packageName, "xdg-utils");
  assert.match(missingXdg.detail, /Relay link registration/);
});

test("Linux runtime preflight names missing libraries and provisions the exact sandbox helper safely", () => {
  const probeSource = fs.readFileSync(new URL("../overlay/linux-runtime-probe.cjs", import.meta.url), "utf8");
  assert.match(probeSource, /appendSwitch\("ozone-platform", "x11"\)/);
  assert.match(probeSource, /sandbox: true/);
  const missing = linuxElectronRuntimePreflight({
    platform: "linux",
    electronPath: "/runtime/electron",
    probePath: "/runtime/probe.cjs",
    runCommand: (command) => {
      assert.equal(command, "ldd");
      return { ok: true, out: "libnspr4.so => not found\nlibgtk-3.so => not found" };
    },
  });
  assert.equal(missing.reason, "linux_desktop_libraries_missing");
  assert.deepEqual(missing.missing, ["libnspr4.so", "libgtk-3.so"]);

  const helperBytes = Buffer.from("exact-electron-sandbox");
  let installed = false;
  const env = { DISPLAY: ":0", LANG: "en_US.UTF-8", RELAY_DEVICE_TOKEN: "must-not-elevate" };
  const calls = [];
  let authorizationOptions = null;
  const trustedSandboxStat = (file, { writableParent = false } = {}) => {
    if (file.endsWith("/chrome-sandbox")) {
      if (!installed) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return { isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false, uid: 0, mode: 0o104755 };
    }
    if (file === "/usr/local" || file.startsWith("/usr/local/lib")) {
      return {
        isFile: () => false,
        isDirectory: () => true,
        isSymbolicLink: () => false,
        uid: 0,
        mode: writableParent && file === "/usr/local/lib/relay" ? 0o40777 : 0o40755,
      };
    }
    throw Object.assign(new Error("missing"), { code: "ENOENT" });
  };
  const sandbox = ensureLinuxElectronSandbox({
    electronPath: "/runtime/electron",
    env,
    geteuid: () => 1000,
    readFileSync(file) {
      if (file === "/runtime/chrome-sandbox") return helperBytes;
      if (installed && file.startsWith("/usr/local/lib/relay/chromium-sandboxes/")) return helperBytes;
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
    lstatSync: trustedSandboxStat,
    realpathSync: (file) => file,
    runCommand(command, args, options) {
      calls.push([command, ...args]);
      authorizationOptions = options;
      installed = true;
      return { ok: true, out: "" };
    },
  });
  assert.equal(sandbox.ok, true);
  assert.equal(calls[0][0], "pkexec");
  assert.match(calls[0].join(" "), /sha256sum/);
  assert.match(calls[0].join(" "), /readlink -f/);
  assert.match(calls[0].join(" "), /-perm \/022/);
  assert.deepEqual(authorizationOptions.env, {
    PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
    LANG: "en_US.UTF-8",
    DISPLAY: ":0",
  });
  assert.equal(env.CHROME_DEVEL_SANDBOX, sandbox.destination);

  const discoveredEnv = {};
  const discovered = prepareLinuxElectronSandbox({
    platform: "linux",
    electronPath: "/runtime/electron",
    env: discoveredEnv,
    readFileSync(file) {
      if (file === "/runtime/chrome-sandbox" || file.startsWith("/usr/local/lib/relay/chromium-sandboxes/")) return helperBytes;
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
    lstatSync: trustedSandboxStat,
    realpathSync: (file) => file,
    runCommand: () => { throw new Error("a trusted helper must not prompt again"); },
  });
  assert.equal(discovered.discovered, true);
  assert.equal(discoveredEnv.CHROME_DEVEL_SANDBOX, discovered.destination);

  const untrustedParent = ensureLinuxElectronSandbox({
    electronPath: "/runtime/electron",
    allowAuthorization: false,
    readFileSync(file) {
      if (file === "/runtime/chrome-sandbox" || file.endsWith("/chrome-sandbox")) return helperBytes;
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
    lstatSync: (file) => trustedSandboxStat(file, { writableParent: true }),
    realpathSync: (file) => file,
  });
  assert.equal(untrustedParent.reason, "linux_sandbox_update_authorization_required");

  const blocked = prepareLinuxElectronSandbox({
    platform: "linux",
    electronPath: "/runtime/electron",
    allowAuthorization: false,
    readFileSync(file) {
      if (file === "/runtime/chrome-sandbox") return helperBytes;
      if (file === "/proc/sys/kernel/apparmor_restrict_unprivileged_userns") return "1\n";
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
    lstatSync: () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
    realpathSync: (file) => file,
    runCommand: () => { throw new Error("a background update must not ask for elevation"); },
  });
  assert.equal(blocked.reason, "linux_sandbox_update_authorization_required");
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
    SSH_AUTH_SOCK: "/run/user/1000/keyring/ssh",
    NODE_EXTRA_CA_CERTS: "/etc/company-ca.pem",
    RELAY_DEVICE_TOKEN: "must-not-enter-systemd",
  };
  const bin = "/home/al ex/.relay/runtime/releases/7/node_modules/relay-companion/bin/relay.js";
  const node = "/usr/bin/node";
  const electronPath = "/home/al ex/runtime/electron";
  const overlayMain = "/home/al ex/runtime/overlay/main.cjs";
  const paths = linuxDesktopPaths({ homeDir, env });
  assert.equal(paths.daemonUnitPath, "/home/al ex/config/systemd/user/work.relay.companion.service");
  assert.equal(paths.applicationPath, "/home/al ex/data/applications/work.relay.companion.desktop");

  const daemon = linuxDaemonUnitText({ bin, node, homeDir, env });
  assert.match(daemon, /ExecStart="\/usr\/bin\/node" "--max-old-space-size=128" .* "daemon"/);
  assert.match(daemon, /# RelayBinBase64=/);
  assert.match(daemon, /Environment="HOME=\/home\/al ex"/);
  assert.match(daemon, /Environment="XDG_CONFIG_HOME=\/home\/al ex\/config"/);
  assert.match(daemon, /Environment="SSH_AUTH_SOCK=\/run\/user\/1000\/keyring\/ssh"/);
  assert.match(daemon, /Environment="NODE_EXTRA_CA_CERTS=\/etc\/company-ca\.pem"/);
  assert.doesNotMatch(daemon, /RELAY_DEVICE_TOKEN/);
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
  assert.match(linuxPillStarterText(), /XDG_RUNTIME_DIR SSH_AUTH_SOCK SSL_CERT_FILE/);
  assert.throws(() => systemdExecQuote("bad\nargument"), /control characters/);
  assert.throws(() => desktopExecQuote("bad\0argument"), /control characters/);
  assert.equal(systemdExecQuote("HOME=/home/a$b%"), '"HOME=/home/a$$b%%"');
  assert.equal(systemdUnitQuote("HOME=/home/a$b%"), '"HOME=/home/a$b%%"');
  assert.equal(
    desktopExecQuote(String.raw`/home/a\b$c%d "q"`),
    String.raw`"/home/a\\\\b\\$c%%d \"q\""`,
  );
  assert.match(linuxPillStarterText(), /restart work\.relay\.companion\.service/);
});

test("Linux units are linked into the live user manager and protocol registration round-trips", () => {
  const calls = [];
  const unitPath = "/tmp/custom config/systemd/user/work.relay.companion.service";
  const linked = linkLinuxUserUnit(unitPath, "work.relay.companion.service", {
    runCommand(command, args) {
      calls.push([command, ...args]);
      if (args.includes("--property=FragmentPath")) return { ok: true, out: unitPath };
      if (args.includes("cat")) return { ok: true, out: "[Unit]\nDescription=Relay" };
      return { ok: true, out: "" };
    },
  });
  assert.equal(linked.ok, true);
  assert.deepEqual(calls[0], ["systemctl", "--user", "link", unitPath]);
  assert.ok(calls.some((call) => call.includes("cat")));

  const protocolCalls = [];
  const protocol = registerLinuxProtocolHandler("/tmp/apps/work.relay.companion.desktop", {
    runCommand(command, args) {
      protocolCalls.push([command, ...args]);
      return args[0] === "query"
        ? { ok: true, out: "work.relay.companion.desktop\n" }
        : { ok: true, out: "" };
    },
  });
  assert.equal(protocol.ok, true);
  assert.deepEqual(protocolCalls.at(-1), ["xdg-mime", "query", "default", "x-scheme-handler/relay"]);
});

test("Linux uninstall removes only Relay MIME mappings and quiesces standalone service processes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-linux-mime-"));
  const configHome = path.join(root, ".config");
  const mimeFile = path.join(configHome, "mimeapps.list");
  fs.mkdirSync(configHome, { recursive: true });
  fs.writeFileSync(mimeFile, [
    "[Default Applications]",
    "x-scheme-handler/relay=work.relay.companion.desktop;other.desktop;",
    "text/plain=editor.desktop;",
    "",
  ].join("\n"));
  const removed = removeLinuxRelayMimeDefaults({ homeDir: root, env: { XDG_CONFIG_HOME: configHome } });
  assert.equal(removed.changed.length, 1);
  const remaining = fs.readFileSync(mimeFile, "utf8");
  assert.match(remaining, /x-scheme-handler\/relay=other\.desktop;/);
  assert.match(remaining, /text\/plain=editor\.desktop;/);
  fs.rmSync(root, { recursive: true, force: true });

  let alive = true;
  const killed = [];
  const stopped = stopLinuxRelayServices({
    sleep: () => {},
    processId: 999,
    userId: 1000,
    runCommand(command, args) {
      if (command === "/bin/ps") {
        return {
          ok: true,
          out: alive
            ? " 1000 321 Electron /opt/node_modules/relay-companion/overlay/main.cjs\n 2000 654 Electron /opt/node_modules/relay-companion/overlay/main.cjs\n"
            : " 2000 654 Electron /opt/node_modules/relay-companion/overlay/main.cjs\n",
        };
      }
      if (command === "/bin/kill") {
        killed.push(args);
        alive = false;
      }
      return { ok: true, out: "" };
    },
  });
  assert.equal(stopped.ok, true);
  assert.deepEqual(killed, [["-TERM", "321"]]);
});

test("Linux canonical activation repairs, restarts pill then daemon, and proves exact-root health", async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-linux-health-"));
  const userId = typeof process.getuid === "function" ? process.getuid() : 0;
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
            stdout: `${userId} node ${target.bin} daemon\n${userId} Electron ${target.packageRoot}/overlay/main.cjs\n`,
            stderr: "",
          };
    }
    if (command === "systemctl" && args[0] === "--user" && args[1] === "start" && args[2].includes("pill")) {
      const statusDir = path.join(homeDir, ".relay-companion");
      fs.mkdirSync(statusDir, { recursive: true });
      fs.writeFileSync(path.join(statusDir, "pill-status.json"), JSON.stringify({
        pid: 222,
        ready: true,
        packageRoot: target.packageRoot,
      }));
    }
    return { status: 0, stdout: "", stderr: "" };
  };
  const result = await activateCanonicalRuntime(target, { platform: "linux", homeDir, run, attempts: 4, sleep: async () => {} });
  fs.rmSync(homeDir, { recursive: true, force: true });
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
    env: {
      HOME: "/home/test",
      XDG_CONFIG_HOME: "/home/test/.config",
      CODEX_CLI_PATH: "/opt/codex",
      RELAY_ALLOW_SANDBOX_AUTHORIZATION: "1",
      RELAY_DEVICE_TOKEN: "must-not-cross",
    },
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
  assert.ok(launch.includes("--setenv=CODEX_CLI_PATH=/opt/codex"));
  assert.ok(launch.includes("--setenv=RELAY_ALLOW_SANDBOX_AUTHORIZATION=1"));
  assert.equal(launch.some((value) => String(value).includes("RELAY_DEVICE_TOKEN")), false);
});

test("Linux opens forged Claude and Codex sessions through an available terminal", async () => {
  assert.deepEqual(linuxAgentResume("claude://resume?session=abc-123", "claude", {}), {
    command: "claude",
    args: ["--resume", "abc-123"],
  });
  assert.deepEqual(linuxAgentResume("codex://threads/thread-7", "codex", {}), {
    command: "codex",
    args: ["resume", "thread-7"],
  });
  const calls = [];
  const launched = await launchLinuxAgentTerminal({
    url: "codex://threads/thread-7",
    host: "codex",
    cwd: "/work/project",
    env: {},
    available: (command) => ["codex", "kgx"].includes(command),
    spawnImpl(command, args, options) {
      calls.push({ command, args, options });
      const child = new EventEmitter();
      child.unref = () => {};
      queueMicrotask(() => child.emit("spawn"));
      return child;
    },
  });
  assert.equal(launched.ok, true);
  assert.deepEqual(calls[0].args, ["-e", "codex", "resume", "thread-7"]);
  assert.equal(calls[0].options.cwd, "/work/project");
  assert.deepEqual(calls[0].options.env, {});
  assert.match(quitRelayCommand({ platform: "linux" })[1][1], /systemctl --user stop/);

  const child = new EventEmitter();
  child.unref = () => {};
  const racedPromise = launchLinuxAgentTerminal({
    url: "claude://resume?session=race",
    host: "claude",
    env: { PATH: "/usr/bin", DATABASE_URL: "postgres://secret" },
    available: (command) => ["claude", "kgx"].includes(command),
    spawnImpl: () => child,
  });
  queueMicrotask(() => child.emit("error", Object.assign(new Error("gone"), { code: "ENOENT" })));
  const raced = await racedPromise;
  assert.deepEqual(raced, { ok: false, reason: "terminal-launch-failed", detail: "gone" });
  assert.deepEqual(linuxTerminalEnvironment({ PATH: "/usr/bin", RELAY_DEVICE_TOKEN: "secret" }), { PATH: "/usr/bin" });
});

test("Linux terminal discovery covers Fedora and does not depend on which", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-linux-path-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const executable = path.join(root, "relay-test-cli");
  const terminalExecutable = path.join(root, "relay-test-terminal");
  fs.writeFileSync(executable, "#!/bin/sh\nexit 0\n");
  fs.chmodSync(executable, 0o755);
  fs.writeFileSync(terminalExecutable, "#!/bin/sh\nexit 0\n");
  fs.chmodSync(terminalExecutable, 0o755);
  fs.mkdirSync(path.join(root, "not-an-executable-file"));

  assert.equal(commandAvailable("relay-test-cli", { env: { PATH: root } }), true);
  assert.equal(commandAvailable("not-installed", { env: { PATH: root } }), false);
  assert.equal(commandAvailable("not-an-executable-file", { env: { PATH: root } }), false);
  const relativeExecutable = path.relative(process.cwd(), executable).split(path.sep).join("/");
  assert.equal(commandPath(relativeExecutable, { env: {} }), path.resolve(executable));
  assert.deepEqual(
    terminalCandidates({}).find(({ command }) => command === "ptyxis"),
    { command: "ptyxis", prefix: ["--"] },
  );
  assert.deepEqual(
    terminalCandidates({ TERMINAL: "/usr/bin/ptyxis" })[0],
    { command: "/usr/bin/ptyxis", prefix: ["--"] },
  );
  assert.deepEqual(
    linuxTerminalInvocation("claude", ["--resume", "session-1"], {
      available: (command) => ["claude", "ptyxis"].includes(command),
    }),
    { command: "ptyxis", args: ["--", "claude", "--resume", "session-1"] },
  );
  const relativeTerminal = path.relative(process.cwd(), terminalExecutable).split(path.sep).join("/");
  assert.deepEqual(
    linuxTerminalInvocation(executable, ["resume"], { env: { PATH: root, RELAY_TERMINAL: relativeTerminal } }),
    { command: path.resolve(terminalExecutable), args: ["-e", path.resolve(executable), "resume"] },
  );
  assert.doesNotMatch(fs.readFileSync(new URL("../overlay/linux-terminal.cjs", import.meta.url), "utf8"), /\/usr\/bin\/which/);
});

test("Linux task and completed-run opens always route through the terminal helper", () => {
  const main = fs.readFileSync(new URL("../overlay/main.cjs", import.meta.url), "utf8");
  const packetOpen = main.slice(main.indexOf("async function openPacket("), main.indexOf("async function openPacketInCurrent("));
  const taskOpen = main.slice(main.indexOf("function openTaskDetail("), main.indexOf("function openUrlTarget("));
  const runOpenStart = main.indexOf('ipcMain.handle("relay:openRunSession"');
  const runOpen = main.slice(runOpenStart, main.indexOf('// "Open in current chat"', runOpenStart));

  assert.match(packetOpen, /process\.platform === "linux"[\s\S]*?launchLinuxAgentTerminal\(\{ url, host, cwd \}\)/);
  assert.match(taskOpen, /process\.platform === "linux"[\s\S]*?launchLinuxAgentTerminal\(\{ url, host, cwd \}\)/);
  assert.match(runOpen, /process\.platform !== "linux" && !claudeSessionMetaPath\(sessionId\)/);
  assert.match(runOpen, /process\.platform === "linux"[\s\S]*?launchLinuxAgentTerminal\(\{[\s\S]*?host: "claude"/);
});
