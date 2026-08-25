import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { readCanonicalRuntime } from "./canonical-runtime.js";
import { companionPackageRoot, currentCompanionVersion, isManagedInstall, isNewerVersion } from "./auto-update.js";

/**
 * The `relay` command a person types is the npm global shim, and it stays at
 * whatever version was last `npm install -g`'d — forever. The canonical
 * runtime (~/.relay/runtime/releases/<id>) updates the daemon and pill by
 * rewriting THEIR launchers to the new release, but nothing re-points the
 * shim, so `relay doctor`, `relay uninstall`, even `relay update` run stale
 * code on every machine, and `relay update` cannot repair itself because it
 * is one of the stale commands.
 *
 * So the shim becomes a trampoline: at startup, if an active canonical
 * release exists at a different path, hand the whole invocation to that
 * release's bin. After the first install, `npm install -g` never matters
 * again.
 *
 * Commands that must NOT hop, because they are launched by exact path on
 * purpose and their identity is the whole point:
 *   - daemon: the service launcher names the exact release, and the daemon's
 *     own stale-process handoff depends on knowing which tree it booted from.
 *     The pill is intentionally NOT exempt: launchd / Scheduled Tasks start
 *     Electron directly, while a human typing `relay pill` may be entering
 *     through a years-old global npm shim. That command must open the active
 *     canonical pill, not resurrect the shim's bundled overlay.
 *   - mcp: launched by the stable MCP launcher, which activation already
 *     rewrites to the exact release bin.
 *   - repair-runtime / self-update: invoked BY the updater during activation
 *     and rollback, sometimes deliberately from a tree that is not current.
 *     Hopping would defeat rollback. `repair-desktop` is human-facing and must
 *     hop: otherwise a stale npm shim can rebuild Relay.app around stale code.
 *   - claude-hook / codex-hook: launched by the stable hook launcher, same
 *     reasoning as mcp.
 *
 * Everything else hops — including commands that no longer exist: a human
 * pasting a stale command from an old notification should land in the current
 * release's usage text, not in stale code that still pretends to serve it.
 */
export const TRAMPOLINE_EXEMPT_COMMANDS = new Set([
  "daemon",
  "mcp",
  "repair-runtime",
  "self-update",
  "claude-hook",
  "codex-hook",
]);

/** Set on the hop so the target can never hop again, whatever it reads. */
export const TRAMPOLINE_ENV = "RELAY_CLI_TRAMPOLINED";
/** Where the human's typed `relay` actually lives, for `doctor` to report. */
export const TRAMPOLINE_SHIM_VERSION_ENV = "RELAY_CLI_SHIM_VERSION";
export const TRAMPOLINE_SHIM_ROOT_ENV = "RELAY_CLI_SHIM_ROOT";

function samePath(left, right, platform) {
  const a = path.resolve(String(left || ""));
  const b = path.resolve(String(right || ""));
  return platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * Decide whether this invocation should hand off, and to what. Pure apart
 * from the injected readers, so the rules are testable without a runtime.
 *
 * Returns null to run in-process, or { node, bin, from, to, shimRoot } to hop.
 */
export function resolveCliTrampoline({
  command,
  argv = [],
  env = process.env,
  platform = process.platform,
  homeDir = os.homedir(),
  runningRoot = companionPackageRoot(),
  runningVersion = null,
  readCurrent = () => readCanonicalRuntime({ homeDir, platform }),
  exists = fs.existsSync,
  execPath = process.execPath,
} = {}) {
  if (env[TRAMPOLINE_ENV]) return null;
  // The documented escape hatch: run the tree the human actually invoked,
  // e.g. a deliberately `npm install -g`'d older build under investigation.
  if (argv.includes("--no-trampoline")) return null;
  // A bare `relay` (usage text) and unknown commands hop too — the help a
  // person reads should describe the code the machine runs.
  if (command && TRAMPOLINE_EXEMPT_COMMANDS.has(command)) return null;
  // Only an npm-managed tree is "just a way in". A dev checkout
  // (.../packages/companion, not under node_modules) is the developer's own
  // code and must run as itself — and its package.json version cannot be
  // trusted for the comparison below, because CI assigns versions on
  // publish, so a checkout of main always looks older than the fleet.
  if (!isManagedInstall(runningRoot)) return null;

  const current = readCurrent();
  if (!current || !current.bin || !current.packageRoot) return null;
  if (samePath(current.packageRoot, runningRoot, platform)) return null;
  // Mid-swap or half-deleted release: run what we have rather than fail.
  if (!exists(current.bin)) return null;

  // A NEWER invoker runs itself. That is a dev checkout under test, or a
  // freshly `npm install -g`'d shim the canonical runtime has not caught up
  // with yet — in both cases the newer code is the one the human means.
  const mine = runningVersion ?? safeVersion(runningRoot);
  if (mine && current.version && isNewerVersion(mine, current.version)) return null;

  return {
    node: current.node && exists(current.node) ? current.node : execPath,
    bin: current.bin,
    from: mine,
    to: current.version,
    shimRoot: path.resolve(String(runningRoot)),
  };
}

function safeVersion(root) {
  try {
    return currentCompanionVersion(root);
  } catch {
    return null;
  }
}

/**
 * Perform the hop: run the canonical bin with the same argv, inherit stdio,
 * mirror its exit. Windows has no exec(), so this is a blocking spawn — the
 * shim stays alive as a thin parent, which also keeps Ctrl+C semantics
 * intact because both processes share the console group.
 */
export function runCliTrampoline(hop, {
  argv = process.argv.slice(2),
  env = process.env,
  spawn = spawnSync,
} = {}) {
  const result = spawn(hop.node, [hop.bin, ...argv], {
    stdio: "inherit",
    env: {
      ...env,
      [TRAMPOLINE_ENV]: "1",
      // Let the target's `doctor` report the shim the human actually typed;
      // without this the hop makes a frozen shim invisible.
      [TRAMPOLINE_SHIM_VERSION_ENV]: hop.from || "",
      [TRAMPOLINE_SHIM_ROOT_ENV]: hop.shimRoot || "",
    },
  });
  if (result.error) throw result.error;
  if (result.signal) {
    process.kill(process.pid, result.signal);
    return 1;
  }
  return result.status == null ? 1 : result.status;
}
