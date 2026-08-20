// Atomic JSON persistence shared by the ESM companion and the CommonJS pill.
//
// Windows can transiently reject an otherwise valid rename while Defender,
// indexing, or another reader still has the destination open. The temp file is
// already complete at that point, so retrying the same atomic replacement is
// safe. Keep the retry window bounded: a real permissions or filesystem error
// must still reach the caller instead of wedging an always-on process.

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const TRANSIENT_RENAME_CODES = new Set(["EACCES", "EBUSY", "EEXIST", "EPERM"]);
const DEFAULT_RETRY_DELAYS_MS = Object.freeze([10, 25, 50, 100, 200]);

function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      // Last-resort fallback for runtimes without Atomics.wait on this thread.
    }
  }
}

function atomicWriteFileSync(
  targetPath,
  contents,
  {
    fsImpl = fs,
    mode = 0o600,
    retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
    sleep = sleepSync,
  } = {},
) {
  fsImpl.mkdirSync(path.dirname(targetPath), { recursive: true, mode: 0o700 });
  const nonce = Math.random().toString(16).slice(2);
  const tmp = `${targetPath}.${process.pid}.${Date.now()}.${nonce}.tmp`;
  let committed = false;
  try {
    fsImpl.writeFileSync(tmp, contents, { mode });
    for (let attempt = 0; ; attempt += 1) {
      try {
        fsImpl.renameSync(tmp, targetPath);
        committed = true;
        return targetPath;
      } catch (error) {
        const retryable = TRANSIENT_RENAME_CODES.has(String(error?.code || ""));
        if (!retryable || attempt >= retryDelaysMs.length) throw error;
        sleep(Math.max(0, Number(retryDelaysMs[attempt]) || 0));
      }
    }
  } finally {
    if (!committed) {
      try {
        fsImpl.rmSync(tmp, { force: true });
      } catch {}
    }
  }
}

function atomicWriteJsonSync(targetPath, value, options = {}) {
  const space = Object.hasOwn(options, "space") ? options.space : 2;
  return atomicWriteFileSync(targetPath, `${JSON.stringify(value, null, space)}\n`, options);
}

module.exports = {
  DEFAULT_RETRY_DELAYS_MS,
  TRANSIENT_RENAME_CODES,
  atomicWriteFileSync,
  atomicWriteJsonSync,
};
