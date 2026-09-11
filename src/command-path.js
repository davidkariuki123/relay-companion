import fs from "node:fs";
import path from "node:path";

// Resolve a host CLI the way the operating system's own launcher would.
//
// Relay used to ask `which` whether `codex` or `claude` was installed. `which`
// is a Unix tool: on Windows it exists only inside Git Bash, never in the PATH
// of the scheduled task that runs the daemon or the pill. That single spawn
// made Codex read as "not installed" on every Windows machine while its
// binary sat on PATH, which parked Codex-hosted work in degraded fallback and
// refused "Open in Codex". A plain PATH walk answers the same question on every
// platform without spawning anything.
function windowsExtensions(env) {
  const configured = String(env.PATHEXT || ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((ext) => ext.trim().toLowerCase())
    .filter(Boolean);
  return [...new Set(["", ...configured])];
}

function isExecutableFile(candidate, platform) {
  try {
    if (!fs.statSync(candidate).isFile()) return false;
    if (platform !== "win32") fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Return the resolved path of `command` when it is runnable, or null.
 * An explicit path (absolute or containing a separator) is checked as-is.
 * A bare name is searched along PATH, honoring PATHEXT on Windows.
 */
export function resolveCommand(command, { env = process.env, platform = process.platform } = {}) {
  const value = String(command || "").trim();
  if (!value) return null;
  const extensions = platform === "win32" ? windowsExtensions(env) : [""];
  const explicit = path.isAbsolute(value) || value.includes("/") || value.includes("\\");
  if (explicit) {
    for (const ext of extensions) {
      if (isExecutableFile(value + ext, platform)) return value + ext;
    }
    return null;
  }
  const directories = String(env.PATH || env.Path || "")
    .split(platform === "win32" ? ";" : ":")
    .map((dir) => dir.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
  for (const dir of directories) {
    for (const ext of extensions) {
      const candidate = path.join(dir, value + ext);
      if (isExecutableFile(candidate, platform)) return candidate;
    }
  }
  return null;
}

export function commandExists(command, options) {
  return resolveCommand(command, options) !== null;
}
