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
// Process birth identity is shared by launcher, worker and transaction locks.
// Keep it in this standalone stdlib host: a broken bundle must not disable it.
let selfIdentity;
let linuxBootClock;
function nativeIdentityBirth(identity) {
  const match = /^(?:win32|darwin):.*:(\d+)$/.exec(identity || "");
  if (match) return Number(match[1]);
  const linux = /^([a-f0-9-]{36}):(\d+)$/.exec(identity || "");
  if (linux && process.platform === "linux") {
    try {
      if (!linuxBootClock) {
        const boot = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
        const seconds = Number(fs.readFileSync("/proc/stat", "utf8").match(/^btime (\d+)$/m)?.[1]);
        const result = spawnSync("getconf", ["CLK_TCK"], { encoding: "utf8", timeout: 5000 });
        const ticks = Number(result.stdout);
        if (result.status === 0 && seconds > 0 && ticks > 0) linuxBootClock = { boot, seconds, ticks };
      }
      if (linuxBootClock?.boot === linux[1]) return linuxBootClock.seconds * 1000 + Number(linux[2]) * 1000 / linuxBootClock.ticks;
    } catch {}
  }
  return 0;
}
function nativeProcessIdentity(pid, { platform = process.platform, readFileSync = fs.readFileSync, run = spawnSync } = {}) {
  if (!Number.isSafeInteger(pid) || pid < 1) return "";
  const cacheable = pid === process.pid && platform === process.platform && readFileSync === fs.readFileSync && run === spawnSync;
  if (cacheable && selfIdentity) return selfIdentity;
  let identity = "";
  try {
    if (platform === "linux") identity = linuxProcessIdentity(pid, { platform, readFileSync });
    else if (platform === "win32") {
      const command = '$p=Get-Process -Id ' + pid + ' -ErrorAction Stop; $s=$p.StartTime.ToUniversalTime(); [Console]::Write($s.Ticks.ToString()+":"+([DateTimeOffset]$s).ToUnixTimeMilliseconds().ToString())';
      const result = run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { encoding: "utf8", windowsHide: true, timeout: 5000 });
      const value = String(result.stdout || "").trim();
      if (!result.error && result.status === 0 && /^\d+:\d+$/.test(value)) identity = 'win32:' + value;
    } else if (platform === "darwin") {
      const options = { encoding: "utf8", timeout: 5000, env: { ...process.env, LC_ALL: "C", TZ: "UTC0" } };
      const boot = run("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"], options);
      const birth = run("/bin/ps", ["-p", String(pid), "-o", "lstart="], options);
      const bootId = String(boot.stdout || "").trim(), at = Date.parse(String(birth.stdout || "").trim() + " UTC");
      if (!boot.error && boot.status === 0 && /^[a-f0-9-]{36}$/i.test(bootId) && !birth.error && birth.status === 0 && Number.isFinite(at)) identity = 'darwin:' + bootId + ':' + at;
    }
  } catch { /* Unknown is not evidence of a dead owner. */ }
  if (cacheable && identity) selfIdentity = identity;
  return identity;
}
function lockFail(message) { throw new Error(message); }

function processAlive(pid, {
  platform = process.platform,
  readFileSync = fs.readFileSync,
  kill = process.kill.bind(process),
} = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    kill(pid, 0);
    if (platform === "linux") {
      const details = linuxProcessDetails(pid, { platform, readFileSync });
      if (details && ["Z", "X", "x"].includes(details.state)) return false;
    }
    return true;
  }
  catch (error) { return error?.code === "EPERM"; }
}

