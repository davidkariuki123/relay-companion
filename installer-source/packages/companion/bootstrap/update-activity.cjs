"use strict";
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
function read(file) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } }
function alive(pid) { if (!Number.isSafeInteger(pid) || pid < 1) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code !== "ESRCH"; } }
function paths(homeDir, configDir) { const root = path.join(configDir || path.join(homeDir, ".relay"), "recovery", "activity"); return { root, drain: path.join(root, "drain.json") }; }
function beginCall({ homeDir = os.homedir(), configDir, kind = "call" } = {}) {
  const { root, drain } = paths(homeDir, configDir);
  const blocked = () => alive(read(drain)?.pid);
  if (blocked()) throw Error("Relay is updating. Retry with the same idempotency key after it finishes.");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const file = path.join(root, `call-${crypto.randomUUID()}.json`);
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, kind, startedAt: Date.now() }), { mode: 0o600, flag: "wx" });
  const release = () => { try { fs.rmSync(file, { force: true }); } catch {} };
  // Close admission racing the updater's drain barrier.
  if (blocked()) { release(); throw Error("Relay is updating. Retry with the same idempotency key after it finishes."); }
  return release;
}
async function drainCalls({ homeDir = os.homedir(), sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), attempts = 60 } = {}) {
  const { root, drain } = paths(homeDir);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const nonce = crypto.randomUUID();
  // Caller holds the canonical transaction lock; only that owner may drain.
  fs.writeFileSync(drain, JSON.stringify({ pid: process.pid, nonce }), { mode: 0o600 });
  const release = () => { if (read(drain)?.nonce === nonce) fs.rmSync(drain, { force: true }); };
  try {
    for (let i = 0; i < attempts; i++) {
      let busy = false;
      for (const name of fs.readdirSync(root).filter(name => /^call-[a-f0-9-]+\.json$/.test(name))) {
        const file = path.join(root, name), report = read(file);
        if (!report || !Number.isSafeInteger(report.pid) || report.pid < 1 || alive(report.pid)) busy = true;
        else fs.rmSync(file, { force: true });
      }
      if (!busy) return release;
      await sleep(500);
    }
    throw Error("Relay calls still active; activation deferred without interrupting them.");
  } catch (e) { release(); throw e; }
}
function activeCalls({ homeDir = os.homedir(), configDir } = {}) {
  const { root } = paths(homeDir, configDir);
  let names;
  try { names = fs.readdirSync(root); } catch(e) { return e.code === "ENOENT" ? 0 : null; }
  let count = 0;
  for (const name of names.filter(name => /^call-[a-f0-9-]+\.json$/.test(name))) {
    const report = read(path.join(root, name));
    if (!report || !Number.isSafeInteger(report.pid) || report.pid < 1) return null; // cannot prove idle
    if (alive(report.pid)) count++;
  }
  return count;
}
module.exports = { beginCall, drainCalls, activeCalls };
