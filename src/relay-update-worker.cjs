// Keep this entry point dependency-free: diagnostics must survive a failure
// while loading the full updater's module graph on a cold Windows release.
const fs = require("node:fs");
const path = require("node:path");

async function main(payload) {
  const options = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  const api = options.platform === "win32" ? path.win32 : path.posix;
  const expected = api.join(options.homeDir, ".relay", "runtime", "update-requests", `${options.requestId}.json`);
  if (!options.requestId || !options.workerId || api.resolve(options.requestPath || "") !== api.resolve(expected)) {
    throw new Error("Invalid update worker request path");
  }
  const logPath = api.join(options.homeDir, ".relay", "update.log");
  const log = (message) => {
    try { fs.appendFileSync(logPath, `[relay-update] ${new Date().toISOString()} request=${options.requestId} ${message}\n`); } catch {}
  };
  const write = (extra) => {
    const current = JSON.parse(fs.readFileSync(options.requestPath, "utf8"));
    if (current.requestId !== options.requestId || current.workerId !== options.workerId || current.state === "rejected") return;
    const temporary = `${options.requestPath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify({ ...current, ...extra })}\n`, { mode: 0o600 });
    fs.renameSync(temporary, options.requestPath);
  };
  const startedAt = Date.now();
  log(`worker starting; pid=${process.pid}`);
  process.on("exit", (code) => log(`worker exited; code=${code}; elapsed=${Date.now() - startedAt}ms`));
  try {
    write({ workerPid: process.pid, stage: "loading-worker", stageStartedAt: startedAt });
    const { workerMain } = await import("./canonical-updater.js");
    await workerMain(payload);
  } catch (error) {
    log(`worker startup failed: ${error?.stack || error}`);
    try {
      write({ state: "failed", completedAt: Date.now(), result: { ok: false, phase: "worker", reason: "worker-startup-failed", detail: String(error?.message || error).slice(0, 2000) } });
    } catch (writeError) { log(`could not record worker failure: ${writeError?.message || writeError}`); }
  }
  // launchd must not respawn the same failed transaction indefinitely.
  process.exitCode = 0;
}

if (process.argv[2] === "--worker" && process.argv[3]) {
  main(process.argv[3]).catch((error) => {
    console.error(`[relay-update] invalid worker launch: ${error?.message || error}`);
    process.exitCode = 0;
  });
}
