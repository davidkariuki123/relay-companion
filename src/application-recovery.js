// Invoked only from a newly verified runtime under the installer's live lease.
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runUninstall, electronProfileDirs } from "./install.js";
import { readConfig } from "./config.js";
import { RelayClient } from "./client.js";
import credentials from "./credential-store.cjs";
import { deleteInstallationAuthorizationCredentials } from "./installation-authorization.js";
import recovery from "../bootstrap/application-recovery.cjs";
import lifecycle from "../bootstrap/lifecycle-ownership.cjs";
import onboarding from "./desktop-onboarding.cjs";

export async function resetApplication({ homeDir = os.homedir(), releaseRoot,
  uninstall = runUninstall, config = readConfig, revoke = () => new RelayClient().revokeSelf({ timeoutMs: 5000 }),
  deleteToken = credentials.deleteDeviceToken, deleteAuthorizations = deleteInstallationAuthorizationCredentials,
  reset = recovery.resetState, profiles = electronProfileDirs, lease = lifecycle.lifecycleOwnership,
} = {}) {
  const ownership = lease({ homeDir });
  try {
    const file = recovery.journalPath(homeDir);
    const journal = recovery.marker(file);
    if (!ownership.delegated || journal?.schema !== 1 || journal.state !== "cleaning" || journal.releaseRoot !== releaseRoot) throw Error("Installer recovery has no active owner");
    const profileDirs = profiles({ homeDir, env: {} });
    for (const target of [path.join(homeDir, ".relay"), path.join(homeDir, ".relay-companion"), ...profileDirs, releaseRoot]) recovery.assertLocalPath(homeDir, target);
    // The installer running this recovery owns the Start Menu shortcut.
    const stopped = uninstall({ homeDir, env: ownership.env, keepWindowsShortcut: true });
    if (!stopped.ok) throw Error(`Could not remove old Relay services or integrations: ${stopped.failures.map(step => step.id).join(", ")}`);
    ownership.assert();
    let cfg = {};
    try { cfg = config(); } catch { /* Damaged config must not prevent local recovery. */ }
    let retirement = journal.deviceRetirement || "not-paired";
    if (cfg.deviceToken) {
      try { await revoke(); retirement = "revoked"; }
      catch (error) { retirement = error.status === 401 ? "already-revoked" : "needs-account-review"; }
    }
    // Keep only the result, never the old credential, in the surviving journal.
    recovery.writeJournal(homeDir, { ...journal, deviceRetirement: retirement });
    if (retirement === "needs-account-review") console.warn("The old device could not be retired online. After signing in, remove its old registration in Relay Settings > Devices.");
    const token = deleteToken({ account: cfg.credentialAccount || "device-token" });
    const authorization = deleteAuthorizations();
    if (!token.ok || !authorization.ok) throw Error("Could not clear Relay's local credentials; retry this installer");
    ownership.assert();
    reset({ homeDir, releaseRoot, profileDirs });
    ownership.assert();
    onboarding.createRunStore(path.join(homeDir, ".relay")).write(onboarding.initialRun());
  } finally { ownership.release(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const releaseRoot = process.argv[2];
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  if (!releaseRoot || packageRoot !== path.join(releaseRoot, "node_modules", "relay-companion")) throw Error("Recovery must run from the staged candidate");
  await resetApplication({ releaseRoot });
}
