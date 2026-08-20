"use strict";

const fs = require("node:fs");
const { isMainThread, parentPort, workerData } = require("node:worker_threads");
const { atomicWriteJsonSync } = require("../src/atomic-json.cjs");
const { withJsonLockStrict } = require("../src/state-lock.cjs");

function statSignature(statePath) {
  try {
    const stat = fs.statSync(statePath);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return "missing";
  }
}

function normalizedAccount(account) {
  return {
    userId: String((account && account.userId) || ""),
    email: String((account && account.email) || "").trim().toLowerCase(),
    deviceId: String((account && account.deviceId) || ""),
  };
}

function ackPacketsTransaction(
  statePath,
  packetIds,
  updatedAt = new Date().toISOString(),
  expectedAccount = {},
  lockOptions,
) {
  const ids = [...new Set((packetIds || []).filter(Boolean).map(String))];
  if (!statePath || !ids.length) return { ok: true, rows: [], changedIds: [], beforeStateStatSig: "", stateStatSig: "" };
  let locked;
  try {
    locked = withJsonLockStrict(statePath, () => {
      const beforeStateStatSig = statSignature(statePath);
      let store;
      try {
        const serialized = fs.readFileSync(statePath, "utf8");
        store = JSON.parse(serialized);
      } catch (error) {
        throw new Error(`state_read_failed:${String((error && error.code) || (error && error.message) || "invalid_json")}`);
      }
      if (!store || typeof store !== "object" || Array.isArray(store)) throw new Error("state_read_failed:invalid_root");
      const expected = normalizedAccount(expectedAccount);
      const stored = normalizedAccount(store.account);
      const expectedNamed = Boolean(expected.userId || expected.email);
      const storedNamed = Boolean(stored.userId || stored.email);
      if (!expectedNamed && storedNamed) throw new Error("account_mismatch");
      if (expectedNamed && storedNamed) {
        const sharesUserId = Boolean(expected.userId && stored.userId);
        const sharesEmail = Boolean(expected.email && stored.email);
        if (!sharesUserId && !sharesEmail) throw new Error("account_mismatch");
        if (expected.userId && stored.userId && expected.userId !== stored.userId) throw new Error("account_mismatch");
        if (expected.email && stored.email && expected.email !== stored.email) throw new Error("account_mismatch");
      }
      if (expectedNamed && !storedNamed) store.account = expected;
      const rows = [];
      const changedIds = [];
      for (const id of ids) {
        const existing = store.packets && store.packets[id];
        if (!existing) continue;
        rows.push({
          id,
          relayNotificationKind: String(existing.relayNotificationKind || ""),
        });
        if (existing.state === "read") continue;
        store.packets[id] = { ...existing, state: "read", updatedAt };
        changedIds.push(id);
      }
      if (!changedIds.length) return { rows, changedIds, beforeStateStatSig, stateStatSig: beforeStateStatSig };
      atomicWriteJsonSync(statePath, store);
      return { rows, changedIds, beforeStateStatSig, stateStatSig: statSignature(statePath) };
    }, lockOptions);
  } catch (error) {
    return {
      ok: false,
      error: String((error && error.message) || error || "state_ack_failed"),
      rows: [],
      changedIds: [],
      beforeStateStatSig: "",
      stateStatSig: "",
    };
  }
  if (!locked.ok) {
    return { ok: false, error: `state_lock_${locked.reason || "failed"}`, rows: [], changedIds: [], beforeStateStatSig: "", stateStatSig: "" };
  }
  return { ok: true, ...(locked.value || { rows: [], changedIds: [], beforeStateStatSig: "", stateStatSig: "" }) };
}

function ackPacketsInState(statePath, packetIds, updatedAt = new Date().toISOString(), expectedAccount = {}) {
  const result = ackPacketsTransaction(statePath, packetIds, updatedAt, expectedAccount);
  if (!result.ok) return [];
  const changed = new Set(result.changedIds || []);
  return result.rows.filter((row) => changed.has(row.id));
}

if (!isMainThread && parentPort) {
  parentPort.on("message", (message) => {
    const requestId = message && message.requestId;
    try {
      const result = ackPacketsTransaction(
        workerData && workerData.statePath,
        message && message.packetIds,
        new Date().toISOString(),
        message && message.expectedAccount,
      );
      parentPort.postMessage({ requestId, ...result });
    } catch (error) {
      parentPort.postMessage({ requestId, ok: false, error: String((error && error.message) || error) });
    }
  });
}

module.exports = { ackPacketsInState, ackPacketsTransaction };
