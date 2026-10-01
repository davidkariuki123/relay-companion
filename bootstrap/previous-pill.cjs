"use strict";
// The installer's setup leaves the existing Relay running while it downloads,
// so a failed download still leaves a working Relay. Its pill, though, stayed
// on screen beside the setup window looking active (Shane, 2026-10-02). Hide
// only the old pill when setup starts; the background service keeps running
// until activation switches over and starts the new pill. If setup fails, the
// previous Relay opens its pill again.
const { spawnSync, spawn } = require("node:child_process");

const MAC_PILL_LABEL = "work.relay.companion.pill";
// Every stock pill runs relay-companion's overlay/main.cjs under Electron.
const WINDOWS_STOP_PILL_PS = [
  "$p=Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {",
  "  $_.CommandLine -and ($_.CommandLine -match '[\\\\/]relay-companion[\\\\/]') -and ($_.CommandLine -match '[\\\\/]overlay[\\\\/]main')",
  "}; foreach($x in $p){ try { Invoke-CimMethod -InputObject $x -MethodName Terminate -ErrorAction Stop | Out-Null } catch {} }",
].join(" ");

function hidePreviousPill({ current, platform = process.platform, uid = process.getuid?.(), run = spawnSync, launch = spawn } = {}) {
  let hidden = false;
  try {
    if (platform === "win32") {
      const result = run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_STOP_PILL_PS], { windowsHide: true, timeout: 60_000 });
      hidden = !result?.error && result?.status === 0;
    } else if (platform === "darwin") {
      // launchd keeps the pill alive, so stop its job rather than its process.
      const result = run("/bin/launchctl", ["bootout", `gui/${uid}/${MAC_PILL_LABEL}`], { timeout: 30_000 });
      hidden = !result?.error && result?.status === 0;
    } else {
      const result = run("pkill", ["-u", String(uid), "-f", "relay-companion/overlay/main"], { timeout: 30_000 });
      hidden = !result?.error && result?.status === 0;
    }
  } catch { hidden = false; }
  return {
    hidden,
    // Only an active previous runtime can reopen its own pill.
    restore() {
      if (!hidden || current?.active !== true || typeof current.node !== "string" || typeof current.bin !== "string") return false;
      try {
        const child = launch(current.node, [current.bin, "pill"], { detached: true, stdio: "ignore", windowsHide: true });
        child.unref?.();
        return true;
      } catch { return false; }
    },
  };
}

module.exports = { hidePreviousPill, WINDOWS_STOP_PILL_PS, MAC_PILL_LABEL };
