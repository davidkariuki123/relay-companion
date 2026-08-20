// Real idle-wake for Claude DESKTOP sessions.
//
// Why this exists. A staged hook injection is only consumed when the session
// takes a turn, so a relay clicked into an idle chat sits there invisibly. The
// platform's supported way to make an idle session take a turn is a channel
// notification — and the capability ships in the CLI Claude Desktop already
// runs. The one missing piece is the flag: Desktop never passes --channels, and
// there is no file, env var or setting that adds it (its --mcp-config and
// --settings are handed over as inline JSON, and the CLI's stdin is an
// anonymous socketpair owned by the app, so nothing external can reach it).
//
// So we add the flag at the only remaining seam: the executable path Desktop
// spawns. `claude` is moved aside to `claude.relay-real` and replaced by a tiny
// shim that execs it with --channels appended. Verified on 2.1.221:
//   - a shell script CAN exec the hardened-runtime signed binary (it keeps its
//     own embedded signature; the bundle's resource seal is not checked here),
//   - Desktop performs NO signature/hash check at spawn time,
//   - `relay mcp` is ALREADY an MCP server in every Desktop session, so
//     `--channels server:relay` names a server that is really there.
//
// Safety rules, because this modifies software we do not own:
//   - never shim twice, never shim a shim (the real binary is identified by
//     being a Mach-O, and recorded in a manifest);
//   - verify the shim runs (`--version`) BEFORE leaving it in place, and roll
//     back automatically if it does not;
//   - `uninstallDesktopWake` restores the original byte-for-byte;
//   - Desktop auto-updates the CLI into a NEW version directory, so this is
//     re-applied per version by the daemon rather than assumed permanent.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const REAL_SUFFIX = ".relay-real";
const MANIFEST = "relay-desktop-wake.json";
const MACHO_MAGICS = new Set([0xfeedfacf, 0xcffaedfe, 0xfeedface, 0xcefaedfe, 0xcafebabe, 0xbebafeca]);

export function claudeCodeRoot({ home = os.homedir() } = {}) {
  return path.join(home, "Library", "Application Support", "Claude", "claude-code");
}

