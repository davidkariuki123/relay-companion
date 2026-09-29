"use strict";
const os = require("node:os");
const { installedServiceProcessRows, exactRuntimeHealth } = require("./runtime-health.cjs");
const { prepareSnapshot, restoreSnapshot, readSnapshot } = require("./mac-registration-transaction.cjs");
const { acquireMacPowerAssertion } = require("./mac-power-assertion.cjs");

async function macActivationTransaction(target, operation, {
  homeDir = os.homedir(), run, sleep, restoreRegistrations = false, allowRebuildRegistrations = false,
  acquirePower = acquireMacPowerAssertion, prepare = prepareSnapshot,
  restore = restoreSnapshot, snapshot = readSnapshot, healthCheck = exactRuntimeHealth,
} = {}) {
  let releasePower;
  let mutationStarted = false;
  try {
    // Before repair-runtime can rewrite even one plist, prove process discovery
    // works and confirm the idle-sleep assertion actually exists.
    if (!restoreRegistrations) {
      const probe = installedServiceProcessRows(target, { run, includeTarget: true });
      if (!probe.ok) return { ...probe, unchanged: true };
    }
    releasePower = await acquirePower();
    if (restoreRegistrations && snapshot({ homeDir })) {
      mutationStarted = true;
      return await restore({ homeDir, run, sleep, expectedRoot: target.packageRoot, healthCheck });
    }
    // Stock versions predating snapshots still use canonical journal recovery.
    // All new forward activations preserve the registrations before mutation.
    if (!restoreRegistrations) prepare(target, { homeDir, run, allowRebuildRegistrations });
    mutationStarted = true;
    const result = await operation();
    return { ...result, unchanged: false };
  } catch (error) {
    return { ok: false, reason: error.message, unchanged: !mutationStarted };
  } finally { releasePower?.(); }
}
module.exports = { macActivationTransaction };
