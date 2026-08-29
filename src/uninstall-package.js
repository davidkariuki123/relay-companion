import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { managedInstallInfo, PACKAGE_NAME } from "./auto-update.js";
import { isCanonicalPackageRoot } from "./canonical-runtime.js";

function commandResult(result) {
  if (result?.ok === true || result?.ok === false) return result;
  return {
    ok: !result?.error && result?.status === 0,
    status: result?.status ?? null,
    out: `${result?.stdout || ""}${result?.stderr || ""}`.trim(),
    missing: Boolean(result?.error?.code === "ENOENT"),
  };
}

/**
 * Remove only the npm-global package that launched this uninstall. A checkout
 * or arbitrary project dependency is never an ownership boundary.
 */
export function uninstallManagedCompanionPackage({
  runningRoot,
  shimRoot = "",
  platform = process.platform,
  homeDir = os.homedir(),
  env = process.env,
  existsSync = fs.existsSync,
  runCommand = spawnSync,
  attempts = 3,
  sleep = (ms) => {
    const signal = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(signal, 0, 0, Math.max(1, ms));
  },
} = {}) {
  const roots = [shimRoot, runningRoot].map((value) => String(value || "").trim()).filter(Boolean);
  let owned = roots
    .map((root) => managedInstallInfo(root, { home: homeDir, platform, exists: existsSync }))
    .find((candidate) => candidate?.global);
  // A durable ~/.local/bin/relay can enter the canonical runtime directly,
  // without the npm trampoline metadata. In that one installed-runtime shape,
  // discover npm's global root so the old entry package is not stranded.
  if (!owned && isCanonicalPackageRoot(runningRoot, { homeDir, platform })) {
    const defaultNpm = platform === "win32" ? "npm.cmd" : "npm";
    const rootResult = commandResult(runCommand(
      defaultNpm,
      ["root", "--global"],
      { encoding: "utf8", timeout: 20_000, windowsHide: true, env },
    ));
    if (!rootResult.ok) {
      return {
        ok: false,
        attempts: 1,
        detail: rootResult.out || "Could not locate npm's global Relay package.",
      };
    }
    const globalRoot = String(rootResult.out || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1);
    const pathApi = platform === "win32" ? path.win32 : path.posix;
    const candidateRoot = globalRoot ? pathApi.resolve(globalRoot, PACKAGE_NAME) : "";
    if (!candidateRoot || !existsSync(candidateRoot)) {
      return { ok: true, skipped: true, alreadyAbsent: true, reason: "global_package_absent", attempts: 0 };
    }
    owned = managedInstallInfo(candidateRoot, { home: homeDir, platform, exists: existsSync });
    if (!owned?.global) {
      return { ok: false, attempts: 1, detail: `Refused an unverified npm package path: ${candidateRoot}.` };
    }
  }
  if (!owned) return { ok: true, skipped: true, reason: "not_global", attempts: 0 };

  const npmCmd = platform === "win32" && existsSync(path.win32.join(owned.prefix, "npm.cmd"))
    ? path.win32.join(owned.prefix, "npm.cmd")
    : "npm";
  const limit = Math.max(1, Number(attempts) || 1);
  const history = [];
  for (let attempt = 1; attempt <= limit; attempt += 1) {
    const raw = runCommand(
      npmCmd,
      ["uninstall", "--global", "--prefix", owned.prefix, PACKAGE_NAME],
      { encoding: "utf8", timeout: 10 * 60 * 1000, windowsHide: true, env },
    );
    const result = commandResult(raw);
    history.push(result);
    if (!existsSync(owned.packageRoot)) {
      return { ok: true, removed: true, packageRoot: owned.packageRoot, prefix: owned.prefix, attempts: attempt, history };
    }
    if (attempt < limit) sleep(200 * attempt);
  }
  const last = history.at(-1);
  return {
    ok: false,
    packageRoot: owned.packageRoot,
    prefix: owned.prefix,
    attempts: history.length,
    history,
    detail: last?.out || `The package still exists at ${owned.packageRoot}.`,
  };
}
