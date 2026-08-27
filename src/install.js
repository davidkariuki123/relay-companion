import { spawn, spawnSync } from "node:child_process";
import {
  claudeDesktopConfigDirs,
  claudeDesktopConfigPathIn,
  claudeDesktopEntry,
  codexAppPresent,
  mergeClaudeDesktopConfig,
  resolveStableNode,
} from "./desktop-hosts.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { activateCodexMcp, verifyClaudeMcpRegistration } from "./setup-activation.js";
import { ensureStableMcpLauncher } from "./mcp-launcher.js";
import { canonicalOwnershipGuard, verifyCanonicalCandidate } from "./canonical-runtime.js";
import { ensureStableHookLauncher, removeStableHookLauncher } from "./hook-launcher.js";
import { writeConfig } from "./config.js";

// Persistent install of the Relay companion into the user's local agents.
//
// After pairing, this registers the Relay MCP server (`relay mcp`) into Claude
// Code and Codex at user scope, so EVERY interactive session gets the Relay
// tools. The MCP server resolves the signed-in account's capabilities from the
// Relay API when it starts.
// It also installs a launchd agent that keeps the receive daemon running.

const DAEMON_LAUNCH_LABEL = "work.relay.companion";
const PILL_LAUNCH_LABEL = "work.relay.companion.pill";
const WINDOWS_DAEMON_TASK_NAME = "Relay Companion Daemon";
const WINDOWS_PILL_TASK_NAME = "Relay Companion Pill";
const LINUX_DAEMON_UNIT = `${DAEMON_LAUNCH_LABEL}.service`;
const LINUX_PILL_UNIT = `${PILL_LAUNCH_LABEL}.service`;
const LINUX_DESKTOP_FILE = "relay.desktop";
const LINUX_AUTOSTART_FILE = "work.relay.companion.pill.desktop";
const DEFAULT_NPM_INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
const RELAY_MAC_APP_NAME = "Relay.app";
const RELAY_MAC_APP_FALLBACK_NAME = "Relay Companion.app";
const RELAY_MAC_BUNDLE_IDENTIFIER = "work.relay.companion.launcher";
const { deleteDeviceToken } = createRequire(import.meta.url)("./credential-store.cjs");

export const PACKAGE_NAME = "relay-companion";

/** Absolute path to this companion's CLI entrypoint (deps resolve from here). */
export function relayBinPath() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../bin/relay.js");
}

function packageRootForBin(bin = relayBinPath(), platform = process.platform) {
  // Cross-platform tests may exercise the Darwin writer against a real Windows
  // temp tree. Preserve that host path while still parsing injected /Users/...
  // registrations with POSIX semantics.
  const api = platform === "win32" || /^[A-Za-z]:[\\/]/.test(String(bin)) ? path.win32 : path.posix;
  return api.resolve(api.dirname(bin), "..");
}

// A STABLE node path to bake into launchd plists and MCP registrations. process.execPath
// is often a version-managed binary (/opt/homebrew/Cellar/node/X/bin/node, ~/.nvm/…,
// ~/.n/…, fnm, volta) whose exact path disappears on a routine `brew upgrade node` or
// `nvm uninstall` — which would permanently break the daemon plist and every MCP entry.
// Prefer a well-known public symlink that currently resolves to the SAME runtime (it
// follows future upgrades); fall back to execPath when none matches.
const VERSION_MANAGED_NODE_RE = /[\\/](Cellar[\\/]node|\.nvm[\\/]versions|\.n[\\/]versions|\.fnm|fnm[\\/]|\.volta|\.hermes[\\/]node)[\\/]/i;
export function relayNodeVersionSupported(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(String(version || "").trim());
  if (!match) return false;
  const [, major, minor] = match.map(Number);
  return major > 22 || (major === 22 && minor >= 12);
}

export function compatibleNodeRuntime(executable, { runCommand = spawnSync } = {}) {
  try {
    const result = runCommand(executable, ["-p", "process.versions.node"], {
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
    });
    const ok = result?.ok === true || (!result?.error && result?.status === 0);
    return ok && relayNodeVersionSupported(result?.stdout ?? result?.out);
  } catch {
    return false;
  }
}

export function stableNodePath(execPath = process.execPath, {
  realpath = (p) => fs.realpathSync(p),
  existsSync = fs.existsSync,
  runCommand = spawnSync,
} = {}) {
  if (!execPath) return execPath;
  let realExec;
  try {
    realExec = realpath(execPath);
  } catch {
    realExec = execPath;
  }
  // Already a stable, non-version-managed path — keep it.
  if (!VERSION_MANAGED_NODE_RE.test(execPath) && !VERSION_MANAGED_NODE_RE.test(realExec)) return execPath;
  const candidates = ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"];
  try {
    const which = spawnSync("/usr/bin/which", ["node"], { encoding: "utf8", timeout: 5000 });
    const first = String(which.stdout || "").split("\n")[0].trim();
    if (first) candidates.push(first);
  } catch {}
  // Prefer a public path whose realpath matches the running runtime exactly.
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate) && realpath(candidate) === realExec) return candidate;
    } catch {}
  }
  // Otherwise prefer an existing public, non-version-managed Node only when it
  // can actually run this Relay release. A durable Node 20 path is not an
  // upgrade from a volatile but compatible Node 22/24 path.
  for (const candidate of candidates) {
    try {
      if (
        existsSync(candidate) &&
        !VERSION_MANAGED_NODE_RE.test(candidate) &&
        compatibleNodeRuntime(candidate, { runCommand })
      ) return candidate;
    } catch {}
  }
  return execPath;
}

function plistEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function shellSingleQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

export function systemdExecQuote(value) {
  const text = String(value ?? "");
  if (/[\0\r\n]/.test(text)) throw new Error("systemd arguments cannot contain control characters");
  return `"${text
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("$", () => "$$")
    .replaceAll("%", () => "%%")}"`;
}

export function desktopExecQuote(value) {
  const text = String(value ?? "");
  if (/[\0\r\n]/.test(text)) throw new Error("desktop entry arguments cannot contain control characters");
  return `"${text
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("`", "\\`")
    .replaceAll("$", "\\$")
    .replaceAll("%", () => "%%")}"`;
}

export function linuxDesktopPaths({ homeDir = os.homedir(), env = process.env } = {}) {
  const configHome = env.XDG_CONFIG_HOME || path.posix.join(homeDir, ".config");
  const dataHome = env.XDG_DATA_HOME || path.posix.join(homeDir, ".local", "share");
  return {
    daemonUnitPath: path.posix.join(configHome, "systemd", "user", LINUX_DAEMON_UNIT),
    pillUnitPath: path.posix.join(configHome, "systemd", "user", LINUX_PILL_UNIT),
    applicationPath: path.posix.join(dataHome, "applications", LINUX_DESKTOP_FILE),
    autostartPath: path.posix.join(configHome, "autostart", LINUX_AUTOSTART_FILE),
    pillStarterPath: path.posix.join(homeDir, ".relay", "bin", "relay-pill-start"),
    daemonLogPath: path.posix.join(homeDir, ".relay", "daemon.log"),
    pillLogPath: path.posix.join(homeDir, ".relay", "pill.log"),
  };
}

function linuxPathEnvironment(env = process.env) {
  return env.PATH || "/usr/local/bin:/usr/bin:/bin";
}

function linuxServiceEnvironment({ homeDir, env = process.env } = {}) {
  const values = {
    HOME: homeDir,
    PATH: linuxPathEnvironment(env),
    XDG_CONFIG_HOME: env.XDG_CONFIG_HOME,
    XDG_DATA_HOME: env.XDG_DATA_HOME,
    RELAY_CONFIG: env.RELAY_CONFIG,
    RELAY_CONFIG_DIR: env.RELAY_CONFIG_DIR,
    RELAY_HOME: env.RELAY_HOME,
    RELAY_COMPANION_HOME: env.RELAY_COMPANION_HOME,
    CLAUDE_HOME: env.CLAUDE_HOME,
    CODEX_HOME: env.CODEX_HOME,
  };
  return Object.entries(values)
    .filter(([, value]) => value)
    .map(([name, value]) => `Environment=${systemdExecQuote(`${name}=${value}`)}`)
    .join("\n");
}

export function linuxDaemonUnitText({ bin, node, homeDir = os.homedir(), env = process.env } = {}) {
  const paths = linuxDesktopPaths({ homeDir, env });
  const relayBinIdentity = Buffer.from(String(bin), "utf8").toString("base64url");
  return `[Unit]
Description=Relay Companion background service
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
# RelayBinBase64=${relayBinIdentity}
ExecStart=${[node, "--max-old-space-size=128", bin, "daemon"].map(systemdExecQuote).join(" ")}
Restart=always
RestartSec=3
${linuxServiceEnvironment({ homeDir, env })}
StandardOutput=${systemdExecQuote(`append:${paths.daemonLogPath}`)}
StandardError=${systemdExecQuote(`append:${paths.daemonLogPath}`)}

[Install]
WantedBy=default.target
`;
}

export function linuxPillUnitText({ electronPath, overlayMain, homeDir = os.homedir(), env = process.env } = {}) {
  const paths = linuxDesktopPaths({ homeDir, env });
  return `[Unit]
Description=Relay desktop pill
After=graphical-session.target
PartOf=graphical-session.target

[Service]
Type=simple
ExecStart=${[electronPath, overlayMain].map(systemdExecQuote).join(" ")}
Restart=on-failure
RestartSec=3
${linuxServiceEnvironment({ homeDir, env })}
StandardOutput=${systemdExecQuote(`append:${paths.pillLogPath}`)}
StandardError=${systemdExecQuote(`append:${paths.pillLogPath}`)}
`;
}

export function linuxPillStarterText() {
  return `#!/bin/sh
systemctl --user import-environment DISPLAY WAYLAND_DISPLAY XAUTHORITY DBUS_SESSION_BUS_ADDRESS XDG_CURRENT_DESKTOP XDG_SESSION_TYPE >/dev/null 2>&1 || true
exec systemctl --user restart ${LINUX_PILL_UNIT}
`;
}

export function linuxApplicationDesktopText({ node, bin, iconPath } = {}) {
  return `[Desktop Entry]
Type=Application
Version=1.0
Name=Relay
Comment=Open the Relay desktop companion
Exec=${desktopExecQuote(node)} ${desktopExecQuote(bin)} pill %u
Icon=${iconPath}
Terminal=false
StartupNotify=true
StartupWMClass=Relay
Categories=Utility;Network;
MimeType=x-scheme-handler/relay;
`;
}

export function linuxAutostartDesktopText({ pillStarterPath } = {}) {
  return `[Desktop Entry]
Type=Application
Version=1.0
Name=Relay
Comment=Start the Relay desktop companion
Exec=${desktopExecQuote(pillStarterPath)}
Terminal=false
StartupNotify=false
X-GNOME-Autostart-enabled=true
`;
}

function writeLinuxDesktopFile(file, contents, mode = 0o600) {
  writeTextAtomic(file, contents);
  try { fs.chmodSync(file, mode); } catch {}
}

function importLinuxGraphicalEnvironment(runCommand, env = process.env) {
  const names = [
    "DISPLAY",
    "WAYLAND_DISPLAY",
    "XAUTHORITY",
    "DBUS_SESSION_BUS_ADDRESS",
    "XDG_CURRENT_DESKTOP",
    "XDG_SESSION_TYPE",
  ].filter((name) => env[name]);
  if (!names.length) return { ok: true, skipped: true };
  return runCommand("systemctl", ["--user", "import-environment", ...names]);
}

/** Refuse Linux setup before host registrations when its lifecycle contract is unavailable. */
export function linuxDesktopPreflight({
  platform = process.platform,
  arch = process.arch,
  env = process.env,
  glibcVersion = process.report?.getReport?.()?.header?.glibcVersionRuntime || "",
  runCommand = run,
} = {}) {
  if (platform !== "linux") return { ok: true, skipped: true };
  if (!["x64", "arm64"].includes(arch)) {
    return { ok: false, reason: "linux_arch_unsupported", detail: `Relay supports Linux x64 and arm64, not ${arch}.` };
  }
  if (!glibcVersion) {
    return { ok: false, reason: "linux_libc_unsupported", detail: "Relay requires a glibc-based Linux distribution." };
  }
  if (!env.DISPLAY && !env.WAYLAND_DISPLAY) {
    return {
      ok: false,
      reason: "linux_graphical_session_missing",
      detail: "Relay setup must run inside a graphical X11 or Wayland login session.",
    };
  }
  const systemd = runCommand("systemctl", ["--user", "show-environment"]);
  if (!systemd.ok) {
    return {
      ok: false,
      reason: "systemd_user_unavailable",
      detail: systemd.out || "Relay requires an available systemd user manager.",
    };
  }
  return { ok: true, glibcVersion, session: env.WAYLAND_DISPLAY ? "wayland" : "x11" };
}

function installLinuxDaemonAutostart({ bin, node, runCommand, reload, homeDir, env = process.env }) {
  const paths = linuxDesktopPaths({ homeDir, env });
  writeLinuxDesktopFile(paths.daemonUnitPath, linuxDaemonUnitText({ bin, node, homeDir, env }));
  if (!reload) {
    const reloaded = runCommand("systemctl", ["--user", "daemon-reload"]);
    if (!reloaded.ok) {
      return { ok: false, reason: "systemd_user_unavailable", detail: reloaded.out, unitPath: paths.daemonUnitPath };
    }
    const enabled = runCommand("systemctl", ["--user", "enable", LINUX_DAEMON_UNIT]);
    return {
      ok: enabled.ok,
      ...(enabled.ok ? {} : { reason: "daemon_service_enable_failed", detail: enabled.out }),
      unitPath: paths.daemonUnitPath,
      logPath: paths.daemonLogPath,
      started: false,
    };
  }
  const reloaded = runCommand("systemctl", ["--user", "daemon-reload"]);
  if (!reloaded.ok) return { ok: false, reason: "systemd_user_unavailable", detail: reloaded.out, unitPath: paths.daemonUnitPath };
  const enabled = runCommand("systemctl", ["--user", "enable", "--now", LINUX_DAEMON_UNIT]);
  return {
    ok: enabled.ok,
    ...(enabled.ok ? {} : { reason: "daemon_service_start_failed", detail: enabled.out }),
    unitPath: paths.daemonUnitPath,
    logPath: paths.daemonLogPath,
    started: enabled.ok,
  };
}

function installLinuxPillAutostart({ bin, node, electronPath, overlayMain, runCommand, reload, homeDir, env = process.env }) {
  const paths = linuxDesktopPaths({ homeDir, env });
  const iconPath = path.posix.join(packageRootForBin(bin, "linux"), "overlay", "relayAppIcon.svg");
  writeLinuxDesktopFile(paths.pillUnitPath, linuxPillUnitText({ electronPath, overlayMain, homeDir, env }));
  writeLinuxDesktopFile(paths.pillStarterPath, linuxPillStarterText(), 0o700);
  writeLinuxDesktopFile(paths.applicationPath, linuxApplicationDesktopText({ node, bin, iconPath }));
  writeLinuxDesktopFile(paths.autostartPath, linuxAutostartDesktopText({ pillStarterPath: paths.pillStarterPath }));
  if (!reload) {
    return {
      ok: true,
      unitPath: paths.pillUnitPath,
      applicationPath: paths.applicationPath,
      autostartPath: paths.autostartPath,
      logPath: paths.pillLogPath,
      started: false,
    };
  }
  const reloaded = runCommand("systemctl", ["--user", "daemon-reload"]);
  if (!reloaded.ok) return { ok: false, reason: "systemd_user_unavailable", detail: reloaded.out, ...paths };
  importLinuxGraphicalEnvironment(runCommand, env);
  const started = runCommand("systemctl", ["--user", "restart", LINUX_PILL_UNIT]);
  // These are caches/associations, not the launch path itself. Some minimal
  // desktops omit the helpers, so both remain intentionally best-effort.
  runCommand("update-desktop-database", [path.dirname(paths.applicationPath)]);
  runCommand("xdg-mime", ["default", LINUX_DESKTOP_FILE, "x-scheme-handler/relay"]);
  return {
    ok: started.ok,
    ...(started.ok ? {} : { reason: "pill_service_start_failed", detail: started.out }),
    unitPath: paths.pillUnitPath,
    applicationPath: paths.applicationPath,
    autostartPath: paths.autostartPath,
    logPath: paths.pillLogPath,
    electronPath,
    overlayMain,
    started: started.ok,
  };
}

