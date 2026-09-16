"use strict";
const path = require("node:path"), os = require("node:os");
const { read } = require("../bootstrap/application-handoff.cjs");
const { verifyApplicationRelease, verifyApplicationArtifact } = require("../bootstrap/application-release.cjs");
const rollout = require("../bootstrap/application-rollout.cjs");

// Local installer status is never a Relay message or a server notification.
async function pendingInstaller({ homeDir = os.homedir(), platform = process.platform, arch = process.arch, trustStore } = {}) {
  const root = path.join(homeDir, ".relay");
  const status = read(path.join(root, "application-update.json"));
  if (status?.state !== "installer-action-required" || !/^\d+\.\d+\.\d+$/.test(status.version || "")
    || !/^[a-f0-9]{40}$/.test(status.sourceSha || "")) return null;
  const key = `${platform}-${arch}`;
  const directory = path.join(root, "application-packages", `${status.version}-${status.sourceSha}-${key}`);
  const payload = verifyApplicationRelease(read(path.join(directory, "manifest.json")), {
    version: status.version, sourceSha: status.sourceSha, ...(trustStore ? { trustStore } : {}),
  });
  const artifact = payload.artifacts[key]?.find(item => ["deb", "rpm", "zip"].includes(item.kind)
    && status.artifact === path.join(directory, `installer.${item.kind}`));
  if (!artifact) return null;
  await verifyApplicationArtifact(status.artifact, artifact);
  return { version: payload.version, file: status.artifact };
}
function startInstallerNotices({ enabled = rollout.enabled, Notification, shell, setIntervalImpl = setInterval,
  pending = pendingInstaller } = {}) {
  if (enabled !== true) return null;
  let busy = false, shown = "";
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const offer = await pending();
      if (!offer || shown === offer.version || !Notification.isSupported()) return;
      const notice = new Notification({ title: "Relay installer ready", body: "Relay is still running. Click to find the verified update, install it using your computer's normal installer, then open Relay." });
      notice.on("click", async () => {
        try { const current = await pending(); if (current?.file === offer.file) shell.showItemInFolder(current.file); } catch { /* A changed or missing file must not be opened. */ }
      });
      notice.show(); shown = offer.version;
    } catch { /* Installer checks own diagnostics; never interrupt messaging. */ }
    finally { busy = false; }
  };
  const timer = setIntervalImpl(tick, 60_000); timer.unref?.();
  void tick();
  return timer;
}
module.exports = { pendingInstaller, startInstallerNotices };