function linuxProcessDetails(pid, {
  platform = process.platform,
  readFileSync = fs.readFileSync,
} = {}) {
  if (platform !== "linux" || !Number.isInteger(pid) || pid <= 0) return null;
  try {
    const bootId = String(readFileSync("/proc/sys/kernel/random/boot_id", "utf8")).trim();
    const stat = String(readFileSync(`/proc/${pid}/stat`, "utf8"));
    const commandEnd = stat.lastIndexOf(")");
    if (!bootId || commandEnd < 0) return null;
    // Fields after the parenthesized command start at field 3 (state); process
    // start time is field 22, so it is index 19 in this suffix.
    const fields = stat.slice(commandEnd + 1).trim().split(/\s+/);
    const state = fields[0];
    const startTicks = fields[19];
    if (!/^[A-Za-z]$/.test(state || "") || !/^\d+$/.test(startTicks || "")) return null;
    return { state, identity: `${bootId}:${startTicks}` };
  } catch {
    return null;
  }
}

function linuxProcessIdentity(pid, options = {}) {
  return linuxProcessDetails(pid, options)?.identity || "";
}

function canonicalLockOwnerState(owner, { isProcessAlive, processIdentity }) {
  const pid = Number(owner?.pid);
  if (!Number.isInteger(pid) || pid <= 0) return "unknown";
  if (!isProcessAlive(pid)) return "dead";
  const expectedIdentity = typeof owner?.processIdentity === "string" ? owner.processIdentity : "";
  const actualIdentity = processIdentity(pid);
  if (expectedIdentity && actualIdentity && actualIdentity !== expectedIdentity) return "dead";
  // Legacy records have no identity. A process born after the record was written
  // cannot own it. Never use elapsed lock age to evict a still-live process.
  const born = nativeIdentityBirth(actualIdentity);
  if (!expectedIdentity && born && owner.createdAt > 0 && born > owner.createdAt + 2000) return "dead";
  return "live";
}

function sameCanonicalLockGeneration(left, right, { requireBirth = false } = {}) {
  if (!left || !right || left.dev === undefined || left.ino === undefined
    || right.dev === undefined || right.ino === undefined) return false;
  const leftBirth = left.birthtimeNs ?? (left.birthtimeMs !== undefined ? Math.trunc(Number(left.birthtimeMs) * 1e6) : null);
  const rightBirth = right.birthtimeNs ?? (right.birthtimeMs !== undefined ? Math.trunc(Number(right.birthtimeMs) * 1e6) : null);
  const sameObject = String(left.dev) === String(right.dev) && String(left.ino) === String(right.ino);
  if (!sameObject) return false;
  const hasBirth = leftBirth !== null && rightBirth !== null
    && String(leftBirth) !== "0" && String(rightBirth) !== "0";
  return hasBirth ? String(leftBirth) === String(rightBirth) : !requireBirth;
}

function canonicalLockGenerationNonce(owner) {
  return typeof owner?.nonce === "string" && /^[0-9a-f]{32}$/.test(owner.nonce)
    ? owner.nonce
    : "";
}

function acquireCanonicalReclaimClaim(reclaimPath, {
  nonce,
  now,
  staleAfterMs = 30_000,
  readFileSync,
  writeFileSync,
  renameSync,
  rmSync,
  statSync,
  existsSync,
  isProcessAlive,
  processIdentity,
}) {
  const ownerProcessIdentity = processIdentity(process.pid);
  const claim = {
    pid: process.pid,
    nonce,
    createdAt: now(),
    ...(ownerProcessIdentity ? { processIdentity: ownerProcessIdentity } : {}),
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(reclaimPath, `${JSON.stringify(claim)}\n`, { mode: 0o600, flag: "wx" });
      return true;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (!existsSync(reclaimPath)) continue;
      let priorBytes = null;
      let prior = null;
      try {
        priorBytes = String(readFileSync(reclaimPath, "utf8"));
      } catch (error) {
        if (error?.code === "ENOENT") continue;
        return false;
      }
      try { prior = JSON.parse(priorBytes); } catch {}
      let priorAt = Number(prior?.createdAt || 0);
      if (!priorAt) {
        try { priorAt = Number(statSync(reclaimPath).mtimeMs || 0); } catch {}
      }
      const state = canonicalLockOwnerState(prior, { isProcessAlive, processIdentity });
      const stale = state === "dead" || (state === "unknown" && priorAt > 0 && now() - priorAt > staleAfterMs);
      if (!stale || attempt > 0) return false;
      const staleClaimPath = `${reclaimPath}.stale-${process.pid}-${nonce}`;
      try {
        renameSync(reclaimPath, staleClaimPath);
        const movedBytes = String(readFileSync(staleClaimPath, "utf8"));
        if (movedBytes !== priorBytes) {
          try { if (!existsSync(reclaimPath)) renameSync(staleClaimPath, reclaimPath); } catch {}
          return false;
        }
        rmSync(staleClaimPath, { force: true });
      } catch (error) {
        if (error?.code === "ENOENT") continue;
        throw error;
      }
    }
  }
  return false;
}

