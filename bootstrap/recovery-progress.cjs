"use strict";
const fs = require("node:fs"), path = require("node:path");
const { atomicFile } = require("./mac-registration-transaction.cjs");

function repairProgress(homeDir, now = Date.now) {
  const file = path.join(homeDir, ".relay", "recovery", "repair-progress.json");
  let state, damaged = false;
  try { state = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) {
    if (error.code !== "ENOENT") {
      // Preserve damaged evidence and advance to replacement, rather than grant
      // a fresh restart budget on every invocation that cannot parse it.
      state = { schema: 1, attempts: {}, localExhausted: true, lastError: "repair-progress-unreadable" };
      damaged = true;
    }
  }
  if (!state) state = { schema: 1, attempts: {} };
  if (state.schema !== 1 || !state.attempts || typeof state.attempts !== "object" || Array.isArray(state.attempts)
    || Object.values(state.attempts).some(value => !Number.isSafeInteger(value) || value < 0 || value > 2)) {
    state = { schema: 1, attempts: {}, localExhausted: true, lastError: "repair-progress-invalid" };
    damaged = true;
  }
  if (damaged) {
    const evidence = `${file}.${require("node:crypto").randomUUID()}.damaged`;
    fs.copyFileSync(file, evidence, fs.constants.COPYFILE_EXCL);
  }
  const save = () => atomicFile(file, JSON.stringify({ ...state, updatedAt: now() }));
  if (damaged) save();
  return {
    count: key => Number(state.attempts[key]) || 0,
    claim(key, limit) {
      if (state.localExhausted || (Number(state.attempts[key]) || 0) >= limit) return false;
      state.attempts[key] = (Number(state.attempts[key]) || 0) + 1;
      // Reserve before invoking a process: its death must not reset the budget.
      save(); return true;
    },
    refund(key) { state.attempts[key] = Math.max(0, (Number(state.attempts[key]) || 0) - 1); save(); },
    fail(reason) { state.lastError = String(reason || "runtime-not-healthy").slice(0, 400); save(); },
    reset() { state = { schema: 1, attempts: {} }; save(); },
    get exhausted() { return state.localExhausted === true; },
  };
}
module.exports = { repairProgress };
