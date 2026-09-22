"use strict";
// All application-facing repairs use the same ownership record as activation.
// A child of an existing installer joins that exact generation; it never takes
// an unrelated lock or trusts a caller-supplied boolean saying "updating".
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const locks = require("./recovery-launcher.cjs");
const crypto = require("node:crypto");
const heldLeases = new Map();
const read = file => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } };

function lifecycleOwnership({ homeDir = os.homedir(), env = process.env,
  acquire = locks.acquireCanonicalLock, pid = process.pid, parentPid = process.ppid,
  alive = locks.processAlive, identity = locks.nativeProcessIdentity } = {}) {
  const file = path.join(homeDir, ".relay", "runtime", "transaction.lock", "owner.json");
  const observed = read(file);
  let lock;
  const delegated = observed && (observed.pid === parentPid
    || (env.RELAY_LIFECYCLE_OWNER === `${observed.pid}:${observed.nonce}`));
  const held = heldLeases.get(file);
  if (delegated && held?.owner.nonce === observed.nonce) {
    held.assert();
    held.references++;
    let released = false;
    return { ...held, release: () => { if (released) return; released = true; if (--held.references === 0) { heldLeases.delete(file); held.dispose(); } } };
  }
  if (!delegated) lock = acquire(path.dirname(file));
  const owner = read(file);
  const lockDir = path.dirname(file);
  let participant;
  // Only join while the granting process still exists. A stale environment
  // capability cannot resurrect a dead transaction.
  if (delegated && owner?.pid !== pid) {
    if (!alive(owner?.pid) || (owner.processIdentity && identity(owner.pid) !== owner.processIdentity)) throw Error("lifecycle-owner-ended");
    participant = path.join(lockDir, `participant-${pid}-${crypto.randomBytes(16).toString("hex")}.json`);
    fs.writeFileSync(participant, JSON.stringify({ nonce: owner.nonce, pid, createdAt: Date.now(), processIdentity: identity(pid) }), { flag: "wx", mode: 0o600 });
  }
  const assert = () => {
    const current = read(file);
    if (!owner?.nonce || current?.nonce !== owner.nonce || current.pid !== owner.pid
      || fs.existsSync(path.join(lockDir, "reclaim.json"))
      || (!participant && (!alive(owner.pid) || (owner.processIdentity && identity(owner.pid) !== owner.processIdentity)))) {
      throw Error("lifecycle-owner-changed");
    }
  };
  const dispose = () => {
    if (participant && read(file)?.nonce === owner.nonce) fs.rmSync(participant, { force: true });
    lock?.release();
  };
  try { assert(); } catch (error) { dispose(); throw error; }
  const lease = {
    owner, assert, delegated: !lock,
    env: { ...env, RELAY_LIFECYCLE_OWNER: `${owner.pid}:${owner.nonce}` },
    references: 1, dispose,
  };
  heldLeases.set(file, lease);
  let released = false;
  return { ...lease, release: () => {
    if (released) return;
    released = true;
    if (--lease.references === 0) { heldLeases.delete(file); dispose(); }
  } };
}
function ownerEnvironment({ homeDir = os.homedir(), env = process.env } = {}) {
  const owner = read(path.join(homeDir, ".relay", "runtime", "transaction.lock", "owner.json"));
  // Only the actual owner may hand its generation to a worker.
  return owner?.pid === process.pid && owner.nonce
    ? { ...env, RELAY_LIFECYCLE_OWNER: `${owner.pid}:${owner.nonce}` } : { ...env };
}
module.exports = { lifecycleOwnership, ownerEnvironment };