function acquireCanonicalLock(lockPath, {
  now = Date.now,
  // Preserve the shipped bootstrap's two-hour grace for incomplete records.
  // Legacy writers did not use exclusive publication or the reclaim handshake,
  // so a shorter default would let them resume into a successor lock. Complete
  // dead owners are still recovered immediately regardless of this value.
  staleAfterMs = 2 * 60 * 60_000,
  mkdirSync = fs.mkdirSync,
  readFileSync = fs.readFileSync,
  writeFileSync = fs.writeFileSync,
  renameSync = fs.renameSync,
  rmSync = fs.rmSync,
  readdirSync = fs.readdirSync,
  statSync = fs.statSync,
  existsSync = fs.existsSync,
  isProcessAlive = processAlive,
  processIdentity = (pid) => nativeProcessIdentity(pid, { readFileSync }),
} = {}) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const nonce = crypto.randomBytes(16).toString("hex");
  const ownerPath = path.join(lockPath, "owner.json");
  const reclaimPath = path.join(lockPath, "reclaim.json");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      mkdirSync(lockPath, { mode: 0o700 });
      let createdStat = null;
      try { createdStat = statSync(lockPath, { bigint: true }); } catch {}
      try {
        const ownerProcessIdentity = processIdentity(process.pid);
        const publishedOwnerBytes = `${JSON.stringify({
          pid: process.pid,
          nonce,
          createdAt: now(),
          operation: "bootstrap-setup",
          ...(ownerProcessIdentity ? { processIdentity: ownerProcessIdentity } : {}),
        })}\n`;
        writeFileSync(
          ownerPath,
          publishedOwnerBytes,
          { mode: 0o600, flag: "wx" },
        );
        // Publication and reclamation form a two-sided handshake. Check the
        // claim first: if a reclaimer already won, abort; if it arrives after
        // this check, its mandatory owner re-read will observe us as live.
        try {
          readFileSync(reclaimPath, "utf8");
          throw new Error("Relay lost canonical install lock ownership to a recovery claimant.");
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
        }
        let confirmedOwnerBytes = null;
        let confirmedStat = null;
        try { confirmedOwnerBytes = String(readFileSync(ownerPath, "utf8")); } catch {}
        try { confirmedStat = statSync(lockPath, { bigint: true }); } catch {}
        const comparableGeneration = createdStat?.dev !== undefined && createdStat?.ino !== undefined
          && confirmedStat?.dev !== undefined && confirmedStat?.ino !== undefined;
        if (confirmedOwnerBytes !== publishedOwnerBytes
          || (comparableGeneration && !sameCanonicalLockGeneration(createdStat, confirmedStat))) {
          throw new Error("Relay lost canonical install lock ownership while publishing its owner record.");
        }
      } catch (error) {
        // If a paused owner resumes after its ownerless directory was reclaimed,
        // wx prevents it from overwriting the successor. Never delete that newer
        // lock; clean up only our still-empty, provably identical generation.
        if (error?.code !== "EEXIST") {
          let currentStat = null;
          try { currentStat = statSync(lockPath, { bigint: true }); } catch {}
          if (!existsSync(ownerPath)
            && sameCanonicalLockGeneration(createdStat, currentStat, { requireBirth: true })) {
            try { rmSync(lockPath, { recursive: true, force: true }); } catch {}
          }
        }
        throw error;
      }
      try {
        const parent = path.dirname(lockPath);
        const prefix = `${path.basename(lockPath)}.stale-`;
        for (const entry of readdirSync(parent)) {
          if (String(entry).startsWith(prefix)) {
            try { rmSync(path.join(parent, entry), { recursive: true, force: true }); } catch {}
          }
        }
      } catch {}
      return {
        release() {
          let owner = null;
          try { owner = JSON.parse(readFileSync(ownerPath, "utf8")); } catch {}
          if (owner?.nonce === nonce) rmSync(lockPath, { recursive: true, force: true });
        },
      };
    } catch (error) {
      if (!["EEXIST", "ENOTEMPTY", "EPERM", "EACCES"].includes(error?.code)) throw error;
      if (!existsSync(lockPath)) {
        if (attempt === 0) continue;
        throw error;
      }
      let ownerBytes = null;
      let owner = null;
      try {
        ownerBytes = String(readFileSync(ownerPath, "utf8"));
      } catch (readError) {
        if (readError?.code !== "ENOENT") lockFail("Relay could not safely inspect the existing install lock.");
      }
      if (ownerBytes !== null) try { owner = JSON.parse(ownerBytes); } catch {}
      let observedStat = null;
      try { observedStat = statSync(lockPath, { bigint: true }); } catch {}
      let observedAt = Number(owner?.createdAt || 0);
      if (!observedAt) {
        observedAt = Number(observedStat?.mtimeMs || 0);
      }
      const ownerState = canonicalLockOwnerState(owner, { isProcessAlive, processIdentity });
      // A complete owner record whose exact process is gone can be recovered at
      // once. Only incomplete records need the age grace: another contender may
      // have observed the directory between mkdir and owner.json being written.
      const stale = ownerState === "dead"
        || (ownerState === "unknown" && observedAt > 0 && now() - observedAt > staleAfterMs);
      if (!stale || attempt > 0) lockFail("Another verified Relay install or update is already in progress.");

      // Serialize reclaimers inside this exact lock generation, then re-read the
      // owner after winning. This closes the race where one retry replaced the
      // lock while another retry was still acting on the previous owner's PID.
      let claimed = acquireCanonicalReclaimClaim(reclaimPath, {
        nonce,
        now,
        readFileSync,
        writeFileSync,
        renameSync,
        rmSync,
        statSync,
        existsSync,
        isProcessAlive,
        processIdentity,
      });
      if (!claimed) lockFail("Another verified Relay install or update is already in progress.");
      try {
        let confirmedOwnerBytes = null;
        let confirmedOwner = null;
        try {
          confirmedOwnerBytes = String(readFileSync(ownerPath, "utf8"));
        } catch (readError) {
          if (readError?.code !== "ENOENT") lockFail("Relay could not safely recheck the existing install lock.");
        }
        if (confirmedOwnerBytes !== null) try { confirmedOwner = JSON.parse(confirmedOwnerBytes); } catch {}
        let confirmedStat = null;
        try { confirmedStat = statSync(lockPath, { bigint: true }); } catch {}
        // Only a fully parsed random nonce supplies generation identity. Missing
        // or partial records can repeat across generations; without birth time,
        // inode reuse makes those indistinguishable, so fail closed.
        const ownerNonce = canonicalLockGenerationNonce(owner);
        const confirmedNonce = canonicalLockGenerationNonce(confirmedOwner);
        const requireBirth = !ownerNonce || ownerNonce !== confirmedNonce;
        const sameGeneration = sameCanonicalLockGeneration(observedStat, confirmedStat, { requireBirth })
          && ownerBytes === confirmedOwnerBytes;
        if (!sameGeneration) lockFail("Another verified Relay install or update is already in progress.");
        const confirmedAt = Number(confirmedOwner?.createdAt || observedAt || 0);
        const confirmedState = canonicalLockOwnerState(confirmedOwner, { isProcessAlive, processIdentity });
        const confirmedStale = confirmedState === "dead"
          || (confirmedState === "unknown" && confirmedAt > 0 && now() - confirmedAt > staleAfterMs);
        if (!confirmedStale) lockFail("Another verified Relay install or update is already in progress.");
        let confirmedClaim = null;
        try { confirmedClaim = JSON.parse(readFileSync(reclaimPath, "utf8")); } catch {}
        if (confirmedClaim?.nonce !== nonce) lockFail("Another verified Relay install or update is already in progress.");
        const stalePath = `${lockPath}.stale-${now()}-${process.pid}-${nonce}`;
        renameSync(lockPath, stalePath);
        claimed = false;
        try { rmSync(stalePath, { recursive: true, force: true }); } catch {}
      } finally {
        if (claimed) {
          let claim = null;
          try { claim = JSON.parse(readFileSync(reclaimPath, "utf8")); } catch {}
          if (claim?.nonce === nonce) {
            try { rmSync(reclaimPath, { force: true }); } catch {}
          }
        }
      }
    }
  }
  lockFail("Relay could not acquire its canonical install lock.");
}


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
function acquireLauncherLock(root, options = {}) {
  const lock = path.join(root, "launcher.lock");
  // Convert the old single-file lock under a separately serialized migration.
  // All new launchers pass through this gate; old launchers fail closed when
  // they meet the new directory, rather than unlinking a successor's owner.
  let migration;
  try {
    migration = acquireCanonicalLock(path.join(root, "launcher-migration.lock"), options);
    if (fs.existsSync(lock) && fs.statSync(lock).isFile()) {
      const bytes = fs.readFileSync(lock, "utf8"), createdAt = fs.statSync(lock).mtimeMs;
      let owner; try { owner = JSON.parse(bytes); } catch {}
      const state = canonicalLockOwnerState({ ...owner, createdAt }, {
        isProcessAlive: options.isProcessAlive || processAlive,
        processIdentity: options.processIdentity || nativeProcessIdentity,
      });
      const staleIncomplete = state === "unknown" && Date.now() - createdAt > 2 * 60 * 60_000;
      if (state !== "dead" && !staleIncomplete) return null;
      const archived = lock + '.legacy-' + crypto.randomUUID();
      fs.renameSync(lock, archived);
      // An older launcher does not know about the migration gate. If it
      // replaced the file meanwhile, restore its claim without overwriting any
      // subsequent owner, and do not enter recovery alongside it.
      if (fs.readFileSync(archived, "utf8") !== bytes) {
        try { fs.linkSync(archived, lock); } catch (error) { if (error.code !== "EEXIST") throw error; }
        return null;
      }
    }
    const acquired = acquireCanonicalLock(lock, options);
    return () => acquired.release();
  } catch { return null; }
  finally { migration?.release(); }
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
        if (["current", "ahead"].includes(report.status) && report.runtimeHealthy === true && report.runtimeProven === true) {
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
      const retryableReport = ["disabled", "backoff", "emergency-backoff", "restart-failed", "reactivate-failed", "service-repair-failed", "service-repair-unhealthy"].includes(report?.status) || (report?.status === "failed" && networkFailure);
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
module.exports = { launch, validPointer, read, write, acquireLauncherLock, appendRecoveryLog, acquireCanonicalLock, processAlive, nativeProcessIdentity, nativeIdentityBirth };
if (require.main === module) launch().then(result => { process.exitCode = result.ok ? 0 : 1; }).catch(e => { console.error(e.message); process.exitCode = 1; });
