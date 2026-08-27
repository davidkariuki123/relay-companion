#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const LINUX_SANDBOX_ROOT = "/usr/local/lib/relay/chromium-sandboxes";

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
}

function sha256File(file, { readFileSync = fs.readFileSync } = {}) {
  return crypto.createHash("sha256").update(readFileSync(file)).digest("hex");
}

function regularFile(file, { lstatSync = fs.lstatSync, realpathSync = fs.realpathSync } = {}) {
  try {
    const stat = lstatSync(file);
    return stat.isFile() && !stat.isSymbolicLink() && path.resolve(realpathSync(file)) === path.resolve(file);
  } catch {
    return false;
  }
}

export function linuxElectronSandboxPlan(electronPath, {
  platform = process.platform,
  destinationRoot = LINUX_SANDBOX_ROOT,
  lstatSync = fs.lstatSync,
  realpathSync = fs.realpathSync,
  readFileSync = fs.readFileSync,
} = {}) {
  if (platform !== "linux") return { ok: true, skipped: true, reason: "not-linux" };
  const executable = path.resolve(String(electronPath || ""));
  if (!path.isAbsolute(executable) || !regularFile(executable, { lstatSync, realpathSync })) {
    throw new Error(`Pinned Linux Electron executable is missing or unsafe: ${executable || "missing"}`);
  }
  const source = path.join(path.dirname(executable), "chrome-sandbox");
  if (!regularFile(source, { lstatSync, realpathSync })) {
    throw new Error(`Pinned Electron sandbox helper is missing or unsafe: ${source}`);
  }
  const size = Number(lstatSync(source).size || 0);
  if (size < 1 || size > 16 * 1024 * 1024) {
    throw new Error(`Pinned Electron sandbox helper has an implausible size: ${size}`);
  }
  const sha256 = sha256File(source, { readFileSync });
  const root = path.resolve(destinationRoot);
  const destination = path.join(root, sha256, "chrome-sandbox");
  return { ok: true, skipped: false, electronPath: executable, source, sha256, root, destination };
}

export function trustedLinuxElectronSandbox(destination, sha256, {
  lstatSync = fs.lstatSync,
  realpathSync = fs.realpathSync,
  readFileSync = fs.readFileSync,
} = {}) {
  try {
    const stat = lstatSync(destination);
    return stat.isFile() &&
      !stat.isSymbolicLink() &&
      path.resolve(realpathSync(destination)) === path.resolve(destination) &&
      Number(stat.uid) === 0 &&
      (Number(stat.mode) & 0o4777) === 0o4755 &&
      sha256File(destination, { readFileSync }) === sha256;
  } catch {
    return false;
  }
}

function trustedRootDirectory(directory, {
  lstatSync = fs.lstatSync,
  realpathSync = fs.realpathSync,
} = {}) {
  const stat = lstatSync(directory);
  return stat.isDirectory() &&
    !stat.isSymbolicLink() &&
    path.resolve(realpathSync(directory)) === path.resolve(directory) &&
    Number(stat.uid) === 0 &&
    (Number(stat.mode) & 0o022) === 0;
}