function packageVersion(packageRoot) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
    return typeof pkg.version === "string" && pkg.version ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

export function exactCompanionSpec(version) {
  const normalized = String(version || "").trim();
  if (!/^\d+\.\d+\.\d+$/.test(normalized)) {
    throw new Error(`Relay requires an exact published version, received: ${normalized || "missing"}`);
  }
  return `${PACKAGE_NAME}@${normalized}`;
}

export function npmInstallArgs({ version, prefix = null, global = false } = {}) {
  const args = ["install", "--ignore-scripts", "--no-audit", "--no-fund"];
  if (global) args.push("-g");
  if (prefix) args.push("--prefix", prefix);
  args.push(exactCompanionSpec(version));
  return args;
}

function npmInvocation(args, {
  env = process.env,
  execPath = process.execPath,
  platform = process.platform,
  existsSync = fs.existsSync,
} = {}) {
  const candidates = [
    env.npm_execpath,
    path.resolve(path.dirname(execPath), "../lib/node_modules/npm/bin/npm-cli.js"),
    path.resolve(path.dirname(execPath), "node_modules/npm/bin/npm-cli.js"),
  ].filter(Boolean);
  const npmCli = candidates.find((candidate) => {
    try { return existsSync(candidate); } catch { return false; }
  });
  if (npmCli) return { command: execPath, args: [npmCli, ...args] };
  return { command: platform === "win32" ? "npm.cmd" : "npm", args };
}

function runNpm(args, options = {}) {
  const invocation = npmInvocation(args);
  return run(invocation.command, invocation.args, options);
}

function isRelayOwnedMacApp(appPath) {
  try {
    const info = fs.readFileSync(path.join(appPath, "Contents", "Info.plist"), "utf8");
    return new RegExp(
      `<key>\\s*CFBundleIdentifier\\s*</key>\\s*<string>\\s*${RELAY_MAC_BUNDLE_IDENTIFIER.replaceAll(".", "\\.")}\\s*</string>`,
    ).test(info);
  } catch {
    return false;
  }
}

function chooseRelayMacAppPath(applicationsDir) {
  const candidates = [RELAY_MAC_APP_NAME, RELAY_MAC_APP_FALLBACK_NAME].map((name) => path.join(applicationsDir, name));
  // Keep using an existing Relay-owned fallback bundle even if the primary name
  // later becomes free. Otherwise a repair would create a second Spotlight result
  // and strand the still-valid fallback app.
  return (
    candidates.find((candidate) => fs.existsSync(candidate) && isRelayOwnedMacApp(candidate)) ||
    candidates.find((candidate) => !fs.existsSync(candidate)) ||
    null
  );
}

function buildRelayMacIcon(packageRoot, resourcesDir, runCommand) {
  const sourceSvg = path.join(packageRoot, "overlay", "relayAppIcon.svg");
  const fallbackPng = path.join(packageRoot, "overlay", "relayTrayTemplate@2x.png");
  const iconsetDir = path.join(resourcesDir, "RelayIcon.iconset");
  const masterPng = path.join(resourcesDir, "RelayIcon-1024.png");
  const icnsPath = path.join(resourcesDir, "RelayIcon.icns");
  if (fs.existsSync(sourceSvg)) {
    fs.mkdirSync(iconsetDir, { recursive: true });
    const converted = runCommand("/usr/bin/sips", ["-s", "format", "png", sourceSvg, "--out", masterPng]);
    if (converted.ok && fs.existsSync(masterPng)) {
      const renditions = [
        ["icon_16x16.png", 16],
        ["icon_16x16@2x.png", 32],
        ["icon_32x32.png", 32],
        ["icon_32x32@2x.png", 64],
        ["icon_128x128.png", 128],
        ["icon_128x128@2x.png", 256],
        ["icon_256x256.png", 256],
        ["icon_256x256@2x.png", 512],
        ["icon_512x512.png", 512],
        ["icon_512x512@2x.png", 1024],
      ];
      let rendered = true;
      for (const [name, size] of renditions) {
        const result = runCommand("/usr/bin/sips", [
          "-z",
          String(size),
          String(size),
          masterPng,
          "--out",
          path.join(iconsetDir, name),
        ]);
        if (!result.ok) rendered = false;
      }
      if (rendered) {
        const packed = runCommand("/usr/bin/iconutil", ["-c", "icns", iconsetDir, "-o", icnsPath]);
        if (packed.ok && fs.existsSync(icnsPath)) {
          fs.rmSync(iconsetDir, { recursive: true, force: true });
          fs.rmSync(masterPng, { force: true });
          return "RelayIcon.icns";
        }
      }
    }
  }
  fs.rmSync(iconsetDir, { recursive: true, force: true });
  fs.rmSync(masterPng, { force: true });
  if (fs.existsSync(fallbackPng)) {
    fs.copyFileSync(fallbackPng, path.join(resourcesDir, "RelayIcon.png"));
    return "RelayIcon.png";
  }
  return null;
}

/**
 * Build the small, real macOS application users can find in Spotlight and open to
 * bring Relay back. The launcher deliberately exits after starting Electron in the
 * background: every LaunchServices open then becomes a fresh single-instance signal
 * to the long-running pill, instead of an activation event getting lost in a shell
 * wrapper process.
 */
