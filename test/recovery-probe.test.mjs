import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { startRecoveryResponder, probeRuntime, requestProbe, endpointPath } from "../bootstrap/recovery-probe.cjs";

function fixture(t) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-probe-"));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  const target = { packageRoot: path.join(homeDir, "node_modules", "relay-companion"), version: "1.0.0" };
  fs.mkdirSync(path.join(target.packageRoot, "bootstrap"), { recursive: true });
  fs.writeFileSync(path.join(target.packageRoot, "bootstrap", "recovery-probe.cjs"), "");
  return { homeDir, target };
}

test("fresh challenges traverse real local sockets and the pill readiness callback", async t => {
  const { homeDir, target } = fixture(t); let rendererChecks = 0;
  const daemon = await startRecoveryResponder({ homeDir, ...target, role: "daemon" });
  const pill = await startRecoveryResponder({ homeDir, ...target, role: "pill", ready: async () => { rendererChecks++; return true; } });
  try {
    const response = await probeRuntime(target, { homeDir });
    assert.equal(response.ok, true); assert.equal(rendererChecks, 1);
    assert.equal(response.daemon.pid, process.pid);
    assert.equal(response.identity, `${daemon.instance}:${pill.instance}`);
    assert.equal((await probeRuntime({ ...target, version: "2.0.0" }, { homeDir })).ok, false);
  } finally { daemon.stop(); pill.stop(); }
});

test("a live main process with a stalled or unready renderer cannot answer healthy", async t => {
  const { homeDir, target } = fixture(t);
  let ready = false;
  const pill = await startRecoveryResponder({ homeDir, ...target, role: "pill", ready: () => ready ? new Promise(() => {}) : false });
  try {
    assert.equal((await requestProbe("pill", target, { homeDir, timeoutMs: 50 })).ok, false);
    ready = true;
    assert.equal((await requestProbe("pill", target, { homeDir, timeoutMs: 50 })).reason, "pill-probe-timeout");
  } finally { pill.stop(); }
});

test("cached responses with the wrong challenge cannot pass readiness", async t => {
  const { homeDir, target } = fixture(t);
  const server = net.createServer(socket => socket.once("data", () => socket.end(JSON.stringify({ schema: 1, ok: true, role: "daemon", pid: process.pid, ...target, instance: "old", nonce: "0".repeat(32) }) + "\n")));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const file = endpointPath(homeDir, "daemon");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ schema: 1, role: "daemon", pid: process.pid, ...target, instance: "old", token: "0".repeat(64), port: server.address().port }));
  try { assert.equal((await requestProbe("daemon", target, { homeDir, timeoutMs: 500 })).ok, false); }
  finally { server.close(); }
});

test("an exiting old process cannot remove the replacement's probe registration", async t => {
  const { homeDir, target } = fixture(t);
  const old = await startRecoveryResponder({ homeDir, ...target, role: "daemon" });
  const replacement = await startRecoveryResponder({ homeDir, ...target, role: "daemon" });
  old.stop();
  try { assert.equal((await requestProbe("daemon", target, { homeDir, timeoutMs: 500 })).instance, replacement.instance); }
  finally { replacement.stop(); }
});

test("older stock releases are explicitly legacy; missing probes in new releases fail", async t => {
  const { homeDir, target } = fixture(t);
  assert.equal((await probeRuntime(target, { homeDir })).ok, false);
  fs.unlinkSync(path.join(target.packageRoot, "bootstrap", "recovery-probe.cjs"));
  assert.deepEqual(await probeRuntime(target, { homeDir }), { ok: true, legacy: true });
});
