// WHICH AI APPS ARE ON THIS COMPUTER (2026-10-09).
//
// The one answer to "is Claude Code / Codex / the Claude app / the ChatGPT
// app / Conductor installed here, and where?", on macOS, Windows and Linux.
// Every feature starts from it and then asks only its own question on top:
//
//   capabilities.js     can Relay OPEN a Relay in that app here (Open in)
//   native-task-launch  can Relay RUN a Task in that app here (Execute, Run)
//   agent-host-status   is Relay CONNECTED in that app here (Your AIs)
//
// Before this, each of those found the apps itself, and they disagreed: the
// Open-in lookup only knew macOS (`/usr/bin/which`, /Applications), so on
// Windows it said nothing was installed, and the Task card, which filtered
// Execute's correct answer through it, lost its run buttons (2026-10-09).
//
// Nothing here runs a program: it looks for files and directories, and scans
// PATH in-process. Options are test seams; `appsDir` stands in for the macOS
// Applications folders.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function defaults(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const homedir = options.homedir || options.homeDir || env.HOME || os.homedir();
  const exists = options.exists || ((file) => { try { return Boolean(file) && fs.existsSync(file); } catch { return false; } });
  const readdir = options.readdir || ((dir) => { try { return fs.readdirSync(dir); } catch { return []; } });
  return { env, platform, homedir, exists, readdir, appsDir: options.appsDir || "" };
}

function firstExisting(paths, exists) {
  return paths.find((file) => file && exists(file)) || "";
}

