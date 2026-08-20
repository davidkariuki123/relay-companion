import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { withJsonLock, acquireJsonLock } = require("../src/state-lock.cjs");
const __dirname = path.dirname(fileURLToPath(import.meta.url));

test("withJsonLock runs the function and releases the lock", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "state-lock-"));
  const target = path.join(dir, "state.json");
  const out = withJsonLock(target, () => "ran");
  assert.equal(out, "ran");
  assert.equal(fs.existsSync(`${target}.lock`), false, "lock released");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("lock is released even when the function throws", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "state-lock-"));
  const target = path.join(dir, "state.json");
  assert.throws(() => withJsonLock(target, () => { throw new Error("boom"); }), /boom/);
  assert.equal(fs.existsSync(`${target}.lock`), false, "lock released after throw");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a stale lock from a crashed process is stolen", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "state-lock-"));
  const target = path.join(dir, "state.json");
  fs.mkdirSync(`${target}.lock`);
  const old = Date.now() / 1000 - 60; // 60s ago > 10s staleMs
  fs.utimesSync(`${target}.lock`, old, old);
  const out = withJsonLock(target, () => "stole", { timeoutMs: 500, staleMs: 10000 });
  assert.equal(out, "stole");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("timeout proceeds without the lock instead of wedging", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "state-lock-"));
  const target = path.join(dir, "state.json");
  fs.mkdirSync(`${target}.lock`); // fresh lock, held by "another process"
  const started = Date.now();
  const out = withJsonLock(target, () => "proceeded", { timeoutMs: 300, staleMs: 60_000 });
  assert.equal(out, "proceeded");
  assert.ok(Date.now() - started >= 280, "waited for the timeout first");
  assert.equal(fs.existsSync(`${target}.lock`), true, "did not steal the live lock");
  fs.rmSync(dir, { recursive: true, force: true });
});

// The real thing: two PROCESSES doing read-modify-write cycles on one JSON file.
// Without the lock this loses updates; with it, every increment lands.
test("cross-process read-modify-write loses no updates under the lock", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "state-lock-"));
  const target = path.join(dir, "state.json");
  fs.writeFileSync(target, JSON.stringify({ counters: {} }));

  const workerSrc = `
    const { withJsonLock } = require(${JSON.stringify(path.join(__dirname, "..", "src", "state-lock.cjs"))});
    const fs = require("node:fs");
    const [target, key, n] = process.argv.slice(2);
    for (let i = 0; i < Number(n); i++) {
      withJsonLock(target, () => {
        const state = JSON.parse(fs.readFileSync(target, "utf8"));
        state.counters[key] = (state.counters[key] || 0) + 1;
        const tmp = target + "." + process.pid + "." + i + ".tmp";
        fs.writeFileSync(tmp, JSON.stringify(state));
        fs.renameSync(tmp, target);
      });
    }
  `;
  const workerPath = path.join(dir, "worker.cjs");
  fs.writeFileSync(workerPath, workerSrc);

  const N = 40;
  const run = (key) =>
    new Promise((resolve, reject) => {
      const child = fork(workerPath, [target, key, String(N)], { stdio: "inherit" });
      child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`worker ${key} exited ${code}`))));
    });
  await Promise.all([run("a"), run("b"), run("c")]);

  const state = JSON.parse(fs.readFileSync(target, "utf8"));
  assert.equal(state.counters.a, N);
  assert.equal(state.counters.b, N);
  assert.equal(state.counters.c, N);
  fs.rmSync(dir, { recursive: true, force: true });
});
