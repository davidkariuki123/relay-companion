// Bounded log files for the always-on surfaces.
//
// WHY IN-PLACE TRUNCATION, NOT RENAME:
//
//   Nothing in Relay owns the log file handles. `daemon.log` and `pill.log` are
//   written by redirection configured OUTSIDE the process — launchd's
//   StandardOutPath/StandardErrorPath on darwin, systemd append targets on
//   Linux, and the `>> "<log>" 2>&1` baked into each Scheduled Task action on
//   win32 (see install.js).
//
//   Both open the file in APPEND mode and hold the descriptor for the life of
//   the service. Renaming the file (the classic logrotate move) therefore does
//   NOT give us a fresh log: on darwin the descriptor follows the inode, so the
//   service happily keeps writing gigabytes into `daemon.log.1` while the new
//   `daemon.log` stays empty forever. Truncating the same inode to zero is what
//   an append-mode writer actually respects — every subsequent write seeks to
//   the (now zero) end of file.
//
//   The cost is that the tail is copied out before truncation rather than moved,
//   so peak disk is maxBytes + keepBytes per log. That is the price of not
//   owning the descriptor, and it is small at these sizes.
//
// WHY AT ALL: an update that can never complete retried every two minutes
// indefinitely and grew one user's daemon.log to 40 MB (field report, Shane
// 2026-08-11). The retry loop is fixed separately in auto-update.js, but an
// unbounded always-on log is a bug in its own right — a machine left running
// for months should not need a human with `rm`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Big enough to hold days of ordinary daemon chatter (a quiet day is a few
// hundred KB), small enough that reading one is still practical.
export const DEFAULT_MAX_LOG_BYTES = 8 * 1024 * 1024;
// How much of the tail survives a rotation, in <file>.1. The most recent lines
// are the diagnostically valuable ones; the first megabyte of a months-old log
// never is.
export const DEFAULT_KEEP_BYTES = 1 * 1024 * 1024;

// The always-on logs, all under ~/.relay. update.log is included because the
// same stuck-update loop that bloats daemon.log also appends to it every lap —
// and so is update.native.log, which that loop feeds on Windows for the same reason.
export function defaultLogPaths(homeDir = os.homedir()) {
  const dir = path.join(homeDir, ".relay");
  return [
    path.join(dir, "daemon.log"),
    path.join(dir, "pill.log"),
    path.join(dir, "update.log"),
    path.join(dir, "update.native.log"),
    path.join(dir, "perf.log"),
    path.join(dir, "logs", "broker.log"),
  ];
}

/**
 * Rotate one log if it has grown past `maxBytes`.
 *
 * Returns a small result describing what happened, so the caller can log it
 * once rather than silently reclaiming a user's disk.
 */
export function rotateLogIfLarge(
  file,
  {
    maxBytes = DEFAULT_MAX_LOG_BYTES,
    keepBytes = DEFAULT_KEEP_BYTES,
    now = () => new Date(),
    fsImpl = fs,
  } = {},
) {
  let size = 0;
  try {
    const stat = fsImpl.statSync(file);
    if (!stat.isFile()) return { file, rotated: false, reason: "not-a-file" };
    size = stat.size;
  } catch {
    return { file, rotated: false, reason: "missing" };
  }
  if (size <= maxBytes) return { file, rotated: false, reason: "under-limit", size };

  // Read only the tail we intend to keep — never the whole (possibly 40 MB) file.
  const keep = Math.max(0, Math.min(keepBytes, size));
  let tail = Buffer.alloc(0);
  if (keep > 0) {
    let fd = null;
    try {
      fd = fsImpl.openSync(file, "r");
      const buf = Buffer.alloc(keep);
      const read = fsImpl.readSync(fd, buf, 0, keep, size - keep);
      tail = buf.subarray(0, read);
    } catch {
      tail = Buffer.alloc(0);
    } finally {
      if (fd !== null) {
        try {
          fsImpl.closeSync(fd);
        } catch {}
      }
    }
    // Drop the partial first line so the archive starts cleanly.
    const nl = tail.indexOf(0x0a);
    if (nl >= 0 && nl + 1 < tail.length) tail = tail.subarray(nl + 1);
  }

  const archive = `${file}.1`;
  try {
    fsImpl.writeFileSync(archive, tail);
  } catch {
    // An unwritable archive must not stop us reclaiming the disk: losing old log
    // lines is strictly better than filling the volume.
  }

  try {
    // Truncate the SAME inode (see the header note) so the append-mode writers
    // held by launchd / Task Scheduler start again from zero.
    fsImpl.truncateSync(file, 0);
  } catch {
    return { file, rotated: false, reason: "truncate-failed", size };
  }

  try {
    fsImpl.appendFileSync(
      file,
      `[relay] ${now().toISOString()} log rotated at ${size} bytes (limit ${maxBytes}); previous tail kept in ${path.basename(archive)}\n`,
    );
  } catch {}

  return { file, rotated: true, size, keptBytes: tail.length, archive };
}

export function rotateLogs({
  files = defaultLogPaths(),
  maxBytes = DEFAULT_MAX_LOG_BYTES,
  keepBytes = DEFAULT_KEEP_BYTES,
  log = () => {},
} = {}) {
  const results = [];
  for (const file of files) {
    let result;
    try {
      result = rotateLogIfLarge(file, { maxBytes, keepBytes });
    } catch (error) {
      result = { file, rotated: false, reason: "threw", detail: error?.message || String(error) };
    }
    results.push(result);
    if (result.rotated) {
      log(`rotated ${path.basename(file)} at ${(result.size / (1024 * 1024)).toFixed(1)} MB`);
    }
  }
  return results;
}

/**
 * Check the logs periodically for the life of the daemon. Hourly is ample: these
 * files grow by megabytes per week in normal operation, and only a pathological
 * loop makes them grow fast — which is exactly the case the cap exists for.
 */
export function startLogRotation({
  intervalMs = 60 * 60 * 1000,
  files = defaultLogPaths(),
  maxBytes = DEFAULT_MAX_LOG_BYTES,
  keepBytes = DEFAULT_KEEP_BYTES,
  log = () => {},
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
} = {}) {
  const run = () => rotateLogs({ files, maxBytes, keepBytes, log });
  run(); // reclaim immediately on boot — a stuck machine may already be at 40 MB
  const timer = setIntervalImpl(run, intervalMs);
  if (timer && typeof timer.unref === "function") timer.unref();
  return { run, timer, stop: () => clearIntervalImpl(timer) };
}
