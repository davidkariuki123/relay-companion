// Executed from a signature-verified download or a validated, previously
// installed release. Normal updates and recovery share the canonical lock.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCanonicalUpdateTransaction } from "./canonical-updater.js";
import { updateChannel } from "./config.js";

export async function runRecovery(version, channel) {
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
  if (manifest.version !== version || updateChannel() !== channel) throw new Error("Recovery release or channel changed");
  const execute = () => runCanonicalUpdateTransaction({ version, runningVersion: version, runningPackageRoot: packageRoot,
    requestId: /^[a-f0-9-]{36}$/i.test(process.env.RELAY_RECOVERY_ATTEMPT_ID || "") ? process.env.RELAY_RECOVERY_ATTEMPT_ID : null,
    supersedeBrokenRecovery: true,
    repairExecutableOverride: { bin: path.join(packageRoot, "bin", "relay.js"), node: process.execPath },
    installCandidate: async ({ stagingRoot }) => {
      fs.cpSync(path.resolve(packageRoot, "../.."), stagingRoot, { recursive: true, dereference: false, verbatimSymlinks: true });
      return { ok: true, source: "verified-recovery-runtime" };
    }, log: (line) => console.log(`[recovery] ${line}`) });
  let result = await execute();
  // A recovered journal restores service first; then advance to the selected fix.
  if (result.ok && result.recovered) result = await execute();
  if (!result.ok) throw new Error(`${result.phase}: ${result.reason}: ${result.detail || ""}`);
  return result;
}
if (process.env.RELAY_RECOVERY_WORKER === "1") {
  runRecovery(process.argv[2], process.argv[3]).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