export function installRelayMacApp({
  bin = relayBinPath(),
  electronPath,
  overlayMain,
  homeDir = os.homedir(),
  runCommand = run,
} = {}) {
  if (!electronPath || !overlayMain || !fs.existsSync(electronPath) || !fs.existsSync(overlayMain)) {
    return { ok: false, reason: "pill_runtime_missing", electronPath, overlayMain };
  }
  const packageRoot = packageRootForBin(bin);
  const applicationsDir = path.join(homeDir, "Applications");
  const appPath = chooseRelayMacAppPath(applicationsDir);
  if (!appPath) {
    return {
      ok: false,
      reason: "relay_app_name_conflict",
      appPaths: [RELAY_MAC_APP_NAME, RELAY_MAC_APP_FALLBACK_NAME].map((name) => path.join(applicationsDir, name)),
    };
  }
  // Keep the staging bundle's final extension as .app. osacompile decides whether
  // to produce an application bundle from the output extension; a generic .tmp
  // path would produce a flat compiled script instead. Nest it under a hidden,
  // same-volume directory so Spotlight cannot transiently expose a duplicate app.
  const stagingDir = path.join(applicationsDir, `.relay-app-staging-${process.pid}-${Date.now()}`);
  const tmpPath = path.join(stagingDir, RELAY_MAC_APP_NAME);
  const contentsDir = path.join(tmpPath, "Contents");
  const macosDir = path.join(contentsDir, "MacOS");
  const resourcesDir = path.join(contentsDir, "Resources");
  const appletExecutablePath = path.join(macosDir, "applet");
  const launcherPath = path.join(resourcesDir, "relay-launcher.sh");
  const logPath = path.join(homeDir, ".relay", "pill.log");
  const pillStatusPath = path.join(homeDir, ".relay-companion", "pill-status.json");
  const pillPlistPath = path.join(homeDir, "Library", "LaunchAgents", `${PILL_LAUNCH_LABEL}.plist`);
  const version = packageVersion(packageRoot);

  try {
    fs.rmSync(stagingDir, { recursive: true, force: true });
    fs.mkdirSync(applicationsDir, { recursive: true });
    fs.mkdirSync(stagingDir, { recursive: true });
    fs.mkdirSync(path.dirname(logPath), { recursive: true });

    // LaunchServices rejects a shell script used directly as CFBundleExecutable
    // (NSOSStatusErrorDomain -10669 on current macOS), even when it has a valid
    // shebang and executable mode. Generate the system AppleScript applet wrapper
    // so the bundle has a native universal Mach-O executable. The applet only runs
    // our resource shell script; it does not automate or inspect another app.
    const appletSource = [
      "on run",
      '  set launcherPath to POSIX path of (path to resource "relay-launcher.sh")',
      '  do shell script "/bin/sh " & quoted form of launcherPath',
      "end run",
    ].join("\n");
    const compiled = runCommand("/usr/bin/osacompile", ["-e", appletSource, "-o", tmpPath]);
    if (!compiled.ok || !fs.existsSync(appletExecutablePath)) {
      throw new Error(`could not compile native Relay app launcher${compiled.out ? `: ${compiled.out}` : ""}`);
    }
    fs.mkdirSync(resourcesDir, { recursive: true });

    const launcher = [
      "#!/bin/sh",
      'nonce="app-$$-$(date +%s)"',
      'domain="gui/$(id -u)"',
      `service="$domain/${PILL_LAUNCH_LABEL}"`,
      `plist=${shellSingleQuote(pillPlistPath)}`,
      `status=${shellSingleQuote(pillStatusPath)}`,
      // If an agent unloaded Relay rather than merely killing it, restore the
      // launchd-owned process first. Otherwise a standalone Electron process would
      // work temporarily but later fight KeepAlive when repair/bootstrap runs.
      'if ! /bin/launchctl print "$service" >/dev/null 2>&1 && [ -f "$plist" ]; then',
      '  /bin/launchctl bootstrap "$domain" "$plist" >/dev/null 2>&1 || true',
      "fi",
      '/bin/launchctl kickstart "$service" >/dev/null 2>&1 || true',
      // launchd's `state = running` only means exec started; it can be reported
      // before Electron acquires the single-instance lock. Wait for the owner's
      // atomic ready acknowledgement instead, and verify its pid is still alive.
      // The nonce-bearing launch below then signals a real owner rather than
      // racing it and accidentally becoming an orphan outside launchd.
      "i=0",
      'while [ "$i" -lt 80 ]; do',
      '  owner_pid=$(/usr/bin/plutil -extract pid raw -o - "$status" 2>/dev/null || true)',
      '  owner_ready=$(/usr/bin/plutil -extract ready raw -o - "$status" 2>/dev/null || true)',
      '  if [ "$owner_ready" = "true" ] && [ -n "$owner_pid" ] && /bin/kill -0 "$owner_pid" 2>/dev/null; then',
      "    break",
      "  fi",
      "  /bin/sleep 0.1",
      '  i=$((i + 1))',
      "done",
      `nohup ${shellSingleQuote(electronPath)} ${shellSingleQuote(overlayMain)} --relay-reopen "$nonce" >> ${shellSingleQuote(logPath)} 2>&1 &`,
      "exit 0",
      "",
    ].join("\n");
    fs.writeFileSync(launcherPath, launcher, { mode: 0o755 });
    fs.chmodSync(launcherPath, 0o755);

    const iconName = buildRelayMacIcon(packageRoot, resourcesDir, runCommand);
    const iconEntry = iconName
      ? `  <key>CFBundleIconFile</key><string>${iconName}</string>\n`
      : "";
    const info = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Relay</string>
  <key>CFBundleDisplayName</key><string>Relay</string>
  <key>CFBundleExecutable</key><string>applet</string>
  <key>CFBundleIdentifier</key><string>${RELAY_MAC_BUNDLE_IDENTIFIER}</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleSignature</key><string>aplt</string>
  <key>CFBundleShortVersionString</key><string>${plistEscape(version)}</string>
  <key>CFBundleVersion</key><string>${plistEscape(version)}</string>
${iconEntry}  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
  <key>OSAAppletShowStartupScreen</key><false/>
</dict>
</plist>
`;
    fs.writeFileSync(path.join(contentsDir, "Info.plist"), info);
    fs.writeFileSync(path.join(contentsDir, "PkgInfo"), "APPL????");

    // osacompile signs the initial applet, so adding our launcher, icon, and final
    // Info.plist invalidates that temporary signature. Re-sign the completed bundle
    // and verify it before exposing it to LaunchServices; otherwise a bundle can be
    // indexed by Spotlight yet still fail when the user clicks it.
    const signed = runCommand("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", tmpPath]);
    if (!signed.ok) {
      throw new Error(`could not sign native Relay app launcher${signed.out ? `: ${signed.out}` : ""}`);
    }
    const verified = runCommand("/usr/bin/codesign", ["--verify", "--deep", "--strict", tmpPath]);
    if (!verified.ok) {
      throw new Error(`could not verify native Relay app launcher${verified.out ? `: ${verified.out}` : ""}`);
    }

    // Replace the Relay-owned bundle atomically enough that Spotlight never indexes
    // a half-written app. LaunchServices/Spotlight refreshes are best-effort; merely
    // placing a valid .app under ~/Applications is sufficient on a normal macOS host.
    // Re-check ownership at the destructive boundary in case another process placed
    // or replaced an unrelated app at the chosen path while the bundle was compiling.
    if (fs.existsSync(appPath) && !isRelayOwnedMacApp(appPath)) {
      throw new Error("Relay app target changed during installation");
    }
    fs.rmSync(appPath, { recursive: true, force: true });
    fs.renameSync(tmpPath, appPath);
    fs.rmSync(stagingDir, { recursive: true, force: true });
    runCommand("/usr/bin/touch", [appPath]);
    runCommand(
      "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister",
      ["-f", appPath]
    );
    runCommand("/usr/bin/mdimport", [appPath]);
    return {
      ok: true,
      appPath,
      launcherPath: path.join(appPath, "Contents", "Resources", "relay-launcher.sh"),
      appletExecutablePath: path.join(appPath, "Contents", "MacOS", "applet"),
    };
  } catch (error) {
    try {
      fs.rmSync(stagingDir, { recursive: true, force: true });
    } catch {}
    return {
      ok: false,
      reason: "relay_app_install_failed",
      appPath,
      detail: error && error.message ? error.message : String(error),
    };
  }
}

/**
 * A STABLE path to the companion CLI that the agents and the daemon can keep
 * launching. When `setup` runs from npx (an ephemeral cache that gets cleaned),
 * we global-install the package and point at that instead, so the registration
 * doesn't rot. From a dev checkout or an existing global install the running
 * path is already stable, so we use it directly.
 */
export function resolveStableBin() {
  const here = relayBinPath();
  const version = packageVersion(packageRootForBin(here));
  const spec = exactCompanionSpec(version);
  const ephemeral = /[\\/](_npx|\.npm[\\/]_npx|npm-cache[\\/]_npx)[\\/]/.test(here);
  if (!ephemeral) return { bin: here, stable: true, version, spec };
  // Prefer a real global install.
  const install = runNpm(npmInstallArgs({ version, global: true }), {
    timeoutMs: npmInstallTimeoutMs(),
  });
  if (install.ok) {
    const rootResult = runNpm(["root", "-g"]);
    const root = rootResult.ok ? rootResult.out.split(/\r?\n/).at(-1)?.trim() : "";
    const globalBin = path.join(root, ...PACKAGE_NAME.split("/"), "bin", "relay.js");
    if (root && fs.existsSync(globalBin)) return { bin: globalBin, stable: true, version, spec };
  }
  // Global install failed (permissions, no prefix). Install into a relay-owned prefix
  // under ~/.relay/lib — no sudo, survives npx-cache pruning — rather than pointing the
  // daemon/MCP registrations at the ephemeral _npx path (which vanishes when the cache
  // is cleaned, silently killing the daemon later).
  const prefix = path.join(os.homedir(), ".relay", "lib");
  try {
    fs.mkdirSync(prefix, { recursive: true });
  } catch {}
  const localInstall = runNpm(npmInstallArgs({ version, prefix }), {
    timeoutMs: npmInstallTimeoutMs(),
  });
  const localBin = path.join(prefix, "node_modules", ...PACKAGE_NAME.split("/"), "bin", "relay.js");
  if (localInstall.ok && fs.existsSync(localBin)) return { bin: localBin, stable: true, version, spec };
  // Last resort: the ephemeral path. Flag it so callers can warn the user that the
  // registration may rot when the npx cache is pruned.
  return { bin: here, stable: false, version, spec };
}

function npmInstallTimeoutMs(env = process.env) {
  const parsed = Number(env.RELAY_NPM_INSTALL_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_NPM_INSTALL_TIMEOUT_MS;
}

function run(cmd, args, { timeoutMs = 20_000 } = {}) {
  // windowsHide keeps `schtasks`/`npm` helper spawns from flashing a console window
  // when this runs from a windowless parent (the daemon's repair path).
  const res = spawnSync(cmd, args, { encoding: "utf8", timeout: timeoutMs, windowsHide: true });
  return {
    ok: !res.error && res.status === 0,
    status: res.status,
    out: `${res.stdout || ""}${res.stderr || ""}`.trim(),
    missing: Boolean(res.error && res.error.code === "ENOENT"),
  };
}

/**
 * run(), without blocking the event loop: the same {ok, status, out, missing}
 * shape, resolved when the process exits. For callers that live inside an
 * event loop someone is looking at (the pill's Electron main process) and
 * need to wait on a helper that may legitimately take several seconds.
 */
function runAsync(cmd, args, { timeoutMs = 20_000 } = {}) {
  return new Promise((resolve) => {
    let out = "";
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let child;
    try {
      child = spawn(cmd, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      finish({ ok: false, status: null, out: String(error && error.message), missing: error && error.code === "ENOENT" });
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      finish({ ok: false, status: null, out: `${out}\n(timed out after ${timeoutMs}ms)`.trim(), missing: false });
    }, timeoutMs);
    child.stdout.on("data", (d) => { out += String(d); });
    child.stderr.on("data", (d) => { out += String(d); });
    child.on("error", (error) => {
      clearTimeout(timer);
      finish({ ok: false, status: null, out: String(error && error.message), missing: error && error.code === "ENOENT" });
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      finish({ ok: status === 0, status, out: out.trim(), missing: false });
    });
  });
}

export function claudeCodeConfigPath() {
  return process.env.CLAUDE_CODE_CONFIG || path.join(os.homedir(), ".claude.json");
}

export function codexConfigPath() {
  if (process.env.CODEX_CONFIG) return process.env.CODEX_CONFIG;
  const home = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  return path.join(home, "config.toml");
}

export function codexHooksPath() {
  if (process.env.CODEX_HOOKS) return process.env.CODEX_HOOKS;
  const home = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  return path.join(home, "hooks.json");
}

function readJsonObject(file) {
  const text = fs.readFileSync(file, "utf8");
  const parsed = JSON.parse(text);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

function writeTextAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, value);
  fs.renameSync(tmp, file);
}

export function writeClaudeCodeMcpConfig(
  bin = relayBinPath(),
  node = stableNodePath(),
  configPath = claudeCodeConfigPath(),
) {
  if (!fs.existsSync(configPath)) return { ok: false, reason: "claude_config_missing", configPath };
  try {
    const cfg = readJsonObject(configPath);
    const existingServers =
      cfg.mcpServers && typeof cfg.mcpServers === "object" && !Array.isArray(cfg.mcpServers)
        ? cfg.mcpServers
        : {};
    cfg.mcpServers = {
      ...existingServers,
      relay: {
        type: "stdio",
        command: node,
        // Heap-capped: one of these spawns per agent session (see codexRelayMcpTomlSection).
        args: ["--max-old-space-size=96", bin, "mcp"],
        env: {},
        alwaysLoad: true,
      },
    };
    writeJsonAtomic(configPath, cfg);
    return { ok: true, method: "config", configPath };
  } catch (error) {
    return {
      ok: false,
      reason: "claude_config_write_failed",
      configPath,
      detail: error && error.message ? error.message : String(error),
    };
  }
}

export function removeClaudeCodeMcpConfig(configPath = claudeCodeConfigPath()) {
  if (!fs.existsSync(configPath)) return { ok: true, configPath };
  try {
    const cfg = readJsonObject(configPath);
    if (cfg.mcpServers && typeof cfg.mcpServers === "object" && !Array.isArray(cfg.mcpServers)) {
      delete cfg.mcpServers.relay;
      writeJsonAtomic(configPath, cfg);
    }
    return { ok: true, configPath };
  } catch (error) {
    return {
      ok: false,
      reason: "claude_config_write_failed",
      configPath,
      detail: error && error.message ? error.message : String(error),
    };
  }
}

// ---- Claude Code hooks (Open-in-current-chat runtime) ----------------------
//
// `relay claude-hook` (src/claude-hook.js) must run on PostToolUse / Stop /
// UserPromptSubmit / SessionStart so a pill "Open in current chat" click can be
// delivered into the user's LIVE Claude session mid-turn, at turn end, or on
// the next prompt. Claude Code hot-reloads settings hooks on change, so the
// registration takes effect without restarting Claude.

const CLAUDE_HOOK_EVENTS = ["PostToolUse", "Stop", "UserPromptSubmit", "SessionStart"];
// These are Relay's own bounded AI-session capabilities. Claude otherwise pauses
// a background/idle agent for an interactive MCP approval that no foreground UI
// exists to answer, which makes agent-to-agent delivery look completed while the
// target is actually stuck. Install both current names and the two legacy aliases
// so chats created before a companion upgrade can still finish cleanly.
const RELAY_CLAUDE_ALLOWED_TOOLS = [
  "mcp__relay__relay_ai_sessions",
  "mcp__relay__relay_ai_session",
  "mcp__relay__relay_sessions",
  "mcp__relay__relay_session",
];
// Ours is identifiable by the command containing "relay.js claude-hook"
// (quoting-tolerant): install replaces exactly these, uninstall removes ONLY these.
const RELAY_CLAUDE_HOOK_COMMAND_RE = /relay\.js["']?\s+claude-hook(?:\s|$)/;

export function claudeSettingsPath() {
  return (
    process.env.CLAUDE_SETTINGS ||
    path.join(process.env.CLAUDE_HOME || path.join(os.homedir(), ".claude"), "settings.json")
  );
}

/**
 * True when Claude looks present on this machine, judged ONLY by the directory
 * that holds claudeSettingsPath() (so CLAUDE_SETTINGS / CLAUDE_HOME overrides are
 * respected for tests). Deliberately not a `claude` CLI probe: Windows installs
 * routinely have Claude Code/Desktop with ~/.claude configured by hand and no
 * `claude` on PATH, and those installs still need the hook runtime.
 */
export function claudeAppearsPresent({ settingsPath = claudeSettingsPath() } = {}) {
  try {
    return fs.existsSync(path.dirname(settingsPath));
  } catch {
    return false;
  }
}

function shellArg(value) {
  const clean = String(value);
  return /\s/.test(clean) ? `"${clean.replaceAll('"', '\\"')}"` : clean;
}

function stableHookCommand(hookInvocation, hookName) {
  const parts = [hookInvocation.command, ...hookInvocation.argsPrefix];
  const quoted = hookInvocation.platform === "win32"
    ? parts.map(shellArg)
    : parts.map(shellSingleQuote);
  // Keep the final hook name unquoted for Relay 0.1.57's ownership regex.
  return [...quoted, hookName].join(" ");
}

export function claudeHookCommand(bin = relayBinPath(), node = stableNodePath()) {
  return `${shellArg(node)} ${shellArg(bin)} claude-hook`;
}

export function claudeHookHandler(bin = relayBinPath(), node = stableNodePath(), hookInvocation = null) {
  if (hookInvocation) {
    return {
      type: "command",
      // Keep the complete `relay.js claude-hook` signature in command, not
      // only in exec-form args. Relay 0.1.57-era downgrade/uninstall code knew
      // only how to identify the shell form; retaining it prevents duplicate
      // handlers when a fleet rolls back.
      command: stableHookCommand(hookInvocation, "claude-hook"),
      timeout: 5,
    };
  }
  return {
    type: "command",
    command: String(node),
    args: [String(bin), "claude-hook"],
    timeout: 5,
  };
}

export function isRelayClaudeHookCommand(commandOrHook) {
  if (commandOrHook && typeof commandOrHook === "object") {
    const args = Array.isArray(commandOrHook.args) ? commandOrHook.args.map(String) : [];
    const script = String(args.at(-2) || "").replaceAll("\\", "/");
    if (args.at(-1) === "claude-hook" && script.endsWith("/relay.js")) return true;
    return RELAY_CLAUDE_HOOK_COMMAND_RE.test(String(commandOrHook.command || ""));
  }
  return RELAY_CLAUDE_HOOK_COMMAND_RE.test(String(commandOrHook || ""));
}

// Strip our hook from a settings hook-entry list, preserving everything the
// user put there. An entry that mixes our hook with user hooks keeps the user
// hooks; an entry that only carried ours is dropped.
function withoutRelayClaudeHooks(entries) {
  const kept = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || typeof entry !== "object" || !Array.isArray(entry.hooks)) {
      kept.push(entry);
      continue;
    }
    const keptHooks = entry.hooks.filter((hook) => !isRelayClaudeHookCommand(hook));
    if (keptHooks.length === entry.hooks.length) kept.push(entry);
    else if (keptHooks.length > 0) kept.push({ ...entry, hooks: keptHooks });
  }
  return kept;
}

/**
 * Merge the Relay claude-hook into ~/.claude/settings.json (path overridable via
 * CLAUDE_SETTINGS / CLAUDE_HOME for tests). Idempotent — reinstalling never
 * duplicates — and preserves all user content; creates the file if missing.
 */
export function installClaudeHooks(
  bin = relayBinPath(),
  node = stableNodePath(),
  { settingsPath = claudeSettingsPath(), hookInvocation = null } = {},
) {
  const handler = claudeHookHandler(bin, node, hookInvocation);
  let settings = {};
  if (fs.existsSync(settingsPath)) {
    try {
      settings = readJsonObject(settingsPath);
    } catch (error) {
      // Never clobber a settings file we cannot parse — the user's own hooks
      // and permissions live in it.
      return {
        ok: false,
        reason: "claude_settings_unreadable",
        settingsPath,
        detail: error && error.message ? error.message : String(error),
      };
    }
  }
  try {
    const permissions =
      settings.permissions && typeof settings.permissions === "object" && !Array.isArray(settings.permissions)
        ? settings.permissions
        : {};
    const allowed = Array.isArray(permissions.allow) ? permissions.allow : [];
    permissions.allow = [...allowed];
    for (const tool of RELAY_CLAUDE_ALLOWED_TOOLS) {
      if (!permissions.allow.includes(tool)) permissions.allow.push(tool);
    }
    settings.permissions = permissions;
    const hooks =
      settings.hooks && typeof settings.hooks === "object" && !Array.isArray(settings.hooks) ? settings.hooks : {};
    for (const event of CLAUDE_HOOK_EVENTS) {
      const cleaned = withoutRelayClaudeHooks(hooks[event]);
      const installedHandler = Array.isArray(handler.args) ? { ...handler, args: [...handler.args] } : { ...handler };
      cleaned.push({ matcher: "*", hooks: [installedHandler] });
      hooks[event] = cleaned;
    }
    settings.hooks = hooks;
    writeJsonAtomic(settingsPath, settings);
    return {
      ok: true,
      settingsPath,
      command: handler.command,
      ...(Array.isArray(handler.args) ? { args: [...handler.args] } : {}),
      events: [...CLAUDE_HOOK_EVENTS],
    };
  } catch (error) {
    return {
      ok: false,
      reason: "claude_settings_write_failed",
      settingsPath,
      detail: error && error.message ? error.message : String(error),
    };
  }
}

/** Install Claude hooks through the upgrade-surviving bridge. */
export function installClaudeHooksWithStableLauncher(
  bin = relayBinPath(),
  node = stableNodePath(),
  { homeDir = os.homedir(), platform = process.platform, ...options } = {},
) {
  try {
    const hookInvocation = ensureStableHookLauncher({ targetBin: bin, node, homeDir, platform });
    return installClaudeHooks(bin, node, { ...options, hookInvocation });
  } catch (error) {
    return { ok: false, reason: "hook_launcher_write_failed", detail: error?.message || String(error) };
  }
}

/** Remove ONLY the Relay claude-hook entries; every user hook survives. */
export function uninstallClaudeHooks({ settingsPath = claudeSettingsPath() } = {}) {
  if (!fs.existsSync(settingsPath)) return { ok: true, settingsPath };
  let settings;
  try {
    settings = readJsonObject(settingsPath);
  } catch (error) {
    return {
      ok: false,
      reason: "claude_settings_unreadable",
      settingsPath,
      detail: error && error.message ? error.message : String(error),
    };
  }
  const hooks = settings.hooks;
  let changed = false;
  const permissions = settings.permissions;
  if (permissions && typeof permissions === "object" && !Array.isArray(permissions) && Array.isArray(permissions.allow)) {
    const kept = permissions.allow.filter((tool) => !RELAY_CLAUDE_ALLOWED_TOOLS.includes(tool));
    if (kept.length !== permissions.allow.length) {
      changed = true;
      if (kept.length) permissions.allow = kept;
      else delete permissions.allow;
    }
  }
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) {
    if (changed) writeJsonAtomic(settingsPath, settings);
    return { ok: true, settingsPath };
  }
  // Sweep every event key (not just the four we install today) so entries from
  // older/newer Relay versions are removed too.
  for (const event of Object.keys(hooks)) {
    if (!Array.isArray(hooks[event])) continue;
    const before = hooks[event];
    const after = withoutRelayClaudeHooks(before);
    if (after.length === before.length && after.every((entry, index) => entry === before[index])) continue;
    changed = true;
    if (after.length === 0) delete hooks[event];
    else hooks[event] = after;
  }
  if (!changed) return { ok: true, settingsPath };
  if (Object.keys(hooks).length === 0) delete settings.hooks;
  try {
    writeJsonAtomic(settingsPath, settings);
    return { ok: true, settingsPath, removed: true };
  } catch (error) {
    return {
      ok: false,
      reason: "claude_settings_write_failed",
      settingsPath,
      detail: error && error.message ? error.message : String(error),
    };
  }
}

// ---- Codex hooks (private recent Relay context) ----------------------------

const CODEX_RELAY_CONTEXT_EVENTS = ["UserPromptSubmit", "PostToolUse", "Stop"];
const RELAY_CODEX_HOOK_COMMAND_RE = /relay\.js["']?\s+codex-hook(?:\s|$)/;

export function codexHookCommand(bin = relayBinPath(), node = stableNodePath(), hookInvocation = null) {
  if (hookInvocation) {
    return stableHookCommand(hookInvocation, "codex-hook");
  }
  return `${shellArg(node)} ${shellArg(bin)} codex-hook`;
}

export function isRelayCodexHookCommand(command) {
  return RELAY_CODEX_HOOK_COMMAND_RE.test(String(command || ""));
}

function withoutRelayCodexHooks(entries) {
  const kept = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || typeof entry !== "object" || !Array.isArray(entry.hooks)) {
      kept.push(entry);
      continue;
    }
    const keptHooks = entry.hooks.filter((hook) => !isRelayCodexHookCommand(hook && hook.command));
    if (keptHooks.length === entry.hooks.length) kept.push(entry);
    else if (keptHooks.length) kept.push({ ...entry, hooks: keptHooks });
  }
  return kept;
}

/** Merge Relay's hooks into ~/.codex/hooks.json without replacing user hooks. */
export function installCodexHooks(
  bin = relayBinPath(),
  node = stableNodePath(),
  { hooksPath = codexHooksPath(), hookInvocation = null } = {},
) {
  const command = codexHookCommand(bin, node, hookInvocation);
  let config = {};
  if (fs.existsSync(hooksPath)) {
    try {
      config = readJsonObject(hooksPath);
    } catch (error) {
      return {
        ok: false,
        reason: "codex_hooks_unreadable",
        hooksPath,
        detail: error && error.message ? error.message : String(error),
      };
    }
  }
  try {
    const before = JSON.stringify(config);
    const hooks = config.hooks && typeof config.hooks === "object" && !Array.isArray(config.hooks)
      ? config.hooks
      : {};
    for (const event of CODEX_RELAY_CONTEXT_EVENTS) {
      const cleaned = withoutRelayCodexHooks(hooks[event]);
      cleaned.push({ matcher: "*", hooks: [{ type: "command", command, timeout: 5 }] });
      hooks[event] = cleaned;
    }
    config.hooks = hooks;
    const changed = JSON.stringify(config) !== before;
    if (changed) writeJsonAtomic(hooksPath, config);
    return {
      ok: true,
      hooksPath,
      command,
      events: [...CODEX_RELAY_CONTEXT_EVENTS],
      changed,
      requiresTrustReview: changed,
    };
  } catch (error) {
    return {
      ok: false,
      reason: "codex_hooks_write_failed",
      hooksPath,
      detail: error && error.message ? error.message : String(error),
    };
  }
}

/** Install Codex hooks through the upgrade-surviving bridge. */
export function installCodexHooksWithStableLauncher(
  bin = relayBinPath(),
  node = stableNodePath(),
  { homeDir = os.homedir(), platform = process.platform, ...options } = {},
) {
  try {
    const hookInvocation = ensureStableHookLauncher({ targetBin: bin, node, homeDir, platform });
    return installCodexHooks(bin, node, { ...options, hookInvocation });
  } catch (error) {
    return { ok: false, reason: "hook_launcher_write_failed", detail: error?.message || String(error) };
  }
}

function jsonFileHasRelayHook(filePath, predicate) {
  if (!fs.existsSync(filePath)) return false;
  const config = readJsonObject(filePath);
  const hooks = config.hooks;
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) return false;
  for (const entries of Object.values(hooks)) {
    for (const entry of Array.isArray(entries) ? entries : []) {
      for (const hook of entry && Array.isArray(entry.hooks) ? entry.hooks : []) {
        if (predicate(hook)) return true;
      }
    }
  }
  return false;
}

function unreadableFileLooksRelayOwned(filePath, hookName) {
  try {
    const source = fs.readFileSync(filePath, "utf8");
    return new RegExp(`relay\\.js[\\s\\S]{0,512}${hookName}`).test(source);
  } catch {
    return false;
  }
}

/**
 * Move only already-installed Relay hooks onto the stable bridge. This is the
 * updater/repair migration path: it never creates a host config merely because
 * Relay happens to be updating on the machine.
 */
export function repairExistingAgentHooks({
  bin = relayBinPath(),
  node = stableNodePath(),
  homeDir = os.homedir(),
  platform = process.platform,
  claudeSettingsFile = process.env.CLAUDE_SETTINGS
    || path.join(process.env.CLAUDE_HOME || path.join(homeDir, ".claude"), "settings.json"),
  codexHooksFile = process.env.CODEX_HOOKS
    || path.join(process.env.CODEX_HOME || path.join(homeDir, ".codex"), "hooks.json"),
} = {}) {
  let claudeInstalled = false;
  let codexInstalled = false;
  try {
    claudeInstalled = jsonFileHasRelayHook(claudeSettingsFile, isRelayClaudeHookCommand);
  } catch (error) {
    if (unreadableFileLooksRelayOwned(claudeSettingsFile, "claude-hook")) {
      return { ok: false, attempted: false, reason: "claude_settings_unreadable", detail: error?.message || String(error) };
    }
  }
  try {
    codexInstalled = jsonFileHasRelayHook(
      codexHooksFile,
      (hook) => isRelayCodexHookCommand(hook && hook.command),
    );
  } catch (error) {
    if (unreadableFileLooksRelayOwned(codexHooksFile, "codex-hook")) {
      return { ok: false, attempted: false, reason: "codex_hooks_unreadable", detail: error?.message || String(error) };
    }
  }
  if (!claudeInstalled && !codexInstalled) return { ok: true, attempted: false };

  let hookInvocation;
  try {
    hookInvocation = ensureStableHookLauncher({ targetBin: bin, node, homeDir, platform });
  } catch (error) {
    return { ok: false, attempted: true, reason: "hook_launcher_write_failed", detail: error?.message || String(error) };
  }
  const claudeHooks = claudeInstalled
    ? installClaudeHooks(bin, node, { settingsPath: claudeSettingsFile, hookInvocation })
    : null;
  const codexHooks = codexInstalled
    ? installCodexHooks(bin, node, { hooksPath: codexHooksFile, hookInvocation })
    : null;
  return {
    ok: Boolean((!claudeHooks || claudeHooks.ok) && (!codexHooks || codexHooks.ok)),
    attempted: true,
    hookInvocation,
    claudeHooks,
    codexHooks,
  };
}

/** Remove only Relay command handlers from Codex hooks.json. */
export function uninstallCodexHooks({ hooksPath = codexHooksPath() } = {}) {
  if (!fs.existsSync(hooksPath)) return { ok: true, hooksPath };
  let config;
  try {
    config = readJsonObject(hooksPath);
  } catch (error) {
    return {
      ok: false,
      reason: "codex_hooks_unreadable",
      hooksPath,
      detail: error && error.message ? error.message : String(error),
    };
  }
  const hooks = config.hooks;
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) return { ok: true, hooksPath };
  let changed = false;
  for (const event of Object.keys(hooks)) {
    if (!Array.isArray(hooks[event])) continue;
    const before = hooks[event];
    const after = withoutRelayCodexHooks(before);
    if (after.length === before.length && after.every((entry, index) => entry === before[index])) continue;
    changed = true;
    if (after.length) hooks[event] = after;
    else delete hooks[event];
  }
  if (!changed) return { ok: true, hooksPath };
  if (Object.keys(hooks).length === 0) delete config.hooks;
  try {
    writeJsonAtomic(hooksPath, config);
    return { ok: true, hooksPath, removed: true };
  } catch (error) {
    return {
      ok: false,
      reason: "codex_hooks_write_failed",
      hooksPath,
      detail: error && error.message ? error.message : String(error),
    };
  }
}

export function hookInstallNotices({ claudeHooks = null, codexHooks = null } = {}) {
  const notices = [];
  for (const [host, result] of [["Claude Code", claudeHooks], ["Codex", codexHooks]]) {
    if (!result || result.ok) continue;
    const detail = [result.reason, result.detail].filter(Boolean).join(": ");
    notices.push(`Could not install Relay hooks for ${host}${detail ? ` (${detail})` : ""}.`);
  }
  if (codexHooks?.ok && codexHooks.requiresTrustReview) {
    notices.push("Codex requires one final step: open `/hooks` in Codex and trust the Relay hook.");
  }
  return notices;
}

function tomlQuote(value) {
  return JSON.stringify(String(value));
}

export const RELAY_CODEX_DIRECT_NAMESPACE = "mcp__relay";

function tomlTableBounds(text, tableName) {
  const lines = String(text || "").split(/\r?\n/);
  const header = `[${tableName}]`;
  const startLine = lines.findIndex((line) => line.trim() === header);
  if (startLine === -1) return null;

  let endLine = startLine + 1;
  while (endLine < lines.length && !/^\s*\[[^\]]+\]\s*$/.test(lines[endLine])) endLine += 1;
  return {
    before: lines.slice(0, startLine).join("\n"),
    table: lines.slice(startLine, endLine).join("\n"),
    after: lines.slice(endLine).join("\n"),
  };
}

function parseTomlStringArray(value) {
  const source = String(value || "");
  let index = 0;
  while (/\s/.test(source[index] || "")) index += 1;
  if (source[index] !== "[") throw new Error("expected a TOML string array");
  index += 1;

  const values = [];
  while (index < source.length) {
    while (index < source.length) {
      while (/\s|,/.test(source[index] || "")) index += 1;
      if (source[index] !== "#") break;
      while (index < source.length && source[index] !== "\n") index += 1;
    }
    if (source[index] === "]") return { values, consumed: index + 1 };
    const quote = source[index];
    if (quote !== '"' && quote !== "'") throw new Error("expected quoted TOML array values");

    const start = index;
    index += 1;
    let escaped = false;
    while (index < source.length) {
      const char = source[index];
      if (quote === '"' && char === "\\" && !escaped) {
        escaped = true;
        index += 1;
        continue;
      }
      if (char === quote && !escaped) break;
      escaped = false;
      index += 1;
    }
    if (source[index] !== quote) throw new Error("unterminated TOML string array value");
    const token = source.slice(start, index + 1);
    values.push(quote === '"' ? JSON.parse(token) : token.slice(1, -1));
    index += 1;
  }
  throw new Error("unterminated TOML string array");
}

function formatTomlStringArray(values) {
  return `[${values.map(tomlQuote).join(", ")}]`;
}

/** Add or remove one string in a TOML array without rewriting unrelated user config. */
export function updateTomlStringArray(text, tableName, key, value, { remove = false } = {}) {
  const source = String(text || "");
  const bounds = tomlTableBounds(source, tableName);
  if (!bounds) {
    if (remove) return source;
    const prefix = source.trimEnd();
    const table = `[${tableName}]\n${key} = ${formatTomlStringArray([value])}`;
    return `${prefix}${prefix ? "\n\n" : ""}${table}\n`;
  }

  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const assignment = new RegExp(`^(\\s*)${escapedKey}\\s*=`, "m").exec(bounds.table);
  if (!assignment) {
    if (remove) return source;
    const table = `${bounds.table.trimEnd()}\n${key} = ${formatTomlStringArray([value])}`;
    return [bounds.before, table, bounds.after].filter(Boolean).join("\n").replace(/\n*$/, "\n");
  }

  const valueStart = assignment.index + assignment[0].length;
  const parsed = parseTomlStringArray(bounds.table.slice(valueStart));
  const current = [...new Set(parsed.values.map(String))];
  const next = remove
    ? current.filter((candidate) => candidate !== value)
    : current.includes(value) ? current : [...current, value];
  const valueEnd = valueStart + parsed.consumed;
  let table;
  if (remove && next.length === 0) {
    const lineStart = bounds.table.lastIndexOf("\n", assignment.index - 1) + 1;
    const followingNewline = bounds.table.indexOf("\n", valueEnd);
    const lineEnd = followingNewline === -1 ? bounds.table.length : followingNewline + 1;
    table = `${bounds.table.slice(0, lineStart)}${bounds.table.slice(lineEnd)}`.trimEnd();
  } else {
    table = `${bounds.table.slice(0, valueStart)} ${formatTomlStringArray(next)}${bounds.table.slice(valueEnd)}`;
  }
  return [bounds.before, table, bounds.after].filter(Boolean).join("\n").replace(/\n*$/, "\n");
}

export function codexRelayMcpTomlSection(
  bin = relayBinPath(),
  node = stableNodePath(),
) {
  return [
    "[mcp_servers.relay]",
    `command = ${tomlQuote(node)}`,
    // Heap cap: one stdio server spawns per agent session, so an uncapped V8
    // heap multiplies across every open session on busy machines.
    `args = [${["--max-old-space-size=96", bin, "mcp"].map(tomlQuote).join(", ")}]`,
    "startup_timeout_sec = 30",
    "tool_timeout_sec = 300",
    "",
  ].join("\n");
}

export function replaceTomlTable(text, tableName, replacement) {
  const header = `[${tableName}]`;
  const lines = String(text || "").split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === header);
  const cleanReplacement = String(replacement || "").trimEnd();
  if (start === -1) {
    const prefix = String(text || "").trimEnd();
    return `${prefix}${prefix ? "\n\n" : ""}${cleanReplacement}\n`;
  }

  let end = start + 1;
  while (end < lines.length && !/^\s*\[[^\]]+\]\s*$/.test(lines[end])) end += 1;
  const before = lines.slice(0, start).join("\n").trimEnd();
  const after = lines.slice(end).join("\n").trimStart();
  return `${before ? `${before}\n\n` : ""}${cleanReplacement}${after ? `\n\n${after}` : ""}\n`;
}

export function removeTomlTable(text, tableName) {
  const header = `[${tableName}]`;
  const lines = String(text || "").split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === header);
  if (start === -1) return String(text || "");

  let end = start + 1;
  while (end < lines.length && !/^\s*\[[^\]]+\]\s*$/.test(lines[end])) end += 1;
  const before = lines.slice(0, start).join("\n").trimEnd();
  const after = lines.slice(end).join("\n").trimStart();
  return `${before}${before && after ? "\n\n" : ""}${after}${before || after ? "\n" : ""}`;
}

export function writeCodexMcpConfig(
  bin = relayBinPath(),
  node = stableNodePath(),
  configPath = codexConfigPath(),
) {
  const configDir = path.dirname(configPath);
  if (!fs.existsSync(configPath) && !fs.existsSync(configDir)) {
    // The Codex desktop experience ships inside the ChatGPT app and reads this
    // same file, but ~/.codex only appears once Codex has actually been run. A
    // freshly-installed ChatGPT app is a real host, so create the directory
    // rather than reporting "codex not found" to someone who has it open.
    if (!codexAppPresent()) return { ok: false, reason: "codex_config_missing", configPath };
    try {
      fs.mkdirSync(configDir, { recursive: true });
    } catch (error) {
      return {
        ok: false,
        reason: "codex_config_write_failed",
        configPath,
        detail: error && error.message ? error.message : String(error),
      };
    }
  }
  try {
    const existing = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : "";
    const withDirectRelay = updateTomlStringArray(
      existing,
      "features.code_mode",
      "direct_only_tool_namespaces",
      RELAY_CODEX_DIRECT_NAMESPACE,
    );
    writeTextAtomic(
      configPath,
      replaceTomlTable(withDirectRelay, "mcp_servers.relay", codexRelayMcpTomlSection(bin, node)),
    );
    return { ok: true, method: "config", configPath };
  } catch (error) {
    return {
      ok: false,
      reason: "codex_config_write_failed",
      configPath,
      detail: error && error.message ? error.message : String(error),
    };
  }
}

export function removeCodexMcpConfig(configPath = codexConfigPath()) {
  if (!fs.existsSync(configPath)) return { ok: true, configPath };
  try {
    const withoutRelayServer = removeTomlTable(fs.readFileSync(configPath, "utf8"), "mcp_servers.relay");
    writeTextAtomic(
      configPath,
      updateTomlStringArray(
        withoutRelayServer,
        "features.code_mode",
        "direct_only_tool_namespaces",
        RELAY_CODEX_DIRECT_NAMESPACE,
        { remove: true },
      ),
    );
    return { ok: true, configPath };
  } catch (error) {
    return {
      ok: false,
      reason: "codex_config_write_failed",
      configPath,
      detail: error && error.message ? error.message : String(error),
    };
  }
}

function electronPathForPackageRoot(packageRoot) {
  try {
    const require = createRequire(path.join(packageRoot, "package.json"));
    const electronPath = require("electron");
    return typeof electronPath === "string" && electronPath ? electronPath : null;
  } catch {
    return null;
  }
}

function electronPackageRootForPackageRoot(packageRoot) {
  try {
    const require = createRequire(path.join(packageRoot, "package.json"));
    // Resolve without executing Electron's index.js. When npm skipped Electron's
    // download, requiring the module throws because path.txt is absent, but its
    // install.js is still available. This also follows npm's hoisted sibling layout.
    return path.dirname(require.resolve("electron"));
  } catch {
    return null;
  }
}

export function ensureElectronRuntime(packageRoot, { runCommand = run } = {}) {
  let electronPath = electronPathForPackageRoot(packageRoot);
  if (electronPath && fs.existsSync(electronPath)) return { ok: true, electronPath, repaired: false };

  const electronPackageRoot = electronPackageRootForPackageRoot(packageRoot);
  const installScript = electronPackageRoot ? path.join(electronPackageRoot, "install.js") : null;
  if (!installScript || !fs.existsSync(installScript)) {
    return { ok: false, reason: "electron_install_script_missing", electronPath, installScript };
  }

  const res = runCommand(process.execPath, [installScript], { timeoutMs: npmInstallTimeoutMs() });
  electronPath = electronPathForPackageRoot(packageRoot);
  if (res.ok && electronPath && fs.existsSync(electronPath)) {
    return { ok: true, electronPath, repaired: true };
  }

  return {
    ok: false,
    reason: "electron_runtime_missing",
    electronPath,
    installScript,
    detail: res.out,
  };
}

/** Whether an agent CLI is on PATH. */
export function commandExists(cmd) {
  const res = spawnSync(cmd, ["--version"], { encoding: "utf8", timeout: 8000 });
  return !res.error && (res.status === 0 || Boolean((res.stdout || "").trim()));
}

/** Register the Relay MCP into Claude Code at user scope (loads in every session). Idempotent. */
export function installClaudeCode(
  bin = relayBinPath(),
  node = stableNodePath(),
  { command = "claude" } = {},
) {
  let cliResult = null;
  if (commandExists(command)) {
    run(command, ["mcp", "remove", "-s", "user", "relay"]); // ignore if absent
    cliResult = run(command, ["mcp", "add", "-s", "user", "relay", "--", node, "--max-old-space-size=96", bin, "mcp"]);
    if (cliResult.ok || /already exists/i.test(cliResult.out)) {
      return { ok: true, method: "cli" };
    }
  }

  const configResult = writeClaudeCodeMcpConfig(bin, node, claudeCodeConfigPath());
  if (configResult.ok) return configResult;
  if (cliResult) return { ok: false, reason: "registration_failed", detail: cliResult.out, configPath: configResult.configPath };
  return { ok: false, reason: "claude_code_not_found", configPath: configResult.configPath };
}

/** Register the Relay MCP into Codex (loads in every session). Idempotent. */
export function installCodex(
  bin = relayBinPath(),
  node = stableNodePath(),
  { command = "codex" } = {},
) {
  let cliResult = null;
  if (commandExists(command)) {
    run(command, ["mcp", "remove", "relay"]); // ignore if absent
    cliResult = run(command, ["mcp", "add", "relay", "--", node, "--max-old-space-size=96", bin, "mcp"]);
    if (cliResult.ok || /already exists/i.test(cliResult.out)) {
      return { ok: true, method: "cli" };
    }
  }

  const configResult = writeCodexMcpConfig(bin, node, codexConfigPath());
  if (configResult.ok) return configResult;
  if (cliResult) return { ok: false, reason: "registration_failed", detail: cliResult.out, configPath: configResult.configPath };
  return { ok: false, reason: "codex_not_found", configPath: configResult.configPath };
}

/**
 * Refuse to point the machine's autostart at a tree the canonical runtime does
 * not currently own.
 *
 * Registering is a machine-global act: whoever writes the plist decides what
 * launchd restarts from then on, and the daemon cannot survive a registration
 * that disagrees with the pointer. The guard itself is not new — it existed and
 * was wired only into `postinstall`, which is precisely why `install`,
 * `repair-desktop` and the startup migration could each still re-pin the whole
 * machine on their own. Guarding the two WRITERS instead of their callers
 * covers every present caller and every future one.
 *
 * Returns a refusal result, or null to proceed. Anything unreadable proceeds:
 * a first install has no pointer yet, and during activation the pointer reads
 * as null by design, so neither may be blocked.
 */
function autostartClaimRefusal(bin, { claim, homeDir, platform, ownershipGuard }) {
  if (claim) return null;
  let guard = null;
  try {
    guard = ownershipGuard(packageRootForBin(bin, platform), { homeDir, platform });
  } catch {
    return null;
  }
  if (!guard || guard.mayClaim) return null;
  const wouldRegister = packageRootForBin(bin, platform);
  const current = guard.current?.packageRoot ?? null;
  return {
    ok: false,
    reason: "not-canonical-runtime",
    guard: guard.reason,
    wouldRegister,
    current,
    message:
      `refusing to point this machine's autostart at ${wouldRegister}` +
      (current ? `, because the canonical runtime is ${current}` : "") +
      ". Registering a non-current tree strands the daemon in a restart loop it cannot detect. " +
      "Re-run with --claim if this tree really should own the machine.",
  };
}

