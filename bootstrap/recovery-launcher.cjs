"use strict";
// Keep this launcher stdlib-only: the selected recovery bundle may not even load.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");
function read(file) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } }
function write(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(data) + "\n", { mode: 0o600 });
  fs.renameSync(temp, file);
}
function validPointer(p, root) {
  return p?.schema === 1 && /^\d+\.\d+\.\d+$/.test(p.version || "")
    && typeof p.bundle === "string" && /^[a-f0-9]{64}$/.test(path.basename(p.bundle))
    && path.dirname(p.bundle) === path.join(root, "versions")
    && typeof p.node === "string" && path.resolve(p.node).startsWith(path.join(root, "node") + path.sep);
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch(e) { return e.code !== "ESRCH"; } }
function stop(child) {
  if (!Number.isSafeInteger(child.pid) || child.pid < 1) return;
  if (process.platform === "win32") {
    spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", timeout: 15_000 });
  } else {
    const rows = spawnSync("/bin/ps", ["-axo", "uid=,pid=,ppid="], { encoding: "utf8", timeout: 5000 });
    const descendants = new Set([child.pid]);
    const entries = rows.status === 0 ? String(rows.stdout).split("\n").map(x => x.trim().split(/\s+/).map(Number)).filter(([uid]) => uid === process.getuid()) : [];
    let added;
    do { added = false; for (const [,pid,parent] of entries) if (descendants.has(parent) && !descendants.has(pid)) { descendants.add(pid); added = true; } } while (added);
    for (const pid of [...descendants].reverse()) { try { process.kill(pid, "SIGKILL"); } catch {} }
    try { process.kill(-child.pid, "SIGKILL"); } catch {}
  }
}
function runChild(pointer, { root, runId, timeoutMs, env = process.env }) {
  return new Promise(resolve => {
    let expired = false;
    const child = spawn(pointer.node, [path.join(pointer.bundle, "bootstrap", "recovery-runner.cjs")], {
      stdio: "inherit", windowsHide: true, detached: process.platform !== "win32",
      env: { ...env, RELAY_RECOVERY_RUN_ID: runId },
    });
    const timer = setTimeout(() => { expired = true; stop(child); }, timeoutMs);
    child.once("error", () => { clearTimeout(timer); resolve({ ok: false, reason: "launch-failed" }); });
    child.once("exit", code => { clearTimeout(timer); resolve({ ok: code === 0 && !expired, reason: expired ? "deadline" : "exit" }); });
  });
}
function acquireLauncherLock(root) {
  // Launcher ownership is separate from the transaction/recovery locks. A failed
  // child must actually exit before the fallback gets a chance to own those locks.
  const lock = path.join(root, "launcher.lock");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const owner = read(lock);
  if (owner && Number.isSafeInteger(owner.pid) && owner.pid > 0 && alive(owner.pid)) return null;
  if (fs.existsSync(lock)) fs.rmSync(lock);
  const nonce = crypto.randomUUID();
  try { fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, nonce }), { flag: "wx", mode: 0o600 }); }
  catch (e) { if (e.code === "EEXIST") return null; throw e; }
  return () => { if (read(lock)?.nonce === nonce) fs.rmSync(lock, { force: true }); };
}
// One line per launcher decision in recovery/recovery.log, shared with the
// runner. Reconstructing a bad hour from status.json snapshots alone took an
// hour of timestamp archaeology; the log makes it a two-minute read.
const LOG_MAX_BYTES = 512 * 1024;
function appendRecoveryLog(root, line, now = Date.now) {
  try {
    const file = path.join(root, "recovery.log");
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    try { if (fs.statSync(file).size > LOG_MAX_BYTES) fs.renameSync(file, `${file}.1`); } catch {}
    fs.appendFileSync(file, `${new Date(now()).toISOString()} ${line}\n`, { mode: 0o600 });
  } catch {}
}
async function launch({ root = __dirname, run = runChild, now = Date.now, env = process.env, timeoutMs = 25 * 60_000, attemptTimeoutMs = 12 * 60_000 } = {}) {
  const release = acquireLauncherLock(root);
  if (!release) return { ok: true, status: "already-running" };
  const log = (line) => appendRecoveryLog(root, `launcher ${line}`, now);
  try {
    const selected = read(path.join(root, "current.json"));
    const good = read(path.join(root, "known-good.json"));
    const quarantine = read(path.join(root, "launcher-status.json"));
    const candidates = [selected, good, read(path.join(root, "previous-good.json"))]
      .filter((p, i, all) => validPointer(p, root) && all.findIndex(x => x?.bundle === p.bundle) === i);
    if (quarantine?.failedBundle === selected?.bundle && quarantine.retryAt > now() && validPointer(good, root) && good.bundle !== selected.bundle) {
      candidates.sort((a,b) => Number(a.bundle === selected.bundle) - Number(b.bundle === selected.bundle));
    }
    const started = now();
    // Only a bundle that failed on its own merits is quarantined. A deadline that
    // interrupted a runner mid-download or mid-restart says the machine was slow,
    // not that the code was bad; the next check must try the selected bundle again.
    let failedBundle = null;
    for (const candidate of candidates) {
      if (candidate.bundle !== selected?.bundle) {
        // Backoff recorded by the rejected engine must not prevent the proven
        // fallback from attempting the same repair with different code.
        const previous = read(path.join(root, "status.json"));
        if (previous?.retryAt) write(path.join(root, "status.json"), { ...previous, retryAt: 0 });
      }
      const attemptAt = now(), runId = crypto.randomUUID();
      // Keep the whole launcher inside the OS scheduler deadline, including fallback.
      const remaining = Math.max(100, timeoutMs - (now() - started));
      const attemptTimeout = Math.min(attemptTimeoutMs, remaining);
      log(`attempt bundle=${candidate.version} run=${runId} timeoutMs=${attemptTimeout}`);
      const result = await run(candidate, { root, runId, env, timeoutMs: attemptTimeout });
      const report = read(path.join(root, "status.json"));
      const reported = report?.checkedAt >= attemptAt && report.launcherVersion === candidate.version
        && (!report.runId || report.runId === runId); // pre-launcher stock releases
      log(`result bundle=${candidate.version} run=${runId} ok=${result.ok} reason=${result.reason || "-"} reported=${reported ? report.status : "none"} elapsedMs=${now() - attemptAt}`);
      if (result.ok && reported && report.ok !== false) {
        if (["current", "ahead"].includes(report.status) && report.runtimeHealthy === true) {
          const previous = read(path.join(root, "known-good.json"));
          if (validPointer(previous, root) && previous.bundle !== candidate.bundle) write(path.join(root, "previous-good.json"), previous);
          write(path.join(root, "known-good.json"), candidate);
        }
        const fallback = selected?.bundle !== candidate.bundle;
        const quarantined = fallback ? failedBundle : null;
        const completionStatus = fallback ? "fallback" : ["current", "ahead"].includes(report.status) && report.runtimeHealthy === true ? "healthy" : "runner-completed";
        write(path.join(root, "launcher-status.json"), { schema: 1, at: now(), status: completionStatus, runtimeStatus: report.status,
          version: candidate.version, failedBundle: quarantined, retryAt: quarantined ? now() + 60 * 60_000 : null });
        log(`done status=${completionStatus} quarantined=${quarantined ? "yes" : "no"}`);
        return { ok: true, status: completionStatus };
      }
      // A live runner reporting a download/configuration error is still running.
      // Don't discard a healthy engine just because its network is unavailable.
      // The same goes for a failed in-place repair: the runner has a restart
      // budget and a re-activation rung to spend on the next check. Falling back
      // to an older bundle here would hand the problem to a runner that only
      // knows how to download.
      const networkFailure = /fetch failed|offline|ENOTFOUND|ECONN|ETIMEDOUT|manifest-http-|channel-discovery-http-|download.*(timed out|stalled|ended early|failed after)|configuration-unavailable/i.test(report?.lastError || "");
      const retryableReport = ["disabled", "backoff", "restart-failed", "reactivate-failed", "service-repair-failed", "service-repair-unhealthy"].includes(report?.status) || (report?.status === "failed" && networkFailure);
      if (reported && retryableReport && result.reason !== "deadline") {
        write(path.join(root, "launcher-status.json"), { schema: 1, at: now(), status: "runner-error", version: candidate.version });
        log("done status=runner-error");
        return { ok: false, status: "runner-error" };
      }
      // A runner that reported progress before the deadline cut it off was
      // working, not broken. Only a silent hang or a real failure condemns a bundle.
      const interruptedWhileWorking = result.reason === "deadline" && reported && report.ok !== false;
      if (!interruptedWhileWorking) failedBundle ||= candidate.bundle;
      if (now() - started >= timeoutMs) break;
    }
    write(path.join(root, "launcher-status.json"), { schema: 1, at: now(), status: "failed", failedBundle, retryAt: failedBundle ? now() + 60 * 60_000 : null });
    log(`done status=failed quarantined=${failedBundle ? "yes" : "no"}`);
    return { ok: false, status: "failed" };
  } finally { release(); }
}
module.exports = { launch, validPointer, read, write, acquireLauncherLock, appendRecoveryLog };
if (require.main === module) launch().then(result => { process.exitCode = result.ok ? 0 : 1; }).catch(e => { console.error(e.message); process.exitCode = 1; });
