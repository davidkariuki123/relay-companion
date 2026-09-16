"use strict";
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const bootstrap = require("./relay-setup.cjs");
const { applicationOwner } = require("./application-owner.cjs");
function write(file, value) {
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600, flag: "wx" });
  fs.renameSync(tmp, file);
}

async function uninstallFromApplication({ applicationRoot, confirmed = false, homeDir = os.homedir(),
  allowUnconfigured = false,
  acquireLock = bootstrap.acquireCanonicalLock, run = spawnSync,
  drain = require("./update-activity.cjs").drainCalls } = {}) {
  if (!confirmed) throw new Error("Application removal requires the person's confirmation");
  if (path.resolve(homeDir) !== path.resolve(os.homedir()) && run === spawnSync) throw new Error("Remove Relay from the user's own login session");
  const owner = applicationOwner({ homeDir });
  let installedRoot = path.resolve(applicationRoot);
  try { installedRoot = fs.realpathSync(applicationRoot); } catch { /* An already removed package may be absent. */ }
  const root = path.join(homeDir, ".relay");
  const journalFile = path.join(root, "application-uninstall.json");
  if (!owner) {
    let previous;
    try { previous = JSON.parse(fs.readFileSync(journalFile, "utf8")); } catch {}
    if (previous?.schema === 1 && previous.state === "complete" && previous.applicationRoot === installedRoot) return { ok: true, alreadyRemoved: true };
    if (allowUnconfigured) {
      let recorded;
      try { recorded = JSON.parse(fs.readFileSync(path.join(root, "application-owner.json"), "utf8")); }
      catch (error) { if (error.code === "ENOENT") return { ok: true, unconfigured: true }; throw error; }
      if (typeof recorded.root === "string" && path.resolve(recorded.root) !== installedRoot) return { ok: true, unconfigured: true };
    }
    throw new Error("This application does not own the current installation");
  }
  if (owner.root !== installedRoot) throw new Error("Another application owns Relay");
  const lock = acquireLock(path.join(root, "runtime", "transaction.lock"));
  let releaseDrain;
  try {
    const pointerFile = path.join(root, "runtime", "current.json");
    const pointer = JSON.parse(fs.readFileSync(pointerFile, "utf8"));
    let interrupted;
    try { interrupted = JSON.parse(fs.readFileSync(journalFile, "utf8")); } catch {}
    if (pointer.active === false && pointer.state === "inactive" && pointer.applicationUninstalled === owner.installationId
      && interrupted?.schema === 1 && interrupted.state === "removing" && interrupted.installationId === owner.installationId
      && interrupted.previous?.releaseId === pointer.releaseId) {
      write(journalFile, { ...interrupted, state: "complete", completedAt: Date.now() });
      return { ok: true, alreadyRemoved: true };
    }
    const current = bootstrap.activeCanonicalCli({ homeDir });
    if (!current) throw new Error("The installed runtime needs repair before its integrations can be removed");
    const journal = { schema: 1, state: "removing", installationId: owner.installationId, applicationRoot: owner.root, previous: pointer, at: Date.now() };
    write(journalFile, journal);
    releaseDrain = await drain({ homeDir });
    // Default uninstall removes services/MCP/managed skills, but keeps account,
    // credentials, messages, encryption keys and protocol authorization. Never
    // pass --purge from an application installer or package-manager hook.
    const result = run(current.node, [current.bin, "uninstall", "--no-trampoline"], { stdio: "inherit", windowsHide: true, timeout: 5 * 60_000 });
    if (result.error || result.status !== 0) throw new Error("Relay integration removal was incomplete; retry before deleting the application");
    write(pointerFile, { ...pointer, active: false, state: "inactive", applicationUninstalled: owner.installationId });
    write(journalFile, { ...journal, state: "complete", completedAt: Date.now() });
    return { ok: true, accountDataPreserved: true, protocolAuthorizationPreserved: true };
  } finally { releaseDrain?.(); lock.release(); }
}
module.exports = { uninstallFromApplication };
