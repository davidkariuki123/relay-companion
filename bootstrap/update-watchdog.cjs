"use strict";
// The guardian does not load the application's module graph. A broken import or
// blocked worker event loop cannot disable its deadline.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execute } = require("./recovery-runner.cjs");

// launchd and systemd-run redirect the whole worker tree to ~/.relay/update.log.
// Windows launches through WMI, which cannot redirect stdio, and the worker's
// console is hidden — so without this the setup script's progress lines vanish.
function updateLogStdio(platform = process.platform, homeDir = os.homedir()) {
  if (platform !== "win32") return { stdio: "inherit", logPath: null };
  const logPath = path.join(homeDir, ".relay", "update.log");
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const fd = fs.openSync(logPath, "a");
    return { stdio: ["ignore", fd, fd], logPath };
  } catch {
    return { stdio: "inherit", logPath: null };
  }
}

if (require.main === module) {
  const [entry, mode, payload] = process.argv.slice(2);
  if (!entry || mode !== "--worker" || !payload) throw Error("Missing update worker arguments");
  const { stdio, logPath } = updateLogStdio();
  execute(process.execPath, entry, [mode, payload], { stdio }).catch(error => {
    const line = `[relay-update] ${error.message}`;
    console.error(line);
    if (logPath) { try { fs.appendFileSync(logPath, `${line}\n`); } catch {} }
    // launchd must not resurrect a failed attempt with a stale target.
    process.exitCode = 0;
  });
}

module.exports = { updateLogStdio };
