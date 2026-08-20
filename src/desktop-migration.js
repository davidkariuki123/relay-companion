import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { managedInstallInfo } from "./auto-update.js";
import {
  installDaemonAutostart,
  installPillAutostart,
  relayBinPath,
  stableNodePath,
} from "./install.js";

const DEFAULT_RETRY_DELAYS_MS = [15_000, 60_000, 5 * 60_000];

function packageRootForThisModule() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

function packageVersion(packageRoot) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
    return typeof pkg.version === "string" && pkg.version ? pkg.version : null;
  } catch {
    return null;
  }
}

function safeVersionSegment(version) {
  return String(version || "unknown").replace(/[^A-Za-z0-9._-]/g, "_");
}

export function desktopMigrationMarkerPath({ homeDir = os.homedir(), version } = {}) {
  return path.join(homeDir, ".relay", "desktop-migrations", `${safeVersionSegment(version)}.json`);
}

function readMarker(markerPath) {
  try {
    const value = JSON.parse(fs.readFileSync(markerPath, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function markerSurfacePaths(marker) {
  const appExecutablePath =
    typeof marker?.appPath === "string" && marker.appPath
      ? path.join(marker.appPath, "Contents", "MacOS", "applet")
      : null;
  return [marker?.appPath, appExecutablePath, marker?.pillPlistPath, marker?.daemonPlistPath];
}

export function desktopMigrationMarkerIsCurrent(
  marker,
  { version, packageRoot, existsSync = fs.existsSync } = {},
) {
  if (
    !marker ||
    marker.version !== version ||
    path.resolve(String(marker.packageRoot || "")) !== path.resolve(packageRoot)
  ) {
    return false;
  }
  const surfaces = markerSurfacePaths(marker);
  if (surfaces.some((surfacePath) => typeof surfacePath !== "string" || !surfacePath)) return false;
  return surfaces.every((surfacePath) => {
    try {
      return existsSync(surfacePath);
    } catch {
      return false;
    }
  });
}

function writeMarkerAtomic(markerPath, marker) {
  fs.mkdirSync(path.dirname(markerPath), { recursive: true });
  const tmp = `${markerPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, markerPath);
  } catch (error) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {}
    throw error;
  }
}

/**
 * One-time compatibility migration for installs delivered by an older updater.
 *
 * npm lifecycle scripts are not a reliable migration boundary: recent npm clients
 * can suppress unapproved postinstall hooks. The newly loaded daemon therefore
 * repairs its own desktop surfaces once per package version as
 * well. It writes the daemon plist without reloading it (never unload the process
 * executing this code), then installs/reloads only the pill so Relay.app and
 * KeepAlive become effective immediately.
 */
export function runDesktopStartupMigration({
  platform = process.platform,
  homeDir = os.homedir(),
  packageRoot = packageRootForThisModule(),
  bin = relayBinPath(),
  node = stableNodePath(),
  version = packageVersion(packageRoot),
  existsSync = fs.existsSync,
  readMarkerImpl = readMarker,
  writeMarkerImpl = writeMarkerAtomic,
  installDaemonImpl = installDaemonAutostart,
  installPillImpl = installPillAutostart,
  runCommand,
} = {}) {
  if (platform !== "darwin") return { attempted: false, ok: true, reason: "not-darwin", retryable: false };
  if (!managedInstallInfo(packageRoot, { home: homeDir })) {
    return { attempted: false, ok: true, reason: "unmanaged-install", retryable: false };
  }
  if (!version) return { attempted: false, ok: false, reason: "version-unavailable", retryable: false };
  const markerPath = desktopMigrationMarkerPath({ homeDir, version });
  const marker = readMarkerImpl(markerPath);
  if (desktopMigrationMarkerIsCurrent(marker, { version, packageRoot, existsSync })) {
    return { attempted: false, ok: true, reason: "already-current", markerPath, marker, retryable: false };
  }

  const sharedOptions = {
    platform,
    homeDir,
    reload: false,
    ...(runCommand ? { runCommand } : {}),
  };
  let daemon;
  try {
    // Refresh the daemon's on-disk plist first, but NEVER unload/reload the daemon
    // from inside itself. The new arguments take effect on the next normal launch.
    daemon = installDaemonImpl(bin, node, sharedOptions);
  } catch (error) {
    return {
      attempted: true,
      ok: false,
      reason: "daemon-plist-repair-threw",
      detail: error?.message || String(error),
      markerPath,
      retryable: true,
    };
  }
  if (!daemon?.ok || !daemon.plistPath) {
    return {
      attempted: true,
      ok: false,
      reason: daemon?.reason || "daemon-plist-repair-failed",
      daemon,
      markerPath,
      retryable: true,
    };
  }

  let pill;
  try {
    // Relay.app is built as part of the pill install. Reload ONLY this service so
    // KeepAlive and the current package paths become live without restarting us.
    pill = installPillImpl(bin, { ...sharedOptions, reload: true });
  } catch (error) {
    return {
      attempted: true,
      ok: false,
      reason: "pill-repair-threw",
      detail: error?.message || String(error),
      daemon,
      markerPath,
      retryable: true,
    };
  }
  if (!pill?.ok || !pill.plistPath || !pill.appPath) {
    return {
      attempted: true,
      ok: false,
      reason: pill?.reason || "pill-repair-failed",
      daemon,
      pill,
      markerPath,
      retryable: true,
    };
  }

  const nextMarker = {
    version,
    packageRoot: path.resolve(packageRoot),
    appPath: pill.appPath,
    pillPlistPath: pill.plistPath,
    daemonPlistPath: daemon.plistPath,
    completedAt: new Date().toISOString(),
  };
  try {
    writeMarkerImpl(markerPath, nextMarker);
  } catch (error) {
    return {
      attempted: true,
      ok: false,
      reason: "marker-write-failed",
      detail: error?.message || String(error),
      daemon,
      pill,
      markerPath,
      retryable: true,
    };
  }
  return { attempted: true, ok: true, daemon, pill, markerPath, marker: nextMarker, retryable: false };
}

/** Run immediately, then retry a bounded number of transient failures on unref'd timers. */
export function startDesktopStartupMigration({
  runMigration = () => runDesktopStartupMigration(),
  retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
  setTimeoutImpl = setTimeout,
  log = () => {},
} = {}) {
  const timers = new Set();
  let stopped = false;
  let attempts = 0;
  let lastResult = null;

  const run = (retryIndex = 0) => {
    if (stopped) return lastResult;
    attempts += 1;
    try {
      lastResult = runMigration();
    } catch (error) {
      lastResult = {
        attempted: true,
        ok: false,
        reason: "desktop-migration-threw",
        detail: error?.message || String(error),
        retryable: true,
      };
    }
    if (lastResult?.ok || !lastResult?.retryable || retryIndex >= retryDelaysMs.length) {
      if (lastResult?.attempted && !lastResult?.ok) {
        log(`desktop migration stopped after ${attempts} attempt(s): ${lastResult.reason}`);
      }
      return lastResult;
    }
    const delay = Number(retryDelaysMs[retryIndex]);
    if (!Number.isFinite(delay) || delay < 0) return lastResult;
    log(`desktop migration retrying in ${Math.round(delay / 1000)}s (${lastResult.reason})`);
    const timer = setTimeoutImpl(() => {
      timers.delete(timer);
      run(retryIndex + 1);
    }, delay);
    timers.add(timer);
    if (timer && typeof timer.unref === "function") timer.unref();
    return lastResult;
  };

  const firstResult = run(0);
  return {
    firstResult,
    get attempts() {
      return attempts;
    },
    get lastResult() {
      return lastResult;
    },
    stop() {
      stopped = true;
      for (const timer of timers) {
        try {
          clearTimeout(timer);
        } catch {}
      }
      timers.clear();
    },
  };
}
