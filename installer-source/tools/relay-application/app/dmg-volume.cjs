"use strict";
// The "Install Relay" disk image Relay was opened from, and ejecting it once
// Relay has moved itself into Applications, so the install leaves nothing
// behind on the desktop (founder, 0.1.624, 2026-10-10).
//
// Electron's mover (app.moveToApplicationsFolder) already runs
// `sleep 5 && hdiutil detach` for the image it finds under the running app.
// It finds that image from the running path, so an app macOS translocated
// (run from a randomized read-only mirror of the image) leaves its image
// mounted. Relay therefore records which image it came from in the
// installation hand-off, and the copy in Applications ejects that one image if
// it is still there. Only an image mounted under /Volumes whose Relay is this
// exact build is ever ejected, never with -force; any failure (a file still
// open, already ejected) is ignored and never shown.
const path = require("node:path");

const TRANSLOCATED = /\/AppTranslocation\/[^/]+\/d\/[^/]+\.app$/;
const IDENTITY = ["appId", "applicationVersion", "version", "runtimeSourceSha", "packagingSourceSha"];

function sameBuild(found, ours) {
  return Boolean(found && ours) && found.appId === "work.relay.application" && IDENTITY.every(key => found[key] === ours[key]);
}

// Mount points of attached disk images, from `hdiutil info -plist` (as JSON).
function diskImageMounts(info) {
  const mounts = [];
  for (const image of Array.isArray(info?.images) ? info.images : []) {
    for (const entity of Array.isArray(image?.["system-entities"]) ? image["system-entities"] : []) {
      const mount = entity?.["mount-point"];
      if (typeof mount === "string" && /^\/Volumes\/[^/]+$/.test(mount)) mounts.push(mount);
    }
  }
  return mounts;
}

// The mounted image holding this running Relay, or null. A translocated app
// matches only when exactly one mounted image holds this exact build.
function sourceVolume({ bundlePath, candidate, mounts, readCandidate }) {
  const name = path.basename(bundlePath || "");
  if (!name.endsWith(".app")) return null;
  const holding = mounts.filter(mount => {
    try { return sameBuild(readCandidate(path.join(mount, name, "Contents", "Resources", "candidate.json")), candidate); }
    catch { return false; }
  });
  const direct = holding.find(mount => bundlePath === path.join(mount, name));
  if (direct) return direct;
  if (TRANSLOCATED.test(bundlePath) && holding.length === 1) return holding[0];
  return null;
}

function createVolumeTools({ execFile, readCandidate }) {
  const run = (command, args, input) => new Promise((resolve, reject) => {
    const child = execFile(command, args, { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => error ? reject(error) : resolve(String(stdout)));
    if (input !== undefined) child.stdin.end(input);
  });
  const attached = async () => {
    const plist = await run("/usr/bin/hdiutil", ["info", "-plist"]);
    return diskImageMounts(JSON.parse(await run("/usr/bin/plutil", ["-convert", "json", "-o", "-", "-"], plist)));
  };
  return {
    // Never throws: an unknown source just means nothing is ejected later.
    async find({ bundlePath, candidate }) {
      try { return sourceVolume({ bundlePath, candidate, mounts: await attached(), readCandidate }); } catch { return null; }
    },
    // "ejected", "gone" (already ejected) or "kept" (not ours, or busy).
    async eject({ mount, appName, candidate }) {
      try {
        if (typeof mount !== "string" || !/^\/Volumes\/[^/]+$/.test(mount) || !/^[^/]+\.app$/.test(appName || "")) return "kept";
        if (!(await attached()).includes(mount)) return "gone";
        if (!sameBuild(readCandidate(path.join(mount, appName, "Contents", "Resources", "candidate.json")), candidate)) return "kept";
        await run("/usr/bin/hdiutil", ["detach", mount]);
        return "ejected";
      } catch { return "kept"; }
    },
  };
}

module.exports = { diskImageMounts, sourceVolume, sameBuild, createVolumeTools };
