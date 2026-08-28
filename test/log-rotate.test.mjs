import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_KEEP_BYTES, DEFAULT_MAX_LOG_BYTES, defaultLogPaths, rotateLogIfLarge, rotateLogs } from "../src/log-rotate.js";

function tmpdir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `relay-log-rotate-${label}-`));
}

test("a log under the limit is left alone", () => {
  const dir = tmpdir("small");
  const file = path.join(dir, "daemon.log");
  fs.writeFileSync(file, "line one\nline two\n");
  const result = rotateLogIfLarge(file, { maxBytes: 1024 });
  assert.equal(result.rotated, false);
  assert.equal(result.reason, "under-limit");
  assert.equal(fs.readFileSync(file, "utf8"), "line one\nline two\n", "content is untouched");
  assert.ok(!fs.existsSync(`${file}.1`), "no archive is created");
});

test("a missing log is not an error", () => {
  const dir = tmpdir("missing");
  const result = rotateLogIfLarge(path.join(dir, "nope.log"), { maxBytes: 10 });
  assert.equal(result.rotated, false);
  assert.equal(result.reason, "missing");
});

test("an oversized log is truncated in place and its tail archived", () => {
  const dir = tmpdir("big");
  const file = path.join(dir, "daemon.log");
  const lines = [];
  for (let i = 0; i < 5000; i += 1) lines.push(`[relay] line ${i}`);
  const body = `${lines.join("\n")}\n`;
  fs.writeFileSync(file, body);
  const before = fs.statSync(file);

  const result = rotateLogIfLarge(file, { maxBytes: 4096, keepBytes: 2048 });

  assert.equal(result.rotated, true);
  assert.equal(result.size, before.size);

  // THE critical property: same inode, truncated. Renaming would leave launchd's and
  // Task Scheduler's append-mode descriptors writing into the renamed file forever
  // while the live log stayed empty.
  const after = fs.statSync(file);
  assert.equal(after.ino, before.ino, "the live log keeps its inode so append-mode writers follow it");
  assert.ok(after.size < 4096, "the live log is small again");

  const archive = fs.readFileSync(`${file}.1`, "utf8");
  assert.ok(archive.length <= 2048, "the archive is bounded by keepBytes");
  assert.ok(archive.endsWith("line 4999\n"), "the archive holds the most recent lines");
  assert.ok(archive.startsWith("[relay] line "), "the partial first line is dropped");

  const live = fs.readFileSync(file, "utf8");
  assert.match(live, /log rotated at \d+ bytes/, "the live log explains what happened");
  assert.match(live, /daemon\.log\.1/, "and where the old lines went");
});

test("rotation is idempotent — a freshly rotated log is not rotated again", () => {
  const dir = tmpdir("idem");
  const file = path.join(dir, "daemon.log");
  fs.writeFileSync(file, "x".repeat(9000));
  assert.equal(rotateLogIfLarge(file, { maxBytes: 4096, keepBytes: 1024 }).rotated, true);
  const second = rotateLogIfLarge(file, { maxBytes: 4096, keepBytes: 1024 });
  assert.equal(second.rotated, false);
  assert.equal(second.reason, "under-limit");
});

test("an unwritable archive still reclaims the disk", () => {
  const dir = tmpdir("archive-fail");
  const file = path.join(dir, "daemon.log");
  fs.writeFileSync(file, "y".repeat(9000));
  // A directory where the archive should go makes writeFileSync fail.
  fs.mkdirSync(`${file}.1`);
  const result = rotateLogIfLarge(file, { maxBytes: 4096, keepBytes: 1024 });
  assert.equal(result.rotated, true, "losing old lines beats filling the volume");
  assert.ok(fs.statSync(file).size < 4096);
});

test("rotateLogs reports only what it actually rotated", () => {
  const dir = tmpdir("many");
  const big = path.join(dir, "daemon.log");
  const small = path.join(dir, "pill.log");
  fs.writeFileSync(big, "z".repeat(9000));
  fs.writeFileSync(small, "tiny\n");
  const messages = [];
  const results = rotateLogs({
    files: [big, small, path.join(dir, "absent.log")],
    maxBytes: 4096,
    keepBytes: 512,
    log: (m) => messages.push(m),
  });
  assert.deepEqual(
    results.map((r) => r.rotated),
    [true, false, false],
  );
  assert.equal(messages.length, 1, "quiet unless it did something");
  assert.match(messages[0], /rotated daemon\.log/);
});

test("the default set covers every always-on log", () => {
  const files = defaultLogPaths("/home/ada").map((f) => path.basename(f));
  assert.deepEqual(files, ["daemon.log", "pill.log", "update.log", "update.native.log", "perf.log", "broker.log"]);
  assert.ok(defaultLogPaths("/home/ada").every((f) => f.startsWith(path.join("/home/ada", ".relay"))));
  // Sanity: a cap large enough to be useful, small enough to matter. The field report
  // that motivated this had daemon.log at 40 MB.
  assert.ok(DEFAULT_MAX_LOG_BYTES < 40 * 1024 * 1024);
  assert.ok(DEFAULT_KEEP_BYTES < DEFAULT_MAX_LOG_BYTES);
});
