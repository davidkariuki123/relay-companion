import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { downloadVerifiedArtifact, prepareResumableArtifact, stageVerifiedRuntime } = require("../bootstrap/relay-setup.cjs");

const URL_ = "https://api.sendrelays.com/v1/companion-releases/v1.2.3/runtime.tar.gz";
const signed = (bytes) => ({ bytes: bytes.length, sha512: `sha512-${crypto.createHash("sha512").update(bytes).digest("base64")}` });

// A server that answers each request from a script: `{ deliver }` sends that
// many bytes from the requested offset and then drops the connection, `{ fail }`
// errors before any byte, and `{ all }` serves the rest.
function scriptedServer(bytes, script, requests = []) {
  return (_url, options, callback) => {
    requests.push(options);
    const step = script.shift() || { all: true };
    const request = new EventEmitter();
    request.setTimeout = () => request;
    request.destroy = (error) => queueMicrotask(() => request.emit("error", error));
    const offset = Number(/^bytes=(\d+)-$/.exec(options.headers.range || "")?.[1] || 0);
    queueMicrotask(() => {
      if (step.fail) return request.emit("error", new Error(step.fail));
      const response = new PassThrough();
      response.statusCode = offset ? 206 : 200;
      response.headers = { "content-length": String(bytes.length - offset),
        ...(offset ? { "content-range": `bytes ${offset}-${bytes.length - 1}/${bytes.length}` } : {}) };
      callback(response);
      if (step.all) return response.end(bytes.subarray(offset));
      response.write(bytes.subarray(offset, offset + step.deliver));
      // A dropped connection: the socket errors after the bytes were delivered.
      setImmediate(() => response.destroy(new Error("read ECONNRESET")));
    });
    return request;
  };
}

test("a download continues from a partial file left by an earlier run", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-resume-run-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bytes = crypto.randomBytes(4096);
  const file = path.join(root, "runtime.partial");
  const artifact = signed(bytes);
  const first = [];
  await assert.rejects(downloadVerifiedArtifact(URL_, file, artifact,
    { get: scriptedServer(bytes, [{ deliver: 1000 }, { fail: "read ETIMEDOUT" }], first), sleep: async () => {}, attempts: 1, resume: true }),
    /incomplete after 2 attempts/);
  assert.equal(fs.statSync(file).size, 1000, "the bytes that arrived stay on disk");
  const second = [];
  await downloadVerifiedArtifact(URL_, file, artifact, { get: scriptedServer(bytes, [{ all: true }], second), sleep: async () => {}, resume: true });
  assert.equal(second.length, 1);
  assert.equal(second[0].headers.range, "bytes=1000-", "the next run asks only for what is missing");
  assert.deepEqual(fs.readFileSync(file), bytes);
});

test("attempts that make progress never exhaust the no-progress budget; a dead connection does", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-resume-budget-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bytes = crypto.randomBytes(5000);
  const artifact = signed(bytes);
  const requests = [];
  const slept = [];
  // Nine drops of 500 bytes each, then the rest: ten requests on a budget of two.
  const script = Array.from({ length: 9 }, () => ({ deliver: 500 }));
  await downloadVerifiedArtifact(URL_, path.join(root, "progress.bin"), artifact,
    { get: scriptedServer(bytes, script, requests), sleep: async (ms) => { slept.push(ms); }, attempts: 2 });
  assert.equal(requests.length, 10);
  assert.ok(slept.every((ms) => ms < 2_000), "a connection that delivers bytes is retried quickly");

  const dead = [];
  await assert.rejects(downloadVerifiedArtifact(URL_, path.join(root, "dead.bin"), artifact,
    { get: scriptedServer(bytes, [{ fail: "ENOTFOUND" }, { fail: "ECONNRESET" }, { fail: "ETIMEDOUT" }], dead), sleep: async () => {}, attempts: 2 }),
    /incomplete after 2 attempts .*0\/5000 bytes.*ECONNRESET/);
  assert.equal(dead.length, 2);
});

test("a download stops at its time budget and reports what it kept", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-resume-clock-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bytes = crypto.randomBytes(3000);
  const artifact = signed(bytes);
  let clock = 0;
  const requests = [];
  await assert.rejects(downloadVerifiedArtifact(URL_, path.join(root, "slow.bin"), artifact, {
    get: scriptedServer(bytes, [{ deliver: 1000 }, { deliver: 1000 }, { deliver: 1000 }], requests),
    sleep: async () => { clock += 10 * 60_000; }, now: () => clock, budgetMs: 15 * 60_000, attempts: 6,
  }), /time budget of 15 minutes used up/);
  assert.equal(requests.length, 2, "the third attempt would start after the budget");
  assert.equal(fs.statSync(path.join(root, "slow.bin")).size, 2000);
});

