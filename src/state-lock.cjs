// Cross-process advisory lock for read-modify-write cycles on a shared JSON file.
//
// state.json is mutated by FOUR processes (the daemon staging rows, the pill overlay
// acking/answering, the `relay open` CLI remembering materializations, and the MCP
// server) — each doing read -> modify -> atomic-rename write. Unsynchronized, two
// interleaved cycles silently drop one side's update: a freshly staged relay
// vanishes from the pill (the daemon's ledger will not re-stage it), a read row
// flips back to unread, an answered question resurrects its reply box.
//
// mkdir is atomic on every platform we ship to; the lock directory sits next to the
// file. Writers hold it for single-digit milliseconds. On timeout we proceed WITHOUT
// the lock (a rare lost update beats a wedged pill), and stale locks left by crashed
// processes are stolen after `staleMs`.
//
// CommonJS so both the ESM daemon modules and the CJS Electron overlay share one
// implementation.

const fs = require("node:fs");

function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      /* last-resort spin */
    }
  }
}

function acquireJsonLock(targetPath, { timeoutMs = 2000, staleMs = 10000 } = {}) {
  const lockPath = `${targetPath}.lock`;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      fs.mkdirSync(lockPath, { recursive: false });
      return function release() {
        try {
          fs.rmdirSync(lockPath);
        } catch {}
      };
    } catch (error) {
      if (!error || error.code !== "EEXIST") {
        // Parent dir missing, permissions, read-only fs: don't block the write path.
        return function release() {};
      }
      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > staleMs) {
          try {
            fs.rmdirSync(lockPath);
          } catch {}
          continue;
        }
      } catch {
        continue; // lock vanished between mkdir and stat; retry immediately
      }
      if (Date.now() > deadline) return function release() {};
      sleepSync(5);
    }
  }
}

function withJsonLock(targetPath, fn, opts) {
  const release = acquireJsonLock(targetPath, opts);
  try {
    return fn();
  } finally {
    release();
  }
}

// Strict variant for writers whose lost update is UNRECOVERABLE (the daemon's
// staging path: once the ledger marks a relay processed it is never re-staged,
// so a clobbered write means a permanently invisible relay). Returns
// { ok:false } instead of proceeding unlocked; the caller retries next poll.
function withJsonLockStrict(targetPath, fn, { timeoutMs = 2000, staleMs = 10000 } = {}) {
  const lockPath = `${targetPath}.lock`;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      fs.mkdirSync(lockPath, { recursive: false });
      break;
    } catch (error) {
      if (!error || error.code !== "EEXIST") return { ok: false, reason: String((error && error.code) || "lock-error") };
      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > staleMs) {
          try {
            fs.rmdirSync(lockPath);
          } catch {}
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() > deadline) return { ok: false, reason: "timeout" };
      sleepSync(5);
    }
  }
  try {
    return { ok: true, value: fn() };
  } finally {
    try {
      fs.rmdirSync(lockPath);
    } catch {}
  }
}

module.exports = { acquireJsonLock, withJsonLock, withJsonLockStrict };