/** Install + load a launchd agent that keeps `relay daemon` running (macOS). Idempotent. */
export function installDaemonAutostart(
  bin = relayBinPath(),
  node = stableNodePath(),
  {
    platform = process.platform,
    runCommand = run,
    reload = true,
    homeDir = os.homedir(),
    ensureLauncher = ensureWindowsHiddenLauncher,
    claim = false,
    ownershipGuard = canonicalOwnershipGuard,
  } = {},
) {
  const refusal = autostartClaimRefusal(bin, { claim, homeDir, platform, ownershipGuard });
  if (refusal) return refusal;
  // The daemon runs 24/7 and only polls, so cap its V8 heap — this is the
  // heaviest always-on Relay process, and an uncapped heap lets a transient
  // large response set a high-water mark it then holds for the machine's uptime.
  const daemonArgs = ["--max-old-space-size=128", bin, "daemon"];
  if (platform === "win32") {
    const logPath = path.join(homeDir, ".relay", "daemon.log");
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const res = installWindowsLogonTask({
      taskName: WINDOWS_DAEMON_TASK_NAME,
      executable: node,
      args: daemonArgs,
      logPath,
      runCommand,
      homeDir,
      ensureLauncher,
      reload,
    });
    return { ...res, logPath };
  }
  if (platform === "linux") {
    return installLinuxDaemonAutostart({ bin, node, runCommand, reload, homeDir });
  }
  if (platform !== "darwin") return { ok: false, reason: "autostart_unsupported_platform" };
  const home = homeDir;
  const plistPath = path.join(home, "Library", "LaunchAgents", `${DAEMON_LAUNCH_LABEL}.plist`);
  const logPath = path.join(home, ".relay", "daemon.log");
  fs.mkdirSync(path.dirname(plistPath), { recursive: true });
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const pathEnv = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin";
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${DAEMON_LAUNCH_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${plistEscape(node)}</string>
${daemonArgs.map((argument) => `    <string>${plistEscape(argument)}</string>`).join("\n")}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${plistEscape(logPath)}</string>
  <key>StandardErrorPath</key><string>${plistEscape(logPath)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${plistEscape(pathEnv)}</string>
  </dict>
</dict>
</plist>
`;
  fs.writeFileSync(plistPath, plist);
  if (!reload) return { ok: true, plistPath, logPath, started: false };
  runCommand("launchctl", ["unload", plistPath]); // ignore if not loaded
  const res = runCommand("launchctl", ["load", plistPath]);
  return { ok: res.ok, plistPath, logPath, started: res.ok };
}

/** Install + load a launchd agent that starts the visible Relay pill (macOS). */
export function installPillAutostart(
  bin = relayBinPath(),
  {
    platform = process.platform,
    runCommand = run,
    reload = true,
    homeDir = os.homedir(),
    node = stableNodePath(),
    ensureLauncher = ensureWindowsHiddenLauncher,
    claim = false,
    ownershipGuard = canonicalOwnershipGuard,
  } = {},
) {
  if (!["darwin", "win32", "linux"].includes(platform)) return { ok: false, reason: "autostart_unsupported_platform" };
  const refusal = autostartClaimRefusal(bin, { claim, homeDir, platform, ownershipGuard });
  if (refusal) return refusal;
  const packageRoot = packageRootForBin(bin, platform);
  const electron = ensureElectronRuntime(packageRoot, { runCommand });
  const electronPath = electron.electronPath;
  const overlayMain = path.join(packageRoot, "overlay", "main.cjs");
  const pillArgs = [overlayMain];
  if (!electron.ok || !electronPath || !fs.existsSync(overlayMain)) {
    return { ok: false, reason: "pill_runtime_missing", electronPath, overlayMain, electron };
  }
  if (platform === "linux") {
    return installLinuxPillAutostart({
      bin,
      node,
      electronPath,
      overlayMain,
      runCommand,
      reload,
      homeDir,
    });
  }
  if (platform === "win32") {
    const logPath = path.join(homeDir, ".relay", "pill.log");
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const res = installWindowsLogonTask({
      taskName: WINDOWS_PILL_TASK_NAME,
      executable: electronPath,
      args: pillArgs,
      logPath,
      runCommand,
      homeDir,
      ensureLauncher,
      reload,
    });
    // The Start Menu entry is the Windows counterpart to macOS's Relay.app, and it
    // is installed from the same place so the two platforms can never drift. Unlike
    // macOS it does NOT gate `ok`: autostart is what keeps Relay running, a shortcut
    // only makes it launchable, and failing the former for the latter would be a
    // worse machine than one with no Start Menu entry.
    const shortcut = installWindowsStartMenuShortcut({ bin, platform, homeDir, runCommand, ensureLauncher });
    return { ...res, electronPath, overlayMain, logPath, shortcut };
  }

  const home = homeDir;
  const plistPath = path.join(home, "Library", "LaunchAgents", `${PILL_LAUNCH_LABEL}.plist`);
  const logPath = path.join(home, ".relay", "pill.log");
  fs.mkdirSync(path.dirname(plistPath), { recursive: true });
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const relayApp = installRelayMacApp({ bin, electronPath, overlayMain, homeDir, runCommand });
  if (!relayApp.ok) return { ...relayApp, electronPath, overlayMain, logPath };
  const pathEnv = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin";
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${PILL_LAUNCH_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${plistEscape(electronPath)}</string>
${pillArgs.map((argument) => `    <string>${plistEscape(argument)}</string>`).join("\n")}
  </array>
  <key>RunAtLoad</key><true/>
  <!-- Restart a crashed pill, but not a clean second instance that exits after
       losing Electron's single-instance lock. KeepAlive=true turns that normal
       exit into an endless launch/reopen/sound loop whenever a standalone owner
       wins the startup race. RunAtLoad still starts the pill at login. -->
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key><false/>
  </dict>
  <!-- The pill draws a window the user clicks, so it must be scheduled like an
       app, not like batch work. Without ProcessType, launchd treats an agent as
       ordinary background work: under load macOS starves it, and the field
       symptom is a visible pill whose clicks and animation freeze for seconds
       while it burns no CPU and runs no JavaScript. Interactive opts out of that
       throttling; LowPriorityIO off keeps its disk reads from being deferred. -->
  <key>ProcessType</key><string>Interactive</string>
  <key>LowPriorityIO</key><false/>
  <key>StandardOutPath</key><string>${plistEscape(logPath)}</string>
  <key>StandardErrorPath</key><string>${plistEscape(logPath)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${plistEscape(pathEnv)}</string>
  </dict>
</dict>
</plist>
`;
  fs.writeFileSync(plistPath, plist);
  if (!reload) {
    return {
      ok: true,
      plistPath,
      logPath,
      electronPath,
      overlayMain,
      appPath: relayApp.appPath,
      started: false,
    };
  }
  runCommand("launchctl", ["unload", plistPath]); // ignore if not loaded
  const res = runCommand("launchctl", ["load", plistPath]);
  return {
    ok: res.ok,
    plistPath,
    logPath,
    electronPath,
    overlayMain,
    appPath: relayApp.appPath,
    started: res.ok,
  };
}

function quoteWindowsCmdArg(value) {
  return `"${String(value).replaceAll('"', '\\"')}"`;
}

export function windowsTaskAction(executable, args = [], logPath = null, comspec = process.env.ComSpec || "cmd.exe") {
  const command = [quoteWindowsCmdArg(executable), ...args.map(quoteWindowsCmdArg)].join(" ");
  const redirect = logPath ? ` >> ${quoteWindowsCmdArg(logPath)} 2>&1` : "";
  return `${quoteWindowsCmdArg(comspec)} /d /s /c "${command}${redirect}"`;
}

/**
 * A GUI-subsystem shim that starts the real (console) task action hidden.
 *
 * Task Scheduler launches an `<Exec>` action with the default SW_SHOWNORMAL, so a
 * console `Command` — cmd.exe, and therefore node.exe and electron.exe under it —
 * gets a console window that stays on screen for the life of the service. On
 * Windows 11 the default-terminal handoff turns that into a blank Windows Terminal
 * window, and every updater restart of the two tasks pops a fresh pair (measured on
 * Windows 11 26200: a cmd.exe action produced a visible `C:\\Windows\\system32\\cmd.exe`
 * terminal window every run; this shim produced none, with the child confirmed running).
 *
 * The task's `<Hidden>` setting does NOT do this — it only hides the task from the
 * Task Scheduler UI. `powershell -WindowStyle Hidden` does not do it either: it is
 * applied after the window exists and the Terminal handoff ignores it.
 *
 * wscript.exe is a GUI subsystem binary, so Task Scheduler allocates it no console
 * at all, and WshShell.Run's `0` window style creates the child with SW_HIDE.
 *
 * The command is BAKED INTO the script, not passed as an argument. Handing it to the
 * task's `<Arguments>` puts Task Scheduler, CommandLineToArgvW and cmd all in charge
 * of the same quotes: measured, that three-deep nesting registered and parsed clean
 * but never started the service. A VBScript string literal has exactly one escaping
 * rule (a doubled quote), and the file is UTF-16, so no console codepage can corrupt
 * a non-ASCII install path (C:\Users\José) the way a .cmd or .bat would.
 */
export function windowsHiddenLauncherVbs(commandLine) {
  // VBScript literal: "" is one quote. Nothing else needs escaping here.
  const literal = `"${String(commandLine).replaceAll('"', '""')}"`;
  return [
    "' Relay Companion: starts a service with no console window.",
    "' Written by 'relay install' / 'relay repair-desktop'; safe to delete (it is recreated).",
    "Option Explicit",
    "Dim shell",
    'Set shell = CreateObject("WScript.Shell")',
    `shell.Run ${literal}, 0, False`,
    "",
  ].join("\r\n");
}

/** Stable per-task shim, e.g. `~/.relay/relay-companion-daemon.vbs`. */
export function windowsHiddenLauncherPath(homeDir = os.homedir(), taskName = "Relay Service") {
  const slug = String(taskName).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "relay-service";
  return path.join(homeDir, ".relay", `${slug}.vbs`);
}

/**
 * Write the shim and confirm the pieces it needs are actually there. Returns null
 * when anything is missing — hardened boxes disable Windows Script Host entirely —
 * and the caller then registers the plain console action: a visible window is
 * annoying, a service that never starts is not.
 */
export function ensureWindowsHiddenLauncher({
  homeDir = os.homedir(),
  taskName = "Relay Service",
  commandLine = "",
  systemRoot = process.env.SystemRoot || process.env.windir || "C:\\Windows",
  runCommand = run,
  writeFile = fs.writeFileSync,
  makeDir = fs.mkdirSync,
  exists = fs.existsSync,
} = {}) {
  const wscript = path.win32.join(systemRoot, "System32", "wscript.exe");
  if (!exists(wscript)) return null;
  // Policy can turn WSH off machine- or user-wide; an absent value means enabled.
  for (const hive of ["HKLM", "HKCU"]) {
    const query = runCommand("reg", ["query", `${hive}\\Software\\Microsoft\\Windows Script Host\\Settings`, "/v", "Enabled"]);
    if (query.ok && /\bEnabled\b\s+REG_DWORD\s+0x0\b/i.test(query.out)) return null;
  }
  const vbsPath = windowsHiddenLauncherPath(homeDir, taskName);
  try {
    makeDir(path.dirname(vbsPath), { recursive: true });
    // UTF-16 with a BOM. The script host reads a BOM-less .vbs as the ANSI codepage,
    // which mangles any non-ASCII character in an install path; the BOM removes the
    // guess. Same reason the updater writes its .ps1 this way.
    writeFile(vbsPath, `\ufeff${windowsHiddenLauncherVbs(commandLine)}`, "utf16le");
  } catch {
    return null;
  }
  return { wscript, vbsPath };
}

/** Task `<Arguments>` that run the shim. //B keeps a script error from popping a dialog. */
export function windowsHiddenLauncherArgs(vbsPath) {
  return `//B //Nologo ${quoteWindowsCmdArg(vbsPath)}`;
}

/**
 * Relay as a thing you can LAUNCH on Windows.
 *
 * macOS gets ~/Applications/Relay.app (installRelayMacApp), so Spotlight → "Relay"
 * reopens the pill. Windows had no equivalent at all: `skipTaskbar: true` means no
 * taskbar button and no Alt-Tab entry, the tray is created without a GUID so
 * Windows 11 parks the icon in the overflow chevron, and Start → "relay" found
 * nothing. The only way back was a terminal (field report, Shane 2026-08-17).
 *
 * A per-user .lnk in the Start Menu's Programs folder is the whole fix: Start
 * search indexes that folder by shortcut name, and writing there needs no admin
 * rights and no installer.
 */
const RELAY_WINDOWS_SHORTCUT_NAME = "Relay.lnk";
const RELAY_WINDOWS_LAUNCHER_TASK = "Relay Pill Launcher";
const RELAY_WINDOWS_ICON_NAME = "relay.ico";

export function windowsStartMenuDir(env = process.env, homeDir = os.homedir()) {
  const appData = env.APPDATA || path.join(homeDir, "AppData", "Roaming");
  return path.join(appData, "Microsoft", "Windows", "Start Menu", "Programs");
}

export function windowsStartMenuShortcutPath(env = process.env, homeDir = os.homedir()) {
  return path.join(windowsStartMenuDir(env, homeDir), RELAY_WINDOWS_SHORTCUT_NAME);
}

// PowerShell literal: '' is one quote. Nothing else is interpreted inside a
// single-quoted string, so a username containing $, ` or " cannot break the script.
function powerShellSingleQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

/**
 * Build the PowerShell that writes the shell link. Node cannot author a .lnk
 * natively; WScript.Shell's CreateShortcut is the one dependency-free way, and the
 * repo already shells out to reg/schtasks/powershell elsewhere.
 *
 * It writes to `stagingPath` so a failure never leaves a half-written shortcut in
 * the user's Start Menu; the caller renames it into place.
 */
export function windowsShortcutScript({ stagingPath, target, args, iconPath = "", description = "" }) {
  return [
    "$ErrorActionPreference='Stop'",
    `$s=(New-Object -ComObject WScript.Shell).CreateShortcut(${powerShellSingleQuote(stagingPath)})`,
    `$s.TargetPath=${powerShellSingleQuote(target)}`,
    `$s.Arguments=${powerShellSingleQuote(args)}`,
    ...(description ? [`$s.Description=${powerShellSingleQuote(description)}`] : []),
    ...(iconPath ? [`$s.IconLocation=${powerShellSingleQuote(iconPath)}`] : []),
    "$s.Save()",
  ].join("; ");
}

export function installWindowsStartMenuShortcut({
  bin = relayBinPath(),
  node = stableNodePath(),
  platform = process.platform,
  homeDir = os.homedir(),
  env = process.env,
  runCommand = run,
  ensureLauncher = ensureWindowsHiddenLauncher,
  exists = fs.existsSync,
  makeDir = fs.mkdirSync,
  rename = fs.renameSync,
  remove = fs.rmSync,
} = {}) {
  if (platform !== "win32") return { ok: false, reason: "unsupported_platform" };
  const lnkPath = windowsStartMenuShortcutPath(env, homeDir);
  const stagingPath = `${lnkPath}.${process.pid}.tmp.lnk`;
  const packageRoot = packageRootForBin(bin);
  const iconPath = path.join(packageRoot, "overlay", RELAY_WINDOWS_ICON_NAME);

  // `relay pill` already resolves Electron, spawns it with a --relay-reopen nonce and
  // waits for the single-instance owner to confirm the card is on screen. That is the
  // same contract the macOS applet's launcher script implements, so an ALREADY-RUNNING
  // pill is raised rather than duplicated. Reusing the CLI keeps one open path.
  const commandLine = `${quoteWindowsCmdArg(node)} ${quoteWindowsCmdArg(bin)} pill`;
  const launcher = ensureLauncher({ homeDir, taskName: RELAY_WINDOWS_LAUNCHER_TASK, commandLine, runCommand });
  // Windows Script Host can be disabled by policy, in which case ensureLauncher
  // returns null. Target node directly and accept a console flash: a Start Menu
  // entry that blinks beats one that does not exist — the same trade-off
  // installWindowsLogonTask already makes for the background services.
  const target = launcher ? launcher.wscript : node;
  const args = launcher ? windowsHiddenLauncherArgs(launcher.vbsPath) : `${quoteWindowsCmdArg(bin)} pill`;

  try {
    makeDir(path.dirname(lnkPath), { recursive: true });
  } catch (error) {
    return { ok: false, reason: "start_menu_unwritable", detail: error?.message || String(error), lnkPath };
  }
  const script = windowsShortcutScript({
    stagingPath,
    target,
    args,
    iconPath: exists(iconPath) ? iconPath : "",
    description: "Show the Relay pill",
  });
  const res = runCommand("powershell", ["-NoProfile", "-NonInteractive", "-Command", script]);
  if (!res.ok) {
    try {
      remove(stagingPath, { force: true });
    } catch {}
    return { ok: false, reason: res.missing ? "powershell_missing" : "shortcut_write_failed", detail: res.out, lnkPath };
  }
  try {
    rename(stagingPath, lnkPath);
  } catch (error) {
    try {
      remove(stagingPath, { force: true });
    } catch {}
    return { ok: false, reason: "shortcut_publish_failed", detail: error?.message || String(error), lnkPath };
  }
  return { ok: true, lnkPath, target, args, hidden: Boolean(launcher) };
}

/** True when win32 has no Start Menu entry — drives `relay doctor` and the repair path. */
export function windowsStartMenuShortcutMissing({
  platform = process.platform,
  env = process.env,
  homeDir = os.homedir(),
  exists = fs.existsSync,
} = {}) {
  if (platform !== "win32") return false;
  return !exists(windowsStartMenuShortcutPath(env, homeDir));
}

function windowsTaskXmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/**
 * Build a Scheduled Task definition without putting the executable action in
 * schtasks.exe's `/TR` argument. `/TR` has both a small length ceiling and its
 * own quote parser; Relay's Electron path crosses both boundaries on normal
 * Windows installs. XML keeps the command and arguments as data instead.
 */
export function windowsTaskXml(
  executable,
  args = [],
  logPath = null,
  comspec = process.env.ComSpec || "cmd.exe",
  userId = process.env.USERNAME
    ? `${process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\` : ""}${process.env.USERNAME}`
    : "",
  launcher = null,
) {
  const command = [quoteWindowsCmdArg(executable), ...args.map(quoteWindowsCmdArg)].join(" ");
  const redirect = logPath ? ` >> ${quoteWindowsCmdArg(logPath)} 2>&1` : "";
  // With the shim, the action is a windowless wscript that starts this same command
  // hidden. Without it, cmd runs as the action directly and Windows shows its console
  // for as long as the service lives.
  const taskCommand = launcher ? launcher.wscript : comspec;
  const commandArgs = launcher ? windowsHiddenLauncherArgs(launcher.vbsPath) : `/d /s /c "${command}${redirect}"`;
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers>
    <LogonTrigger><Enabled>true</Enabled>${userId ? `<UserId>${windowsTaskXmlEscape(userId)}</UserId>` : ""}</LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="RelayUser">
      ${userId ? `<UserId>${windowsTaskXmlEscape(userId)}</UserId>` : ""}
      ${userId ? "<LogonType>InteractiveToken</LogonType>" : ""}
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
  </Settings>
  <Actions Context="RelayUser">
    <Exec>
      <Command>${windowsTaskXmlEscape(taskCommand)}</Command>
      <Arguments>${windowsTaskXmlEscape(commandArgs)}</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

function installWindowsLogonTask({
  taskName,
  executable,
  args = [],
  logPath = null,
  runCommand = run,
  homeDir = os.homedir(),
  ensureLauncher = ensureWindowsHiddenLauncher,
  reload = true,
}) {
  const action = windowsTaskAction(executable, args, logPath);
  // Null when Windows Script Host is unavailable: the task still registers, it just
  // shows its console window the way it did before.
  const launcher = ensureLauncher({ homeDir, taskName, commandLine: action });
  const xml = windowsTaskXml(executable, args, logPath, process.env.ComSpec || "cmd.exe", undefined, launcher);
  const xmlPath = path.join(os.tmpdir(), `relay-task-${process.pid}-${Math.random().toString(16).slice(2)}.xml`);
  // schtasks reads task XML as UTF-16 on every supported Windows version. The
  // BOM matters on Windows PowerShell 5-era systems.
  fs.writeFileSync(xmlPath, `\uFEFF${xml}`, "utf16le");
  if (reload) runCommand("schtasks", ["/End", "/TN", taskName]); // ignore if absent or not running
  let create;
  try {
    create = runCommand("schtasks", ["/Create", "/TN", taskName, "/XML", xmlPath, "/F"]);
  } finally {
    try {
      fs.unlinkSync(xmlPath);
    } catch {}
  }
  if (!create.ok) {
    return { ok: false, reason: "scheduled_task_create_failed", taskName, action, detail: create.out };
  }
  if (!reload) {
    return { ok: true, taskName, action, hidden: Boolean(launcher), started: false };
  }
  const start = runCommand("schtasks", ["/Run", "/TN", taskName]);
  return {
    ok: true,
    taskName,
    action,
    hidden: Boolean(launcher),
    started: start.ok,
    startDetail: start.ok ? "" : start.out,
  };
}

/**
 * Detect Claude Code + Codex, register the Relay MCP into each present, and
 * start the receive daemon. Returns a summary for the CLI to print.
 */
export async function runSetupInstall({ claim = false, reload = true } = {}) {
  const { bin, stable: binStable, version } = resolveStableBin();
  const packageRoot = packageRootForBin(bin);
  // First contact deliberately installs with --ignore-scripts. Prepare and verify
  // the complete desktop runtime here, before any MCP registration, daemon, task,
  // shortcut, or launch agent is allowed to point at it.
  const electron = ensureElectronRuntime(packageRoot);
  if (!electron.ok) {
    throw new Error(`Relay runtime preparation failed (${electron.reason || "electron unavailable"}).`);
  }
  const verified = verifyCanonicalCandidate(packageRoot, version);
  if (!verified.ok) {
    throw new Error(`Relay refused to activate an unverified runtime (${verified.reason}${verified.detail ? `: ${verified.detail}` : ""}).`);
  }
  const platformPreflight = linuxDesktopPreflight();
  if (!platformPreflight.ok) {
    throw new Error(`Relay cannot install on this Linux session (${platformPreflight.reason}): ${platformPreflight.detail}`);
  }
  // Only after the complete target site is verified may setup touch host state.
  // This migration preserves account values while removing retired capability
  // switches; putting it here also keeps malformed native helpers from changing
  // config, MCP registrations, launchers, or services before setup fails closed.
  writeConfig({});
  // Bake the upgrade-surviving node path into the MCP registrations too, not just the
  // daemon plist — otherwise a `brew upgrade node` / `nvm uninstall` deletes the
  // version-managed node the Claude/Codex MCP `command` points at, and the agents can
  // no longer spawn the Relay MCP server.
  const node = stableNodePath();
  const mcpBin = ensureStableMcpLauncher({ targetBin: bin, node });
  const installed = [];
  const missing = [];
  const activations = [];
  // Desktop apps read their config at process start, so a fresh registration is
  // inert until the user fully quits and reopens them. Collected here so the CLI
  // can say which ones, by name, instead of implying setup failed.
  const desktopRestarts = [];
  const sweptStaleEntries = [];
  const claude = installClaudeCode(mcpBin, node);
  let claudeHooks = null;
  if (claude.ok) {
    installed.push("Claude Code");
    activations.push(verifyClaudeMcpRegistration({ configPath: claude.configPath }));
  } else if (claude.reason === "claude_code_not_found") {
    missing.push("Claude Code");
  } else {
    missing.push("Claude Code (registration failed)");
  }

  // Claude DESKTOP is a separate product with its own config file, and it is what
  // most people who get sent a relay actually have. Registering it is independent
  // of the CLI: a desktop-only machine used to report "Claude Code was not found
  // here, so it was skipped" and register nothing anywhere.
  const claudeDesktop = process.platform === "linux"
    ? { ok: false, reason: "unsupported_platform" }
    : installClaudeDesktop(mcpBin, node);
  if (process.platform !== "linux") {
    if (claudeDesktop.ok) {
      installed.push("Claude Desktop");
      desktopRestarts.push("Claude Desktop");
      if (claudeDesktop.swept?.length) sweptStaleEntries.push(...claudeDesktop.swept);
    } else if (claudeDesktop.reason === "claude_desktop_not_found") {
      missing.push("Claude Desktop");
    } else {
      missing.push("Claude Desktop (registration failed)");
    }
  }
  // The Open-in-current-chat hook runtime rides along with the MCP registration
  // (both are what "Relay is installed into Claude" means) — but it must NOT
  // depend on the `claude` CLI being on PATH. On Windows installClaudeCode fails
  // with claude_code_not_found whenever the CLI is absent even though Claude
  // Code/Desktop is installed and the MCP was registered by hand; without this
  // fallback the hook is never written and the pill's "Open in current chat" is a
  // silent no-op on exactly those machines.
  if (claude.ok || claudeAppearsPresent()) {
    claudeHooks = installClaudeHooksWithStableLauncher(bin, node);
  }
  const codex = installCodex(mcpBin, node);
  let codexHooks = null;
  if (codex.ok) {
    installed.push("Codex");
    activations.push(await activateCodexMcp());
    codexHooks = installCodexHooksWithStableLauncher(bin, node);
  } else if (codex.reason === "codex_not_found") {
    missing.push("Codex");
  } else {
    missing.push("Codex (registration failed)");
  }
  const daemon = installDaemonAutostart(bin, node, { claim, reload });
  const pill = installPillAutostart(bin, { claim, reload });
  return {
    installed,
    missing,
    daemon,
    pill,
    activations,
    binStable,
    claudeHooks,
    codexHooks,
    desktopRestarts,
    sweptStaleEntries,
  };
}

/**
 * Refresh agent MCP registrations and Relay-owned hooks after an auto-update.
 * The daemon calls this from the newly installed tree, so future host sessions
 * point at the current launcher and existing fleets receive new hook events
 * without having to rerun setup.
 */
export function repairAgentMcpRegistrations({
  bin = relayBinPath(),
  node = stableNodePath(),
  homeDir = os.homedir(),
  claudeConfigFile = process.env.CLAUDE_CODE_CONFIG || path.join(homeDir, ".claude.json"),
  codexConfigFile = process.env.CODEX_CONFIG || path.join(process.env.CODEX_HOME || path.join(homeDir, ".codex"), "config.toml"),
  claudeSettingsFile = process.env.CLAUDE_SETTINGS
    || path.join(process.env.CLAUDE_HOME || path.join(homeDir, ".claude"), "settings.json"),
  codexHooksFile = process.env.CODEX_HOOKS
    || path.join(process.env.CODEX_HOME || path.join(homeDir, ".codex"), "hooks.json"),
} = {}) {
  const mcpBin = ensureStableMcpLauncher({ targetBin: bin, node, homeDir });
  const claude = writeClaudeCodeMcpConfig(mcpBin, node, claudeConfigFile);
  const codex = writeCodexMcpConfig(mcpBin, node, codexConfigFile);
  const claudeDesktop = installClaudeDesktop(mcpBin, node, { env: { ...process.env, HOME: homeDir } });
  // Updates migrate hooks only when Relay already owns a handler in the host
  // config. Do not manufacture settings for agents that are not installed.
  const hookRepair = repairExistingAgentHooks({
    bin,
    node,
    homeDir,
    claudeSettingsFile,
    codexHooksFile,
  });
  const claudeHooks = hookRepair.claudeHooks || null;
  const codexHooks = hookRepair.codexHooks || null;
  return { mcpBin, claude, codex, claudeDesktop, hookRepair, claudeHooks, codexHooks };
}

function claudeConfigHasRelay(configPath) {
  if (!fs.existsSync(configPath)) return false;
  try {
    const config = readJsonObject(configPath);
    return Boolean(config.mcpServers && typeof config.mcpServers === "object" && config.mcpServers.relay);
  } catch (error) {
    // An unrelated malformed Claude config is not ours to block an update over.
    // If it appears to contain Relay, fail closed rather than pretending we
    // refreshed a registration we could not safely parse.
    if (/"relay"\s*:/.test(fs.readFileSync(configPath, "utf8"))) throw error;
    return false;
  }
}

function codexConfigHasRelay(configPath) {
  if (!fs.existsSync(configPath)) return false;
  return String(fs.readFileSync(configPath, "utf8"))
    .split(/\r?\n/)
    .some((line) => line.trim() === "[mcp_servers.relay]");
}

function existingClaudeDesktopRelayConfigs({ homeDir, platform, env }) {
  const configs = [];
  for (const dir of claudeDesktopConfigDirs({ env: { ...env, HOME: homeDir }, platform })) {
    const configPath = claudeDesktopConfigPathIn(dir);
    if (!fs.existsSync(configPath)) continue;
    try {
      const config = readJsonObject(configPath);
      if (config.mcpServers && typeof config.mcpServers === "object" && config.mcpServers.relay) {
        configs.push(configPath);
      }
    } catch (error) {
      const raw = fs.readFileSync(configPath, "utf8");
      if (/"relay"\s*:/.test(raw)) throw error;
    }
  }
  return configs;
}

/**
 * Candidate activation repair: refresh only registrations Relay already owns.
 * Unlike setup/repairAgentMcpRegistrations, this never opts a new host into MCP
 * or creates an absent host config merely because an update landed.
 */
export function repairExistingAgentRegistrations({
  bin = relayBinPath(),
  node = stableNodePath(),
  homeDir = os.homedir(),
  platform = process.platform,
  env = process.env,
  claudeConfigFile = process.env.CLAUDE_CODE_CONFIG || path.join(homeDir, ".claude.json"),
  codexConfigFile = process.env.CODEX_CONFIG || path.join(process.env.CODEX_HOME || path.join(homeDir, ".codex"), "config.toml"),
  claudeSettingsFile = process.env.CLAUDE_SETTINGS
    || path.join(process.env.CLAUDE_HOME || path.join(homeDir, ".claude"), "settings.json"),
  codexHooksFile = process.env.CODEX_HOOKS
    || path.join(process.env.CODEX_HOME || path.join(homeDir, ".codex"), "hooks.json"),
} = {}) {
  let claudeInstalled = false;
  let codexInstalled = false;
  let claudeDesktopConfigs = [];
  try {
    claudeInstalled = claudeConfigHasRelay(claudeConfigFile);
    codexInstalled = codexConfigHasRelay(codexConfigFile);
    claudeDesktopConfigs = existingClaudeDesktopRelayConfigs({ homeDir, platform, env });
  } catch (error) {
    return { ok: false, reason: "agent_config_unreadable", detail: error?.message || String(error) };
  }

  let mcpBin = null;
  let claude = null;
  let codex = null;
  let claudeDesktop = null;
  if (claudeInstalled || codexInstalled || claudeDesktopConfigs.length) {
    try {
      mcpBin = ensureStableMcpLauncher({ targetBin: bin, node, homeDir });
    } catch (error) {
      return { ok: false, reason: "mcp_launcher_write_failed", detail: error?.message || String(error) };
    }
    if (claudeInstalled) {
      claude = writeClaudeCodeMcpConfig(mcpBin, node, claudeConfigFile);
    }
    if (codexInstalled) {
      codex = writeCodexMcpConfig(mcpBin, node, codexConfigFile);
    }
    if (claudeDesktopConfigs.length) {
      const entry = claudeDesktopEntry({
        node: resolveStableNode({ execPath: node }),
        script: mcpBin,
        relayHome: env.RELAY_HOME || undefined,
      });
      const written = [];
      try {
        for (const configPath of claudeDesktopConfigs) {
          const { text } = mergeClaudeDesktopConfig(fs.readFileSync(configPath, "utf8"), entry);
          writeTextAtomic(configPath, text);
          written.push(configPath);
        }
        claudeDesktop = { ok: true, configPaths: written };
      } catch (error) {
        claudeDesktop = { ok: false, reason: "claude_desktop_write_failed", detail: error?.message || String(error) };
      }
    }
  }
  const hookRepair = repairExistingAgentHooks({
    bin,
    node,
    homeDir,
    platform,
    claudeSettingsFile,
    codexHooksFile,
  });
  return {
    ok: Boolean((!claude || claude.ok) && (!codex || codex.ok) && (!claudeDesktop || claudeDesktop.ok) && hookRepair.ok),
    mcpBin,
    claude,
    codex,
    claudeDesktop,
    hookRepair,
  };
}

/**
 * Repair only Relay-owned desktop/background surfaces. This intentionally does not
 * inspect or mutate MCP registration, account state, or the network, so package
 * postinstall and the detached updater can safely call it after replacing the tree.
 */
/**
 * Are both Windows autostart tasks registered under the names Relay actually
 * drives (`WINDOWS_*_TASK_NAME`)?
 *
 * This is the root cause behind a whole class of silently-pinned Windows boxes.
 * Early adopters who set autostart up by hand — before the companion shipped
 * win32 autostart — named their tasks whatever they liked (field report, Shane
 * 2026-08-11: `RelayCompanionDaemon` / `RelayCompanionPill`, no spaces). Relay's
 * restart path drives the spaced names, so every `schtasks /Run` failed and the
 * updater rolled back a perfectly good install, forever. Tasks also go missing
 * for less exotic reasons: cleanup tooling, group policy, an OS migration or
 * reinstall.
 *
 * The updater no longer *depends* on these tasks (it falls back to a direct
 * launch), but a machine with no logon task has no autostart at all, so the
 * daemon repairs them the moment it notices.
 */
function scheduledTaskDefinitelyMissing(result) {
  if (result?.ok) return false;
  const output = String(result?.out || "");
  return /cannot find the file specified|cannot find (?:the )?task|task.+does not exist/i.test(output);
}

export function windowsAutostartTaskStatus({ platform = process.platform, runCommand = run } = {}) {
  if (platform !== "win32") return { missing: [], unavailable: [] };
  const missing = [];
  const unavailable = [];
  for (const taskName of [WINDOWS_DAEMON_TASK_NAME, WINDOWS_PILL_TASK_NAME]) {
    const result = runCommand("schtasks", ["/Query", "/TN", taskName]);
    if (result?.ok) continue;
    if (scheduledTaskDefinitelyMissing(result)) missing.push(taskName);
    else unavailable.push({ taskName, detail: result?.out || result?.error?.message || "query failed" });
  }
  return { missing, unavailable };
}

export function missingWindowsAutostartTasks(options = {}) {
  return windowsAutostartTaskStatus(options).missing;
}

/**
 * Re-register any Windows autostart task that has gone missing. Safe to call on
 * every daemon boot: it queries first and does nothing in the overwhelmingly
 * common case where both tasks are present.
 */
export function ensureWindowsAutostartTasks({
  platform = process.platform,
  runCommand = run,
  homeDir = os.homedir(),
  env = process.env,
  log = () => {},
} = {}) {
  if (platform !== "win32") return { attempted: false, missing: [] };
  let missing = [];
  let shortcutMissing = false;
  try {
    const taskStatus = windowsAutostartTaskStatus({ platform, runCommand });
    if (taskStatus.unavailable.length) {
      return {
        attempted: false,
        missing: [],
        reason: "query-failed",
        detail: taskStatus.unavailable.map((entry) => `${entry.taskName}: ${entry.detail}`).join("; "),
      };
    }
    missing = taskStatus.missing;
    // Auto-update replaces the install tree, and an interrupted update can leave the
    // Start Menu entry behind or stale. Repairing it on the same schedule as the
    // tasks is what keeps Relay launchable across updates.
    shortcutMissing = windowsStartMenuShortcutMissing({ platform, env, homeDir });
  } catch (error) {
    return { attempted: false, missing: [], reason: "query-failed", detail: error?.message || String(error) };
  }
  if (!missing.length && !shortcutMissing) return { attempted: false, missing: [] };
  log(
    `autostart repair: ${[
      missing.length ? `Scheduled Task(s) missing (${missing.join(", ")})` : "",
      shortcutMissing ? "Start Menu shortcut missing" : "",
    ].filter(Boolean).join("; ")}; re-registering`,
  );
  // repairDesktopSurfaces re-registers pill first, daemon last — the same ordering
  // contract the updater uses, and it recreates BOTH tasks idempotently with /F.
  const result = repairDesktopSurfaces({ platform, runCommand, homeDir });
  log(
    result.ok
      ? "autostart repair: Scheduled Tasks re-registered"
      : `autostart repair FAILED (${[
          [result.daemon?.reason, result.daemon?.detail].filter(Boolean).join(": "),
          [result.pill?.reason, result.pill?.detail].filter(Boolean).join(": "),
        ].filter(Boolean).join("; ")}); run \`relay setup\` to fix autostart`,
  );
  return { attempted: true, missing, shortcutMissing, ok: Boolean(result.ok), result };
}

export function repairDesktopSurfaces({
  bin = relayBinPath(),
  node = stableNodePath(),
  platform = process.platform,
  runCommand = run,
  reload = true,
  homeDir = os.homedir(),
  claim = false,
} = {}) {
  const pill = installPillAutostart(bin, { platform, runCommand, reload, homeDir, claim, node });
  // Reload the daemon last. A repair may be invoked by the updater's detached child;
  // replacing the pill first avoids killing the update-owning daemon before all other
  // desktop surfaces are ready.
  const daemon = installDaemonAutostart(bin, node, { platform, runCommand, reload, homeDir, claim });
  return { ok: Boolean(daemon.ok && pill.ok), daemon, pill };
}

/** Remove the Relay MCP from both agents and stop/clear the background daemon. */
/**
 * The PowerShell that finds every Relay service process by command-line
 * identity — the daemon (`relay.js … daemon`) and the pill (`overlay/main.cjs`,
 * whose Electron children die with it) — and terminates them. Exported as a
 * string so tests can pin what it matches without spawning PowerShell.
 *
 * Why this exists at all: the tasks launch through a short-lived
 * wscript/WshShell.Run wrapper, so `schtasks /End` returns SUCCESS having
 * killed the wrapper while the actual node/Electron grandchildren survive.
 * The canonical updater already learned this and sweeps by identity; uninstall
 * inherited only the `/End` and so left the daemon alive — observed on
 * 2026-08-18, where the surviving daemon then re-registered the scheduled
 * tasks, the MCP entries, and the Start Menu shortcut it had just watched
 * uninstall remove. A live daemon actively reverses an uninstall.
 */
export const WINDOWS_STOP_RELAY_SERVICES_PS = [
  "$p=Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {",
  "  $_.CommandLine -and ($_.CommandLine -match '[\\\\/]node_modules[\\\\/]relay-companion[\\\\/]') -and (($_.CommandLine -match '[\\\\/]relay\\.js.*\\bdaemon\\b') -or ($_.CommandLine -match '[\\\\/]overlay[\\\\/]main\\.cjs'))",
  "}; foreach($x in $p){ try { Invoke-CimMethod -InputObject $x -MethodName Terminate -ErrorAction Stop | Out-Null } catch {} }",
].join(" ");

/**
 * Stop the Relay services on Windows: end the tasks, then terminate whatever
 * the task end left behind. Best-effort and idempotent; returns what it did
 * so callers can report rather than assume.
 */
export function stopWindowsRelayServices({ runCommand = run } = {}) {
  for (const task of [WINDOWS_DAEMON_TASK_NAME, WINDOWS_PILL_TASK_NAME]) runCommand("schtasks", ["/End", "/TN", task]);
  const swept = runCommand("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_STOP_RELAY_SERVICES_PS]);
  return { swept: Boolean(swept && swept.ok) };
}

/**
 * The two background services an account change has to reach, by the names
 * each platform's supervisor knows them under and by the command-line shape
 * their live process has (the ONLY reliable handle on Windows — see
 * WINDOWS_STOP_RELAY_SERVICES_PS).
 */
const RELAY_SERVICES = {
  daemon: {
    label: DAEMON_LAUNCH_LABEL,
    task: WINDOWS_DAEMON_TASK_NAME,
    // node.exe running relay.js daemon. Anchored on node so the cmd wrapper
    // that pipes its output cannot stand in for a node that never came up.
    processPattern: "node\\.exe.*[\\\\/]relay\\.js.*\\bdaemon\\b",
  },
  pill: {
    label: PILL_LAUNCH_LABEL,
    task: WINDOWS_PILL_TASK_NAME,
    processPattern: "electron\\.exe.*[\\\\/]overlay[\\\\/]main\\.cjs",
  },
};

/**
 * PowerShell for one Windows service restart, verified end to end. Exported
 * as a string builder so tests can pin what it does without running it.
 *
 * Why not `schtasks /End` + `/Run`, which the pill's Switch Account used until
 * 2026-08-18: the tasks launch through a wscript wrapper, so /End "succeeds"
 * having killed the wrapper while node lives on with the old token, and /Run
 * reports success the moment the ACTION starts, before anyone knows whether
 * the program inside it survived. Both lessons were already learned by the
 * updater (auto-update.js Restart-RelayService); this is the same discipline
 * for the account paths: stop by identity, start via the task, then wait for
 * the real process. Prints exactly one status word:
 *   restarted      the new process is observably alive
 *   not_installed  no scheduled task by this name (the service is left alone —
 *                  a daemon that is running follows the account on its own)
 *   failed         the task exists but its process never appeared
 */
export function windowsRestartServiceScript(service, { waitSeconds = 15 } = {}) {
  const spec = RELAY_SERVICES[service];
  if (!spec) throw new Error(`unknown Relay service: ${service}`);
  return [
    `$Task = '${spec.task}'`,
    `$Pattern = '${spec.processPattern}'`,
    "function Get-Live { try { @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine -match $Pattern }) } catch { @() } }",
    "$null = schtasks /Query /TN $Task 2>$null; if ($LASTEXITCODE -ne 0) { Write-Output 'not_installed'; exit 0 }",
    "$null = schtasks /End /TN $Task 2>$null",
    "$Old = Get-Live",
    "foreach ($P in $Old) { try { Stop-Process -Id $P.ProcessId -Force -ErrorAction Stop } catch {} }",
    // Let the OS release the log handle before the replacement's wrapper opens it.
    "if ($Old.Count -gt 0) { Start-Sleep -Milliseconds 800 }",
    "$null = schtasks /Run /TN $Task 2>$null; if ($LASTEXITCODE -ne 0) { Write-Output 'failed'; exit 0 }",
    `$Deadline = (Get-Date).AddSeconds(${Math.max(1, Math.floor(waitSeconds))})`,
    "while ((Get-Date) -lt $Deadline) { if ((Get-Live).Count -gt 0) { Write-Output 'restarted'; exit 0 }; Start-Sleep -Milliseconds 500 }",
    "Write-Output 'failed'",
  ].join("; ");
}

/**
 * Restart Relay's background services so they run against whatever
 * config.json holds now. This is the ONE restart the account paths use —
 * `relay pair`, the pill's Switch Account, and Sign Out — so a lesson learned
 * once about how a platform's supervisor actually behaves lands in all three.
 *
 * Returns { daemon, pill } with one of restarted | not_installed | failed |
 * skipped per service, plus `detail` for logs. Never throws: the account is
 * already persisted by the time this runs, and the daemon rebinds itself on
 * its next poll even if this fails (task-daemon.js followAccountDrift), so a
 * restart failure is something to REPORT, not something to roll back.
 *
 * `services` defaults to the daemon alone: the pill restarts itself
 * (relaunchPillSoon) because from inside the pill a kickstart is suicide
 * before the IPC reply reaches the renderer.
 *
 * Async and non-blocking by default (the Windows path can legitimately take
 * several seconds while it waits for the new process) so the pill's main
 * process keeps painting; a sync runner may be injected for tests.
 */
export async function restartRelayServices({ services = ["daemon"], runCommand = runAsync, waitSeconds = 15, platform = process.platform } = {}) {
  const result = { daemon: "skipped", pill: "skipped", detail: {} };
  for (const service of services) {
    const spec = RELAY_SERVICES[service];
    if (!spec) continue;
    try {
      if (platform === "darwin") {
        const uid = typeof process.getuid === "function" ? process.getuid() : 501;
        const target = `gui/${uid}/${spec.label}`;
        const loaded = await runCommand("/bin/launchctl", ["print", target]);
        if (!loaded.ok) {
          result[service] = "not_installed";
          continue;
        }
        // kickstart -k: kill the running instance and start a fresh one.
        const kicked = await runCommand("/bin/launchctl", ["kickstart", "-k", target]);
        result[service] = kicked.ok ? "restarted" : "failed";
        if (!kicked.ok) result.detail[service] = kicked.out;
      } else if (platform === "win32") {
        const res = await runCommand(
          "powershell.exe",
          ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", windowsRestartServiceScript(service, { waitSeconds })],
          { timeoutMs: (waitSeconds + 10) * 1000 },
        );
        const tokens = String((res && res.out) || "").trim().split(/\s+/);
        const word = tokens.find((t) => ["restarted", "not_installed", "failed"].includes(t)) || "failed";
        result[service] = word;
        if (result[service] === "failed") result.detail[service] = (res && res.out) || "no output";
      } else if (platform === "linux") {
        const unit = service === "daemon" ? LINUX_DAEMON_UNIT : LINUX_PILL_UNIT;
        const loaded = await runCommand("systemctl", ["--user", "show", "--property=LoadState", "--value", unit]);
        if (!loaded.ok || String(loaded.out || "").trim() !== "loaded") {
          result[service] = "not_installed";
          continue;
        }
        const restarted = await runCommand("systemctl", ["--user", "restart", unit]);
        result[service] = restarted.ok ? "restarted" : "failed";
        if (!restarted.ok) result.detail[service] = restarted.out;
      } else {
        result[service] = "not_installed";
      }
    } catch (error) {
      result[service] = "failed";
      result.detail[service] = error && error.message ? error.message : String(error);
    }
  }
  return result;
}

/**
 * Human-readable outcome of restartRelayServices after an account change: only
 * the services that exist are mentioned, a failure says what to run, and the
 * one thing Relay cannot do — restart an agent session it did not start — is
 * always said, because every open session's Relay tools stay bound to the
 * previous account until that session is restarted (its next tool call refuses
 * with the same instruction; see mcp.js accountDriftRefusal).
 */
export function accountRestartLines(result) {
  const lines = [];
  const restarted = ["daemon", "pill"].filter((s) => result[s] === "restarted");
  const failed = ["daemon", "pill"].filter((s) => result[s] === "failed");
  const label = { daemon: "background service", pill: "Relay app" };
  if (restarted.length) lines.push(`Restarted the ${restarted.map((s) => label[s]).join(" and ")} on the new account.`);
  if (failed.length) {
    const detail = result.detail && (result.detail.daemon || result.detail.pill);
    lines.push(
      `The ${failed.map((s) => label[s]).join(" and ")} did not restart${detail ? ` (${detail})` : ""}; ` +
        "run `relay repair-installation` or restart this computer.",
    );
  }
  if (restarted.length || failed.length) {
    lines.push("Restart any open Claude Code or Codex sessions — their Relay tools are still on the previous account.");
  }
  return lines;
}

/**
 * Legacy one-shot task from the retired Windows updater patch era. Current
 * code never creates it, but machines that lived through that era still carry
 * it, and an uninstall that leaves a Relay task behind is not an uninstall.
 */
const WINDOWS_LEGACY_UPDATER_TASK_NAME = "Relay Companion Updater";

export function runUninstall() {
  // Services FIRST, on every platform. A daemon that outlives the steps below
  // re-registers them within one poll cycle (ensureWindowsAutostartTasks,
  // repair-runtime), silently undoing the uninstall.
  if (process.platform === "win32") stopWindowsRelayServices();
  if (process.platform === "linux") {
    run("systemctl", ["--user", "disable", "--now", LINUX_DAEMON_UNIT]);
    run("systemctl", ["--user", "stop", LINUX_PILL_UNIT]);
  }

  run("claude", ["mcp", "remove", "-s", "user", "relay"]);
  run("codex", ["mcp", "remove", "relay"]);
  removeClaudeCodeMcpConfig();
  removeCodexMcpConfig();
  const claudeDesktopRemoval = removeClaudeDesktopMcpConfig();
  const claudeHookRemoval = uninstallClaudeHooks();
  const codexHookRemoval = uninstallCodexHooks();
  // If a malformed host config prevented handler removal, leave the tiny bridge
  // in place. Deleting it would strand a visible MODULE_NOT_FOUND Stop hook.
  if (claudeHookRemoval.ok && codexHookRemoval.ok) {
    try {
      removeStableHookLauncher();
    } catch {
      /* a partial uninstall is still better than touching an unrelated file */
    }
  }
  if (process.platform === "darwin") {
    const plistPath = path.join(os.homedir(), "Library", "LaunchAgents", `${DAEMON_LAUNCH_LABEL}.plist`);
    run("launchctl", ["unload", plistPath]);
    try {
      fs.unlinkSync(plistPath);
    } catch {
      /* already gone */
    }
    const pillPlistPath = path.join(os.homedir(), "Library", "LaunchAgents", `${PILL_LAUNCH_LABEL}.plist`);
    run("launchctl", ["unload", pillPlistPath]);
    try {
      fs.unlinkSync(pillPlistPath);
    } catch {
      /* already gone */
    }
    for (const name of [RELAY_MAC_APP_NAME, RELAY_MAC_APP_FALLBACK_NAME]) {
      const appPath = path.join(os.homedir(), "Applications", name);
      try {
        if (isRelayOwnedMacApp(appPath)) fs.rmSync(appPath, { recursive: true, force: true });
      } catch {
        /* already gone */
      }
    }
  } else if (process.platform === "win32") {
    // Processes were stopped at the top; now the tasks that would relaunch
    // them at next logon.
    for (const task of [WINDOWS_DAEMON_TASK_NAME, WINDOWS_PILL_TASK_NAME, WINDOWS_LEGACY_UPDATER_TASK_NAME]) {
      run("schtasks", ["/Delete", "/TN", task, "/F"]);
    }
    for (const taskName of [WINDOWS_DAEMON_TASK_NAME, WINDOWS_PILL_TASK_NAME, RELAY_WINDOWS_LAUNCHER_TASK]) {
      try {
        fs.unlinkSync(windowsHiddenLauncherPath(os.homedir(), taskName));
      } catch {
        /* already gone */
      }
    }
    // The Start Menu entry is the Windows counterpart to Relay.app above.
    try {
      fs.unlinkSync(windowsStartMenuShortcutPath());
    } catch {
      /* already gone */
    }
  } else if (process.platform === "linux") {
    const paths = linuxDesktopPaths();
    for (const file of [
      paths.daemonUnitPath,
      paths.pillUnitPath,
      paths.applicationPath,
      paths.autostartPath,
      paths.pillStarterPath,
    ]) {
      try { fs.unlinkSync(file); } catch { /* already gone */ }
    }
    run("systemctl", ["--user", "daemon-reload"]);
  }
  return { claudeDesktop: claudeDesktopRemoval };
}

/**
 * The directories that hold everything Relay knows about this machine: the
 * pairing (`~/.relay/config.json` with the device token, plus logs and hidden
 * launchers) and the companion's working state (`~/.relay-companion`: ledger,
 * prefs, pill status, cached attachments). Honours the same env overrides the
 * readers use, so a test or a relocated install purges what it actually used.
 */
export function localStateDirs({ homeDir = os.homedir(), env = process.env } = {}) {
  const dirs = [
    env.RELAY_CONFIG_DIR || path.join(homeDir, ".relay"),
    env.RELAY_HOME || env.RELAY_COMPANION_HOME || path.join(homeDir, ".relay-companion"),
  ];
  return Array.from(new Set(dirs.map((dir) => path.resolve(dir))));
}

/** The companion package this process is executing from. */
export function runningPackageRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

/** Whether `child` is `parent` or lives underneath it. Case-insensitive on Windows. */
export function pathContains(parent, child, platform = process.platform) {
  const norm = (p) => {
    const resolved = path.resolve(p);
    return platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  const rel = path.relative(norm(parent), norm(child));
  if (rel === "") return true;
  return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/** The one file whose survival would leave this machine still paired. */
function pairingCredentialPath({ homeDir = os.homedir(), env = process.env } = {}) {
  return env.RELAY_CONFIG || path.join(env.RELAY_CONFIG_DIR || path.join(homeDir, ".relay"), "config.json");
}

/**
 * Forget this machine: delete the pairing and every byte of companion state, so
 * the next `relay setup` is a genuinely fresh device. Deliberately NOT part of
 * runUninstall — removing the integrations while keeping the pairing is what
 * makes a reinstall painless, and that stays the default.
 *
 * Callers revoke the device server-side BEFORE this runs (the token lives in
 * what is about to be deleted).
 *
 * Deletion ORDER is the whole design here, because since the canonical runtime
 * (~/.relay/runtime/releases/<id>) the tree being deleted can be the tree this
 * process is executing from:
 *
 *   1. the pairing credential first, alone. Every other file here is cleanup;
 *      this is the only one whose survival produces the one outcome a purge must
 *      never produce — a machine that reports success but is still paired.
 *   2. the remaining entries one at a time rather than the directory in one
 *      call, so a single locked file (an Electron binary a dying pill still
 *      holds) cannot spare everything beside it.
 *   3. the branch we are running from last, giving it the best chance of being
 *      the only casualty.
 *
 * Windows may hold a log or binary open for a moment after the daemon task ends,
 * hence the retries; whatever still survives is reported, never hidden.
 */
export function purgeLocalState({
  homeDir = os.homedir(),
  env = process.env,
  runningFrom = runningPackageRoot(),
  platform = process.platform,
  deleteCredential = deleteDeviceToken,
} = {}) {
  const removed = [];
  const failed = [];
  const remove = (target) => {
    if (!fs.existsSync(target)) return;
    try {
      fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      removed.push(target);
    } catch (error) {
      failed.push({ path: target, detail: error && error.message ? error.message : String(error) });
    }
  };

  const customConfig = Boolean(env.RELAY_CONFIG || env.RELAY_CONFIG_DIR);
  let credentialAccount = "device-token";
  try {
    const config = JSON.parse(fs.readFileSync(pairingCredentialPath({ homeDir, env }), "utf8"));
    credentialAccount = String(config.credentialAccount || credentialAccount);
  } catch {}
  const credential = platform === process.platform && (!customConfig || env.RELAY_NATIVE_CREDENTIALS_WITH_CUSTOM_CONFIG === "1")
    ? deleteCredential({ platform, env, account: credentialAccount })
    : { ok: true };
  if (!credential.ok && (platform === "darwin" || platform === "win32" || platform === "linux")) {
    failed.push({ path: "native credential store", detail: credential.detail || "credential deletion failed" });
  }
  remove(pairingCredentialPath({ homeDir, env }));

  for (const dir of localStateDirs({ homeDir, env })) {
    if (!fs.existsSync(dir)) continue;
    // ALWAYS entry by entry, never one rmSync on the directory — wherever we
    // are running from. Observed 2026-08-18 running from the global shim: one
    // locked daemon.log made the single rmSync throw, and every other file in
    // ~/.relay survived beside it. The credential was already gone (step 1),
    // so the machine was forgotten, but "forgotten" and "clean" should be the
    // same thing whenever the OS allows.
    let entries;
    try {
      entries = fs.readdirSync(dir).map((name) => path.join(dir, name));
    } catch (error) {
      failed.push({ path: dir, detail: error && error.message ? error.message : String(error) });
      continue;
    }
    for (const entry of entries.filter((e) => !pathContains(e, runningFrom, platform))) remove(entry);
    for (const entry of entries.filter((e) => pathContains(e, runningFrom, platform))) remove(entry);
    // Only now can the directory itself go. A surviving child makes this fail,
    // which is exactly what should be reported rather than swallowed.
    remove(dir);
  }

  const pairingRemains = fs.existsSync(pairingCredentialPath({ homeDir, env }));
  return { ok: failed.length === 0, removed, failed, pairingRemains };
}

/**
 * Register the Relay MCP into Claude DESKTOP.
 *
 * Separate from `installClaudeCode` because they are different products with
 * different config files: the CLI reads ~/.claude.json, the desktop app reads
 * claude_desktop_config.json and never looks at the other. Writing that file is
 * the only unattended path — Claude Desktop has no CLI and no install deep link,
 * and a .mcpb extension cannot install without a human clicking a dialog.
 *
 * Writes every candidate directory that exists, because on Windows the app reads
 * a virtualised MSIX path while its own "Edit Config" button opens %APPDATA%.
 */
export function installClaudeDesktop(bin = relayBinPath(), node = stableNodePath(), { env = process.env } = {}) {
  const dirs = claudeDesktopConfigDirs({ env });
  if (!dirs.length) return { ok: false, reason: "claude_desktop_not_found" };

  const entry = claudeDesktopEntry({
    node: resolveStableNode({ execPath: node }),
    script: bin,
    relayHome: env.RELAY_HOME || undefined,
  });

  const written = [];
  const swept = [];
  let lastError = null;
  for (const dir of dirs) {
    const configPath = claudeDesktopConfigPathIn(dir);
    try {
      const existing = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : "";
      const { text, removed } = mergeClaudeDesktopConfig(existing, entry);
      // Atomic: the app watches this file and may be running.
      const tmp = `${configPath}.${process.pid}.${Date.now()}.tmp`;
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(tmp, text, { mode: 0o600 });
      fs.renameSync(tmp, configPath);
      written.push(configPath);
      swept.push(...removed);
    } catch (error) {
      lastError = error && error.message ? error.message : String(error);
    }
  }

  if (!written.length) return { ok: false, reason: "claude_desktop_write_failed", detail: lastError };
  return { ok: true, method: "desktop_config", configPaths: written, swept };
}

/**
 * The uninstall twin of installClaudeDesktop. Without it every uninstalled
 * machine kept an orphaned `relay` stdio server that Claude Desktop tried, and
 * failed, to start on every launch — forever.
 *
 * Same discipline as the writer: every candidate directory, atomic rename
 * because the app watches the file, and a malformed file is left alone rather
 * than guessed at (deleting our key is not worth destroying their preferences).
 */
export function removeClaudeDesktopMcpConfig({ env = process.env, name = "relay" } = {}) {
  const dirs = claudeDesktopConfigDirs({ env });
  const removedFrom = [];
  const failures = [];
  for (const dir of dirs) {
    const configPath = claudeDesktopConfigPathIn(dir);
    if (!fs.existsSync(configPath)) continue;
    try {
      const cfg = readJsonObject(configPath);
      const servers = cfg.mcpServers;
      if (!servers || typeof servers !== "object" || Array.isArray(servers) || !(name in servers)) continue;
      delete servers[name];
      const tmp = `${configPath}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(tmp, configPath);
      removedFrom.push(configPath);
    } catch (error) {
      failures.push({ configPath, detail: error && error.message ? error.message : String(error) });
    }
  }
  return { ok: failures.length === 0, removedFrom, failures };
}

/**
 * Claude Desktop can be centrally disallowed from running user-added stdio
 * servers. Writing a config that will never load, and calling it success, is the
 * failure mode this whole change exists to remove — so check first and say so.
 */
export function claudeDesktopLocalMcpDisabled({ platform = process.platform } = {}) {
  if (platform !== "darwin") return false;
  const res = run("defaults", ["read", "com.anthropic.claudefordesktop", "isLocalDevMcpEnabled"]);
  if (!res.ok) return false; // Unset: the default is enabled.
  return /^\s*(0|false|no)\s*$/i.test(String(res.out || ""));
}