function pathLib(platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

/** A command on PATH, found the way the shell would, without running anything. */
function findOnPath(binary, options = {}) {
  const { env, platform, exists } = defaults(options);
  const lib = pathLib(platform);
  const raw = env.PATH ?? env.Path ?? "";
  const dirs = String(raw).split(platform === "win32" ? ";" : ":").filter(Boolean);
  const extensions = platform === "win32"
    ? String(env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean).map((ext) => ext.toLowerCase())
    : [""];
  for (const dir of dirs) {
    for (const ext of extensions) {
      const candidate = lib.join(dir, `${binary}${ext}`);
      if (exists(candidate)) return candidate;
    }
  }
  return "";
}

/** An app bundle in /Applications or ~/Applications (macOS only). */
function macAppPath(names, options = {}) {
  const { platform, homedir, exists, appsDir } = defaults(options);
  if (platform !== "darwin" && !appsDir) return "";
  const join = appsDir ? path.join : path.posix.join;
  const roots = appsDir ? [appsDir] : ["/Applications", path.posix.join(homedir, "Applications")];
  for (const name of names) {
    const hit = firstExisting(roots.map((root) => join(root, `${name}.app`)), exists);
    if (hit) return hit;
  }
  return "";
}

/**
 * Every directory the Claude app keeps its data in. On Windows the Store
 * (MSIX) app reads a virtualised copy under Packages while its own "Edit
 * Config" opens %APPDATA%\Claude, so both count. Claude-3p is the
 * enterprise/partner build. CLAUDE_USER_DATA_DIR wins verbatim.
 */
function claudeDesktopDirs(options = {}) {
  const { env, platform, homedir, exists, readdir } = defaults(options);
  if (env.CLAUDE_USER_DATA_DIR) return [env.CLAUDE_USER_DATA_DIR];
  if (platform === "darwin") {
    const base = path.posix.join(homedir, "Library", "Application Support");
    return [path.posix.join(base, "Claude"), path.posix.join(base, "Claude-3p")].filter(exists);
  }
  if (platform === "win32") {
    const dirs = [];
    if (env.LOCALAPPDATA) {
      const packages = path.win32.join(env.LOCALAPPDATA, "Packages");
      // The package family name carries a hash, so glob rather than pin it.
      for (const entry of readdir(packages)) {
        if (!/^Claude_/.test(entry)) continue;
        const dir = path.win32.join(packages, entry, "LocalCache", "Roaming", "Claude");
        if (exists(dir)) dirs.push(dir);
      }
      const thirdParty = path.win32.join(env.LOCALAPPDATA, "Claude-3p");
      if (exists(thirdParty)) dirs.push(thirdParty);
    }
    if (env.APPDATA) {
      const roaming = path.win32.join(env.APPDATA, "Claude");
      if (exists(roaming)) dirs.push(roaming);
    }
    return dirs;
  }
  // Anthropic ships no Linux desktop build.
  return [];
}

/** The Claude Code command-line tool. */
function claudeCliPath(options = {}) {
  const { env, platform, homedir, exists } = defaults(options);
  const explicit = String(env.RELAY_CLAUDE_CLI_PATH || "").trim();
  if (explicit) return explicit;
  const lib = pathLib(platform);
  const exe = platform === "win32" ? ".exe" : "";
  return firstExisting([
    lib.join(homedir, ".claude", "local", `claude${exe}`),
    lib.join(homedir, ".local", "bin", `claude${exe}`),
    ...(platform === "win32" ? [] : ["/opt/homebrew/bin/claude", "/usr/local/bin/claude"]),
  ], exists) || findOnPath("claude", { ...options, env, platform, exists });
}

/** The Codex command-line tool (not the copy inside the ChatGPT app). */
function codexCliPath(options = {}) {
  const { env, platform, homedir, exists } = defaults(options);
  const explicit = String(env.CODEX_CLI_PATH || "").trim();
  if (explicit) return explicit;
  const lib = pathLib(platform);
  const candidates = platform === "win32"
    ? [env.LOCALAPPDATA && lib.join(env.LOCALAPPDATA, "Programs", "OpenAI", "Codex", "bin", "codex.exe"), lib.join(homedir, ".local", "bin", "codex.exe")]
    : ["/opt/homebrew/bin/codex", "/usr/local/bin/codex", lib.join(homedir, ".local", "bin", "codex")];
  return firstExisting(candidates, exists) || findOnPath("codex", { ...options, env, platform, exists });
}

/**
 * The Claude app: its bundle on macOS; on Windows its data directory, or,
 * before its first launch has made one, the Store package or the older
 * installer's folder.
 */
function claudeAppPath(options = {}) {
  const o = defaults(options);
  if (o.platform === "darwin" || o.appsDir) return macAppPath(["Claude"], o);
  if (o.platform !== "win32") return "";
  const data = claudeDesktopDirs(o)[0];
  if (data) return data;
  if (!o.env.LOCALAPPDATA) return "";
  const packages = path.win32.join(o.env.LOCALAPPDATA, "Packages");
  const entry = o.readdir(packages).find((name) => /^Claude_/.test(name));
  if (entry) return path.win32.join(packages, entry);
  return firstExisting([path.win32.join(o.env.LOCALAPPDATA, "AnthropicClaude")], o.exists);
}

/** The ChatGPT app, which is also Codex's desktop app. */
function chatgptAppPath(options = {}) {
  const o = defaults(options);
  if (o.platform === "darwin" || o.appsDir) return macAppPath(["ChatGPT", "Codex"], o);
  if (o.platform === "win32" && o.env.LOCALAPPDATA) {
    const packages = path.win32.join(o.env.LOCALAPPDATA, "Packages");
    const entry = o.readdir(packages).find((name) => /^OpenAI\.Codex_/.test(name));
    if (entry) return path.win32.join(packages, entry);
    // The app's own Codex is there even when the package folder is not.
    const binary = codexAppBinary(o);
    if (binary) return path.win32.dirname(path.win32.dirname(binary));
  }
  return "";
}

/** The codex binary the ChatGPT/Codex app ships, newest first on Windows. */
function codexAppBinary(options = {}) {
  const o = defaults(options);
  if (o.platform === "darwin" || o.appsDir) {
    const join = o.appsDir ? path.join : path.posix.join;
    const roots = o.appsDir ? [o.appsDir] : ["/Applications", path.posix.join(o.homedir, "Applications")];
    return firstExisting(roots.flatMap((root) => ["ChatGPT", "Codex"].map((name) => join(root, `${name}.app`, "Contents", "Resources", "codex"))), o.exists);
  }
  if (o.platform === "win32") {
    const root = path.win32.join(o.env.LOCALAPPDATA || path.win32.join(o.homedir, "AppData", "Local"), "OpenAI", "Codex", "bin");
    const mtime = (file) => { try { return fs.statSync(file).mtimeMs; } catch { return 0; } };
    return o.readdir(root).map((name) => path.win32.join(root, name, "codex.exe")).filter(o.exists)
      .sort((a, b) => mtime(b) - mtime(a))[0] || "";
  }
  return "";
}

/** Where the Claude app keeps the Claude Code its Code tab runs. */
function claudeAppCodeDir(options = {}) {
  const o = defaults(options);
  if (o.platform !== "darwin" && o.platform !== "win32") return "";
  const lib = pathLib(o.platform);
  return firstExisting(claudeDesktopDirs(o).map((dir) => lib.join(dir, "claude-code")), o.exists);
}

/** That Claude Code's own binary: the newest version the app downloaded. */
function claudeAppCodeCli(options = {}) {
  const o = defaults(options);
  const root = claudeAppCodeDir(o);
  if (!root) return "";
  const lib = pathLib(o.platform);
  const order = (a, b) => a.split(/[.-]/).map(Number).reduce((diff, part, i) => diff || part - (Number(b.split(/[.-]/)[i]) || 0), 0);
  const versions = o.readdir(root).filter((name) => /^\d+\.\d+\.\d+/.test(name)).sort(order).reverse();
  for (const version of versions) {
    for (const build of o.readdir(lib.join(root, version))) {
      const bin = o.platform === "win32"
        ? lib.join(root, version, build, "claude.exe")
        : lib.join(root, version, build, "claude.app", "Contents", "MacOS", "claude");
      if (o.exists(bin)) return bin;
    }
  }
  return "";
}

/** Conductor (macOS only). */
function conductorAppPath(options = {}) {
  return macAppPath(["Conductor"], defaults(options));
}

/** Everything above, in one read. "" means not installed. */
function installedAiApps(options = {}) {
  const o = defaults(options);
  return {
    claudeCli: claudeCliPath(o),
    codexCli: codexCliPath(o),
    claudeApp: claudeAppPath(o),
    claudeAppCode: claudeAppCodeDir(o),
    claudeAppCodeCli: claudeAppCodeCli(o),
    chatgptApp: chatgptAppPath(o),
    codexAppBinary: codexAppBinary(o),
    conductorApp: conductorAppPath(o),
  };
}

module.exports = {
  installedAiApps,
  claudeCliPath,
  codexCliPath,
  claudeAppPath,
  chatgptAppPath,
  codexAppBinary,
  claudeAppCodeDir,
  claudeAppCodeCli,
  conductorAppPath,
  claudeDesktopDirs,
  macAppPath,
  findOnPath,
};
