"use strict";
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { installFromApplication, reconcileApplication } = require("./installer/bootstrap/application-install.cjs");
const { uninstallFromApplication } = require("./installer/bootstrap/application-uninstall.cjs");
const [action, applicationRoot, executable, recoveryMode] = process.argv.slice(2);
if (!["install", "reconcile", "uninstall", "uninstall-package"].includes(action) || !path.isAbsolute(applicationRoot || "") || !path.isAbsolute(executable || "")) {
  throw new Error("Invalid application setup command");
}
const resourcesDir = __dirname;
const candidate = require(path.join(resourcesDir, "candidate.json"));
if (candidate.distribution !== "application" || candidate.activationEnabled !== true) throw new Error("Preview activation is disabled");
if (action === "install" && candidate.desktopOnboarding) {
  const directory = process.env.RELAY_CONFIG_DIR || path.join(os.homedir(), ".relay");
  if (!fs.existsSync(path.join(directory, "config.json"))) {
    const { initialRun, createRunStore } = require("./installer/src/desktop-onboarding.cjs");
    const store = createRunStore(directory);
    if (!store.read()) store.write(initialRun());
  }
}
const controller = new AbortController();
let canCancel = false;
let lastProgressAt = 0;
const onMessage = message => { if (canCancel && message?.action === "cancel-download") controller.abort(); };
process.on("message", onMessage);
const onProgress = progress => {
  canCancel = progress.canCancel;
  if (progress.phase === "downloading" && progress.receivedBytes > 0 && progress.receivedBytes < progress.totalBytes
    && Date.now() - lastProgressAt < 100) return;
  lastProgressAt = Date.now();
  if (process.connected) process.send({ type: "setup-progress", ...progress }, () => {});
};
(action === "reconcile" ? reconcileApplication() : ["uninstall", "uninstall-package"].includes(action)
  ? uninstallFromApplication({ applicationRoot, confirmed: true, allowUnconfigured: action === "uninstall-package" })
  : installFromApplication({ resourcesDir, applicationRoot, executable, activationEnabled: true, allowRecovery: recoveryMode !== "--preserve-state", onProgress, signal: controller.signal }))
  .then((result) => { if (result.ok === false) throw new Error(result.reason || result.state); })
  .catch((error) => { console.error(error.message); process.exitCode = controller.signal.aborted ? 2 : 1; })
  .finally(() => { process.removeListener("message", onMessage); if (process.connected) process.disconnect(); });