export function installLinuxElectronSandboxAsRoot(plan, {
  uid = typeof process.getuid === "function" ? process.getuid() : -1,
  fsImpl = fs,
  randomBytes = crypto.randomBytes,
  expectedSha256 = plan?.sha256,
} = {}) {
  if (uid !== 0) throw new Error("Linux Electron sandbox installation must run as root");
  if (!plan?.ok || plan.skipped || !/^[a-f0-9]{64}$/.test(String(plan.sha256 || ""))) {
    throw new Error("Invalid Linux Electron sandbox installation plan");
  }
  const sourceHash = sha256File(plan.source, { readFileSync: fsImpl.readFileSync.bind(fsImpl) });
  if (sourceHash !== plan.sha256 || plan.sha256 !== expectedSha256) {
    throw new Error("Electron sandbox helper changed before installation");
  }

  fsImpl.mkdirSync(plan.root, { recursive: true, mode: 0o755 });
  if (!trustedRootDirectory(plan.root, {
    lstatSync: fsImpl.lstatSync.bind(fsImpl),
    realpathSync: fsImpl.realpathSync.bind(fsImpl),
  })) throw new Error(`Refusing untrusted sandbox directory: ${plan.root}`);
  fsImpl.chownSync(plan.root, 0, 0);
  fsImpl.chmodSync(plan.root, 0o755);

  const destinationDirectory = path.dirname(plan.destination);
  fsImpl.mkdirSync(destinationDirectory, { recursive: true, mode: 0o755 });
  if (!trustedRootDirectory(destinationDirectory, {
    lstatSync: fsImpl.lstatSync.bind(fsImpl),
    realpathSync: fsImpl.realpathSync.bind(fsImpl),
  })) throw new Error(`Refusing untrusted sandbox version directory: ${destinationDirectory}`);
  fsImpl.chownSync(destinationDirectory, 0, 0);
  fsImpl.chmodSync(destinationDirectory, 0o755);

  const temporary = path.join(destinationDirectory, `.chrome-sandbox-${process.pid}-${randomBytes(8).toString("hex")}`);
  try {
    fsImpl.copyFileSync(plan.source, temporary, fs.constants.COPYFILE_EXCL);
    fsImpl.chownSync(temporary, 0, 0);
    fsImpl.chmodSync(temporary, 0o755);
    if (sha256File(temporary, { readFileSync: fsImpl.readFileSync.bind(fsImpl) }) !== plan.sha256) {
      throw new Error("Copied Electron sandbox helper failed its content check");
    }
    fsImpl.chmodSync(temporary, 0o4755);
    fsImpl.renameSync(temporary, plan.destination);
  } finally {
    try { fsImpl.rmSync(temporary, { force: true }); } catch {}
  }
  if (!trustedLinuxElectronSandbox(plan.destination, plan.sha256, {
    lstatSync: fsImpl.lstatSync.bind(fsImpl),
    realpathSync: fsImpl.realpathSync.bind(fsImpl),
    readFileSync: fsImpl.readFileSync.bind(fsImpl),
  })) throw new Error("Installed Electron sandbox helper failed its ownership, mode, or content check");
  return plan.destination;
}

export function prepareLinuxElectronSandbox({
  electronPath,
  platform = process.platform,
  env = process.env,
  destinationRoot = LINUX_SANDBOX_ROOT,
  uid = typeof process.getuid === "function" ? process.getuid() : -1,
  fsImpl = fs,
  spawn = spawnSync,
  execPath = process.execPath,
  scriptPath = fileURLToPath(import.meta.url),
} = {}) {
  const dependencies = {
    lstatSync: fsImpl.lstatSync.bind(fsImpl),
    realpathSync: fsImpl.realpathSync.bind(fsImpl),
    readFileSync: fsImpl.readFileSync.bind(fsImpl),
  };
  const plan = linuxElectronSandboxPlan(electronPath, { platform, destinationRoot, ...dependencies });
  if (plan.skipped) return plan;
  if (!trustedLinuxElectronSandbox(plan.destination, plan.sha256, dependencies)) {
    if (uid === 0) {
      installLinuxElectronSandboxAsRoot(plan, { uid, fsImpl });
    } else {
      const elevated = spawn("sudo", [
        "--", execPath, scriptPath, "--install-root",
        "--electron-path", plan.electronPath,
        "--expected-sha256", plan.sha256,
      ], {
        encoding: "utf8",
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (elevated.error || elevated.status !== 0) {
        throw new Error(`Could not provision Electron's root-owned sandbox helper (${elevated.error?.message || String(elevated.stderr || elevated.stdout || elevated.status).trim()}).`);
      }
    }
  }
  if (!trustedLinuxElectronSandbox(plan.destination, plan.sha256, dependencies)) {
    throw new Error("Electron sandbox helper is not the exact root-owned 4755 binary expected by this runtime");
  }
  env.CHROME_DEVEL_SANDBOX = plan.destination;
  return { ...plan, prepared: true };
}

function main() {
  const electronPath = option("--electron-path");
  if (process.argv.includes("--install-root")) {
    const plan = linuxElectronSandboxPlan(electronPath);
    const expectedSha256 = option("--expected-sha256");
    if (!/^[a-f0-9]{64}$/.test(expectedSha256)) throw new Error("Missing exact expected Electron sandbox digest");
    installLinuxElectronSandboxAsRoot(plan, { expectedSha256 });
    return;
  }
  const prepared = prepareLinuxElectronSandbox({ electronPath });
  if (!prepared.skipped) process.stdout.write(`${prepared.destination}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