/** Every installed CLI version directory, newest-looking last. */
export function installedCliVersions({ home = os.homedir() } = {}) {
  let entries = [];
  try {
    entries = fs.readdirSync(claudeCodeRoot({ home }), { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^\d+\.\d+\.\d+/.test(e.name))
      .map((e) => e.name);
  } catch {
    return [];
  }
  return entries.sort(compareVersions);
}

function compareVersions(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return a.localeCompare(b);
}

export function cliBinaryPath(version, { home = os.homedir() } = {}) {
  return path.join(claudeCodeRoot({ home }), version, "claude.app", "Contents", "MacOS", "claude");
}

/** A real Mach-O executable (not our shell shim). */
export function isMachO(file) {
  try {
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(4);
      fs.readSync(fd, buf, 0, 4, 0);
      return MACHO_MAGICS.has(buf.readUInt32BE(0)) || MACHO_MAGICS.has(buf.readUInt32LE(0));
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

export function shimSource(realPath, channels) {
  // `exec` so Desktop's process tree, signals and exit codes are unchanged —
  // the shim must be invisible to everything except the argument list.
  return `#!/bin/sh
# Installed by Relay so Claude Desktop sessions can be woken by an incoming
# relay (adds --channels; see src/desktop-wake.js). Remove with: relay wake-off
exec ${JSON.stringify(realPath)} --dangerously-load-development-channels ${JSON.stringify(channels)} "$@"
`;
}

function manifestPath({ home = os.homedir() } = {}) {
  return path.join(home, ".relay", MANIFEST);
}

function readManifest(opts) {
  try {
    return JSON.parse(fs.readFileSync(manifestPath(opts), "utf8"));
  } catch {
    return { versions: {} };
  }
}

function writeManifest(data, opts = {}) {
  const file = manifestPath(opts);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  } catch {}
}

export function wakeStatus({ home = os.homedir() } = {}) {
  return installedCliVersions({ home }).map((version) => {
    const bin = cliBinaryPath(version, { home });
    const real = `${bin}${REAL_SUFFIX}`;
    return {
      version,
      installed: fs.existsSync(real) && fs.existsSync(bin) && !isMachO(bin),
      present: fs.existsSync(bin),
    };
  });
}

/**
 * Shim one version. Returns { ok, version, reason }. Never throws: a failure
 * must leave Claude Desktop exactly as it was.
 */
export function installDesktopWake(version, { home = os.homedir(), channels = "server:relay", log = () => {} } = {}) {
  const bin = cliBinaryPath(version, { home });
  const real = `${bin}${REAL_SUFFIX}`;
  if (!fs.existsSync(bin)) return { ok: false, version, reason: "cli_missing" };
  if (fs.existsSync(real) && !isMachO(bin)) return { ok: true, version, reason: "already_installed" };
  // Refuse anything that is not the untouched Mach-O: never shim a shim.
  if (!isMachO(bin)) return { ok: false, version, reason: "not_original_binary" };

  try {
    fs.renameSync(bin, real);
  } catch (err) {
    return { ok: false, version, reason: `rename_failed:${err.message}` };
  }
  try {
    fs.writeFileSync(bin, shimSource(real, channels), { mode: 0o755 });
    // Prove it before trusting it: the shim must launch the real CLI.
    const out = execFileSync(bin, ["--version"], { encoding: "utf8", timeout: 30_000 });
    if (!/\d+\.\d+\.\d+/.test(out)) throw new Error(`unexpected --version output: ${out.trim().slice(0, 80)}`);
  } catch (err) {
    // Roll back to the original, byte for byte.
    try {
      fs.rmSync(bin, { force: true });
      fs.renameSync(real, bin);
    } catch {}
    log(`desktop wake install failed for ${version}: ${err.message}`);
    return { ok: false, version, reason: `verify_failed:${err.message}` };
  }
  const manifest = readManifest({ home });
  manifest.versions[version] = { installedAt: new Date().toISOString(), channels, real };
  writeManifest(manifest, { home });
  log(`desktop wake installed for CLI ${version}`);
  return { ok: true, version, reason: "installed" };
}

/** Restore the original binary for one version. */
export function uninstallDesktopWake(version, { home = os.homedir(), log = () => {} } = {}) {
  const bin = cliBinaryPath(version, { home });
  const real = `${bin}${REAL_SUFFIX}`;
  if (!fs.existsSync(real)) return { ok: true, version, reason: "not_installed" };
  try {
    if (fs.existsSync(bin) && !isMachO(bin)) fs.rmSync(bin, { force: true });
    if (!fs.existsSync(bin)) fs.renameSync(real, bin);
    else fs.rmSync(real, { force: true }); // original already back in place
  } catch (err) {
    return { ok: false, version, reason: `restore_failed:${err.message}` };
  }
  const manifest = readManifest({ home });
  delete manifest.versions[version];
  writeManifest(manifest, { home });
  log(`desktop wake removed for CLI ${version}`);
  return { ok: true, version, reason: "removed" };
}

/**
 * Keep every installed CLI version shimmed. Desktop auto-updates into a new
 * version directory, which silently drops the shim — so the daemon calls this
 * periodically rather than treating installation as permanent.
 */
export function syncDesktopWake({ home = os.homedir(), channels = "server:relay", log = () => {} } = {}) {
  if (process.platform !== "darwin") return [];
  return installedCliVersions({ home }).map((version) =>
    installDesktopWake(version, { home, channels, log }),
  );
}

export function uninstallAllDesktopWake({ home = os.homedir(), log = () => {} } = {}) {
  return installedCliVersions({ home }).map((version) => uninstallDesktopWake(version, { home, log }));
}
