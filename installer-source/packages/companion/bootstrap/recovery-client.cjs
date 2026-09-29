"use strict";
// Observation is not permission to edit service registrations. Wake the
// independently installed controller and let it judge the current generation.
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { spawnSync } = require("node:child_process");
const { atomicFile } = require("./mac-registration-transaction.cjs");
const { resolveManagedNode, nodeEnvironment } = require("./node-contract.cjs");
const { lifecycleOwnership } = require("./lifecycle-ownership.cjs");
const { Worker, isMainThread, workerData, parentPort } = require("node:worker_threads");
const ok = r => !r?.error && (r?.status === 0 || r?.ok === true);

function requestRecovery({ homeDir = os.homedir(), platform = process.platform, reason = "health-check",
  packageRoot, node, env = process.env, now = Date.now,
  run = (file, args, options) => spawnSync(file, args, { encoding: "utf8", windowsHide: true, timeout: 15_000, ...options }),
  install = options => require("./recovery-install.cjs").installRecovery(options),
  own = lifecycleOwnership, userId = process.getuid?.() ?? 0 } = {}) {
  const root = path.join(homeDir, ".relay", "recovery");
  if (require("./recovery-intent.cjs").stopped(homeDir)) return { ok: false, reason: "intentionally-stopped" };
  const label = "work.relay.companion.recovery", task = "Relay Companion Recovery";
  const query = platform === "win32" ? ["schtasks.exe", ["/Query", "/TN", task]]
    : platform === "darwin" ? ["/bin/launchctl", ["print", `gui/${userId}/${label}`]]
    : ["systemctl", ["--user", "show", "--property=LoadState", "--value", `${label}.service`]];
  const observed = run(...query);
  const text = String(observed?.stdout ?? observed?.out ?? "");
  const present = ok(observed) && (platform !== "linux" || text.trim() === "loaded");
  if (!present) {
    // A failed query is not proof of absence. In particular, do not rewrite a
    // launch agent because its GUI domain is temporarily unavailable at login.
    const detail = String(observed?.stderr ?? observed?.out ?? "");
    const missing = !observed?.error && (platform === "darwin"
      ? observed.status === 113 || /Could not find service/i.test(detail)
      : platform === "linux" ? text.trim() === "not-found"
      : /cannot find|does not exist|not found/i.test(detail));
    if (!missing || !packageRoot) return { ok: false, reason: "recovery-registration-unavailable" };
    let lease;
    try {
      lease = own({ homeDir, env });
      const interpreter = resolveManagedNode({ homeDir, node, run, env });
      lease.assert();
      const result = install({ packageRoot, node: interpreter, homeDir, platform, reload: true, runCommand: run });
      if (!result.ok) return { ok: false, reason: result.reason, detail: result.detail };
    } catch (error) { return { ok: false, reason: "recovery-bootstrap-deferred", detail: error.message }; }
    finally { lease?.release(); }
  }
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  atomicFile(path.join(root, "request.json"), JSON.stringify({ schema: 1, reason, at: now() }));
  const command = platform === "win32" ? ["schtasks.exe", ["/Run", "/TN", task]]
    : platform === "darwin" ? ["/bin/launchctl", ["kickstart", `gui/${userId}/${label}`]]
    : ["systemctl", ["--user", "start", "--no-block", `${label}.service`]];
  const submitted = run(...command, { env: nodeEnvironment(env) });
  return { ok: ok(submitted), reason: ok(submitted) ? "recovery-requested" : "recovery-start-failed",
    detail: ok(submitted) ? "" : String(submitted?.error?.message || submitted?.stderr || submitted?.out || "") };
}
// launchctl, Task Scheduler and interpreter verification must never block the
// Electron event loop whose responsiveness we are trying to preserve.
function requestRecoveryAsync(options = {}) {
  return new Promise((resolve) => {
    const worker = new Worker(__filename, { workerData: { relayRecoveryRequest: options } });
    let settled = false;
    const finish = result => { if (!settled) { settled = true; clearTimeout(timer); resolve(result); } };
    const timer = setTimeout(() => {
      void worker.terminate();
      finish({ ok: false, reason: "recovery-request-deadline" });
    }, 120_000);
    worker.once("message", finish);
    worker.once("error", error => finish({ ok: false, reason: "recovery-request-failed", detail: error.message }));
    worker.once("exit", () => finish({ ok: false, reason: "recovery-request-exited" }));
  });
}
if (!isMainThread && workerData?.relayRecoveryRequest) {
  try { parentPort.postMessage(requestRecovery(workerData.relayRecoveryRequest)); }
  catch (error) { parentPort.postMessage({ ok: false, reason: "recovery-request-failed", detail: error.message }); }
}
module.exports = { requestRecovery, requestRecoveryAsync };