test("a bad checksum or a server that disagrees with the manifest discards the partial so the next run starts clean", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-resume-poison-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bytes = crypto.randomBytes(2048);
  const poisoned = path.join(root, "poisoned.partial");
  fs.writeFileSync(poisoned, crypto.randomBytes(1024));
  await assert.rejects(downloadVerifiedArtifact(URL_, poisoned, signed(bytes), { get: scriptedServer(bytes, [{ all: true }]), sleep: async () => {}, resume: true }),
    /checksum is invalid/);
  assert.equal(fs.existsSync(poisoned), false);

  const oversized = path.join(root, "oversized.partial");
  fs.writeFileSync(oversized, crypto.randomBytes(4096));
  const requests = [];
  await downloadVerifiedArtifact(URL_, oversized, signed(bytes), { get: scriptedServer(bytes, [{ all: true }], requests), sleep: async () => {}, resume: true });
  assert.equal(requests[0].headers.range, undefined, "a partial larger than the artifact is restarted from zero");
  assert.deepEqual(fs.readFileSync(oversized), bytes);

  const wrongLength = path.join(root, "wrong-length.partial");
  fs.writeFileSync(wrongLength, bytes.subarray(0, 100));
  const lying = (_url, options, callback) => {
    const request = new EventEmitter(); request.setTimeout = () => request; request.destroy = () => {};
    queueMicrotask(() => { const response = new PassThrough(); response.statusCode = 206; response.headers = { "content-length": "1" }; callback(response); response.end("x"); });
    return request;
  };
  await assert.rejects(downloadVerifiedArtifact(URL_, wrongLength, signed(bytes), { get: lying, sleep: async () => {}, resume: true }), /Content-Length/);
  assert.equal(fs.existsSync(wrongLength), false);
});

test("the partial file is held by one process, named by the artifact, and replaces partials of other builds", (t) => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-resume-home-"));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  const artifact = signed(Buffer.from("build one"));
  const downloads = path.join(homeDir, ".relay", "runtime", "downloads");
  fs.mkdirSync(downloads, { recursive: true });
  fs.writeFileSync(path.join(downloads, "runtime-0.1.600-0123456789abcdef.partial"), "stale");
  fs.writeFileSync(path.join(downloads, "runtime-0.1.600-0123456789abcdef.partial.lock"), JSON.stringify({ pid: 999999 }));

  const first = prepareResumableArtifact({ homeDir, version: "0.1.624", artifact, alive: () => false });
  assert.equal(first.ok, true);
  assert.equal(first.resumedFrom, 0);
  assert.match(path.basename(first.file), /^runtime-0\.1\.624-[0-9a-f]{16}\.partial$/);
  assert.deepEqual(fs.readdirSync(downloads).sort(), [path.basename(first.file) + ".lock"], "another build's partial and its dead lock are gone; ours has no bytes yet");

  fs.writeFileSync(first.file, "12345");
  // Another live process holds the partial: the lock names a pid that is not ours.
  fs.writeFileSync(`${first.file}.lock`, JSON.stringify({ schema: 1, pid: process.pid + 100_000 }));
  const contended = prepareResumableArtifact({ homeDir, version: "0.1.624", artifact, alive: () => true });
  assert.equal(contended.ok, false);
  assert.equal(contended.reason, "partial-in-use");
  assert.equal(fs.existsSync(first.file), true, "a contended partial is left alone");

  first.release();
  const again = prepareResumableArtifact({ homeDir, version: "0.1.624", artifact, alive: () => false });
  assert.equal(again.ok, true);
  assert.equal(again.resumedFrom, 5, "the next run sees the bytes the previous one kept");
  assert.equal(prepareResumableArtifact({ homeDir, version: "0.1.624", artifact: signed(Buffer.from("build two")), alive: () => false }).file !== again.file, true,
    "a different artifact of the same version never resumes onto this file");
  again.release();
});

test("staging a runtime downloads into the persistent partial, logs resume and progress, and keeps the partial when the download fails", async (t) => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-resume-stage-"));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  const destination = path.join(homeDir, ".relay", "runtime", "releases", "0.1.624-test");
  const bytes = crypto.randomBytes(10_000);
  const artifact = { ...signed(bytes), url: URL_ };
  const lines = [];
  const calls = [];
  let delivered = 2500;
  const download = async (url, file, art, options) => {
    calls.push({ url, file, resume: options.resume, existing: fs.existsSync(file) ? fs.statSync(file).size : null });
    fs.writeFileSync(file, bytes.subarray(0, delivered));
    for (const received of [1000, 2500, 2600, delivered]) options.onProgress({ receivedBytes: received, totalBytes: bytes.length });
    throw new Error("Relay artifact download incomplete after 6 attempts");
  };
  const stage = () => stageVerifiedRuntime({ version: "0.1.624", platformKey: "darwin-arm64", destination, homeDir, log: (line) => lines.push(line),
    download, fetchManifest: async () => Buffer.from("{}"), parseManifest: () => ({ artifact }) });
  await assert.rejects(stage(), /incomplete/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].resume, true);
  assert.equal(calls[0].existing, null, "a fresh partial does not exist yet");
  assert.match(calls[0].file.split(path.sep).join("/"), /\/\.relay\/runtime\/downloads\/runtime-0\.1\.624-[0-9a-f]{16}\.partial$/);
  assert.equal(fs.statSync(calls[0].file).size, 2500, "the partial outlives the failed staging");
  assert.equal(fs.existsSync(`${calls[0].file}.lock`), false, "the hold is released with the failure");
  assert.equal(fs.readdirSync(path.join(homeDir, ".relay", "runtime", "releases")).length, 0, "no staging directory is left behind");
  assert.ok(lines.some((line) => /signed runtime \(0\.0 MB\)\.\.\./.test(line)), lines.join("\n"));
  assert.deepEqual(lines.filter((line) => line.startsWith("Downloaded")), ["Downloaded 0.0 of 0.0 MB (10%)", "Downloaded 0.0 of 0.0 MB (20%)"],
    "one line per ten percent, never twice for the same tenth");

  delivered = 6000;
  await assert.rejects(stage(), /incomplete/);
  assert.equal(calls[1].existing, 2500, "the second run is handed the first run's bytes");
  assert.ok(lines.some((line) => /resuming at 0\.0 of 0\.0 MB/.test(line)), "the log says the download resumed");
});
