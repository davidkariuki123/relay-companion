import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`Missing ${name}`);
  return process.argv[index + 1];
}

const packageRoot = path.resolve(argument("--package-root"));
const currentVersion = argument("--current-version");
const targetVersion = argument("--target-version");

for (const [label, value] of [["current", currentVersion], ["target", targetVersion]]) {
  if (!/^\d+\.\d+\.\d+$/.test(value)) throw new Error(`Invalid ${label} version: ${value}`);
}

const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
if (packageJson.name !== "relay-companion" || packageJson.version !== currentVersion) {
  throw new Error(`Stock package identity mismatch at ${packageRoot}`);
}

const updaterUrl = pathToFileURL(path.join(packageRoot, "src", "auto-update.js"));
updaterUrl.searchParams.set("candidate_test", String(Date.now()));
const { createAutoUpdater } = await import(updaterUrl.href);
if (typeof createAutoUpdater !== "function") {
  throw new Error(`Relay ${currentVersion} does not expose its stock updater seam`);
}

const updater = createAutoUpdater({
  env: { ...process.env, RELAY_ALLOW_SANDBOX_AUTHORIZATION: "1" },
  packageRoot,
  getCurrentVersion: () => currentVersion,
  getOnDiskVersion: () => currentVersion,
  getCurrentChannel: () => "stable",
  getLatestVersion: async () => targetVersion,
  checkIntervalMs: 0,
  restartCooldownMs: 0,
  useFailureBackoff: false,
  log: (message) => console.log(`[stock-updater] ${message}`),
});

const result = await updater.tick();
console.log(JSON.stringify(result));

const accepted = new Set([
  "updating",
  "migrating-runtime",
  "rescuing-runtime",
  "recovering-runtime",
  "repairing-runtime",
  "repointing-autostart",
  "in-flight",
  "migration-in-flight",
  "activation-in-flight",
  "recovery-in-flight",
]);
if (!accepted.has(result?.status)) {
  throw new Error(`Stock updater did not launch the candidate transaction: ${result?.status || "unknown"}`);
}

const requestPath = result?.launch?.requestPath;
if (requestPath) {
  const deadline = Date.now() + 20 * 60_000;
  let request = null;
  while (Date.now() < deadline) {
    try {
      request = JSON.parse(fs.readFileSync(requestPath, "utf8"));
    } catch {}
    if (["completed", "failed", "rejected"].includes(request?.state)) break;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  console.log(JSON.stringify({ updateRequest: request }));
  if (request?.state !== "completed" || request?.result?.ok !== true) {
    throw new Error(
      `Stock updater transaction did not complete: ${request?.state || "timeout"}` +
        `${request?.result?.phase ? ` at ${request.result.phase}` : ""}` +
        `${request?.result?.reason ? ` (${request.result.reason})` : ""}`,
    );
  }
  // The request becomes terminal just before the supervised worker exits. A real
  // daemon's next poll naturally occurs later; the canary may start a second
  // migration/update phase immediately, so explicitly wait for the old owner to
  // leave instead of misclassifying that short handoff as a busy updater.
  const workerPid = Number(request?.lockOwner?.pid) || 0;
  if (workerPid > 0) {
    const exitDeadline = Date.now() + 30_000;
    while (Date.now() < exitDeadline) {
      try {
        process.kill(workerPid, 0);
      } catch (error) {
        if (error?.code === "ESRCH") break;
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    try {
      process.kill(workerPid, 0);
      throw new Error(`Stock updater worker ${workerPid} did not exit after its completed transaction`);
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }
}
