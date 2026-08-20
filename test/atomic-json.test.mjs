import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import atomicJson from "../src/atomic-json.cjs";

const { atomicWriteJsonSync } = atomicJson;

function fsWithRename(renameSync) {
  return {
    mkdirSync: (...args) => fs.mkdirSync(...args),
    writeFileSync: (...args) => fs.writeFileSync(...args),
    renameSync,
    rmSync: (...args) => fs.rmSync(...args),
  };
}

test("atomic JSON persistence retries transient Windows rename locks", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-atomic-json-"));
  const target = path.join(root, "state.json");
  let attempts = 0;
  const sleeps = [];
  try {
    atomicWriteJsonSync(target, { packets: { relay_1: { state: "unread" } } }, {
      fsImpl: fsWithRename((from, to) => {
        attempts += 1;
        if (attempts < 3) {
          const error = new Error("file temporarily held by another process");
          error.code = attempts === 1 ? "EPERM" : "EBUSY";
          throw error;
        }
        fs.renameSync(from, to);
      }),
      retryDelaysMs: [7, 13, 29],
      sleep: (ms) => sleeps.push(ms),
    });
    assert.equal(attempts, 3);
    assert.deepEqual(sleeps, [7, 13]);
    assert.equal(JSON.parse(fs.readFileSync(target, "utf8")).packets.relay_1.state, "unread");
    assert.deepEqual(fs.readdirSync(root), ["state.json"], "the committed temp file leaves no debris");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("atomic JSON persistence fails fast for permanent errors and removes its temp file", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-atomic-json-fail-"));
  const target = path.join(root, "state.json");
  try {
    assert.throws(
      () => atomicWriteJsonSync(target, { version: 1 }, {
        fsImpl: fsWithRename(() => {
          const error = new Error("disk full");
          error.code = "ENOSPC";
          throw error;
        }),
        sleep: () => assert.fail("permanent errors must not be retried"),
      }),
      /disk full/,
    );
    assert.deepEqual(fs.readdirSync(root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("atomic JSON persistence bounds a persistent transient failure", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-atomic-json-bounded-"));
  const target = path.join(root, "state.json");
  let attempts = 0;
  try {
    assert.throws(
      () => atomicWriteJsonSync(target, { version: 1 }, {
        fsImpl: fsWithRename(() => {
          attempts += 1;
          const error = new Error("still busy");
          error.code = "EACCES";
          throw error;
        }),
        retryDelaysMs: [1, 2],
        sleep: () => {},
      }),
      /still busy/,
    );
    assert.equal(attempts, 3, "one initial attempt plus two bounded retries");
    assert.deepEqual(fs.readdirSync(root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
