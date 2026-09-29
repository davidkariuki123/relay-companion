"use strict";
const { spawn, spawnSync } = require("node:child_process");

// Idle sleep prevention is a best effort supplement to the durable journal.
// Lid-close, shutdown and power loss must remain recoverable without this child.
async function acquireMacPowerAssertion({ spawnImpl = spawn, run = (cmd, args) => spawnSync(cmd, args, { encoding: "utf8", timeout: 3000 }),
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), processId = process.pid } = {}) {
  const child = spawnImpl("/usr/bin/caffeinate", ["-i", "-w", String(processId)], { stdio: "ignore", windowsHide: true });
  let failed = false, released = false;
  child.once("error", () => { failed = true; });
  child.once("exit", () => { failed = true; });
  const release = () => { if (!released) { released = true; child.kill(); } };
  try {
    for (let attempt = 0; attempt < 10; attempt++) {
      if (failed) break;
      const result = run("/usr/bin/pmset", ["-g", "assertions"]);
      if (!result?.error && result?.status === 0 && String(result.stdout).split("\n").some(line =>
        line.includes(`pid ${child.pid}(caffeinate)`) && line.includes("PreventUserIdleSystemSleep"))) return release;
      await sleep(100);
    }
    throw Error("idle-sleep-assertion-unavailable");
  } catch (error) { release(); throw error; }
}
module.exports = { acquireMacPowerAssertion };
