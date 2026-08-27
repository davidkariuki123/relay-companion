import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import { stableNodePath } from "../src/install.js";

const require = createRequire(import.meta.url);
const {
  isTemporaryNodePath,
  relayOwnedNodePath,
} = require("../bootstrap/owned-node-runtime.cjs");
const { stableNodePath: bootstrapStableNodePath } = require("../bootstrap/relay-setup.cjs");

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-owned-node-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("temporary Node detection covers both macOS temp aliases", () => {
  assert.equal(isTemporaryNodePath("/tmp/npx-123/node", { platform: "darwin" }), true);
  assert.equal(isTemporaryNodePath("/private/tmp/conductor/node", { platform: "darwin" }), true);
  assert.equal(isTemporaryNodePath("/opt/homebrew/bin/node", { platform: "darwin" }), false);
  assert.equal(isTemporaryNodePath("C:\\Temp\\node.exe", { platform: "win32" }), false);
});

test("stable Node selection never persists a temporary PATH candidate", () => {
  const temporary = "/private/tmp/npx-123/node";
  const durable = "/usr/local/bin/node";
  const result = stableNodePath(temporary, {
    platform: "darwin",
    env: { PATH: `/private/tmp/npx-123:/usr/local/bin` },
    existsSync: (candidate) => [temporary, durable].includes(candidate),
    realpath: (candidate) => candidate,
    runCommand: (candidate) => candidate === durable
      ? { status: 0, stdout: "22.14.0\n" }
      : { status: 1, stdout: "" },
  });
  assert.equal(result, durable);
});

test("first-contact bootstrap also prefers a durable Node over its temporary interpreter", () => {
  const temporary = "/tmp/npx-456/node";
  const durable = "/usr/local/bin/node";
  const result = bootstrapStableNodePath(temporary, {
    platform: "darwin",
    env: { PATH: `/tmp/npx-456:/usr/local/bin` },
    existsSync: (candidate) => [temporary, durable].includes(candidate),
    realpathSync: (candidate) => candidate,
    spawnImpl: (candidate) => candidate === durable
      ? { status: 0, stdout: "22.14.0\n" }
      : { status: 1, stdout: "" },
  });
  assert.equal(result, durable);
});

test("temporary Node is copied, integrity checked, executed, and reused from Relay's runtime", (t) => {
  const root = tempRoot(t);
  const source = path.join(root, "temporary-node.exe");
  const runtimeRoot = path.join(root, "runtime");
  const bytes = Buffer.from("verified-node-executable");
  fs.writeFileSync(source, bytes);
  const calls = [];
  const runCommand = (candidate) => {
    calls.push(candidate);
    return { status: 0, stdout: "22.14.0\n" };
  };
  const options = {
    platform: "win32",
    runtimeRoot,
    runCommand,
    isTemporary: () => true,
    randomBytes: () => Buffer.from("abcdefabcdef", "hex"),
  };

  const owned = relayOwnedNodePath(source, options);
  const digest = crypto.createHash("sha256").update(bytes).digest("hex");
  assert.equal(owned, path.win32.join(runtimeRoot, "node", digest, "node.exe"));
  assert.deepEqual(fs.readFileSync(owned), bytes);
  assert.deepEqual(calls, [fs.realpathSync(source), owned]);

  calls.length = 0;
  assert.equal(relayOwnedNodePath(source, options), owned);
  assert.deepEqual(calls, [fs.realpathSync(source), owned]);
});

test("a corrupt owned copy is replaced from the verified temporary source", (t) => {
  const root = tempRoot(t);
  const source = path.join(root, "temporary-node.exe");
  const bytes = Buffer.from("good-node");
  fs.writeFileSync(source, bytes);
  const options = {
    platform: "win32",
    runtimeRoot: path.join(root, "runtime"),
    runCommand: () => ({ status: 0, stdout: "24.1.0\n" }),
    isTemporary: () => true,
  };
  const owned = relayOwnedNodePath(source, options);
  fs.writeFileSync(owned, "corrupt");
  assert.equal(relayOwnedNodePath(source, options), owned);
  assert.deepEqual(fs.readFileSync(owned), bytes);
});

test("an owned copy that cannot execute is deleted and setup fails visibly", (t) => {
  const root = tempRoot(t);
  const source = path.join(root, "temporary-node.exe");
  fs.writeFileSync(source, "node-binary");
  let destination = "";
  assert.throws(() => relayOwnedNodePath(source, {
    platform: "win32",
    runtimeRoot: path.join(root, "runtime"),
    isTemporary: () => true,
    runCommand(candidate) {
      if (candidate === fs.realpathSync(source)) return { status: 0, stdout: "22.14.0\n" };
      destination = candidate;
      return { status: 1, stderr: "cannot load adjacent library" };
    },
  }), /owned Node runtime failed verification/);
  assert.equal(fs.existsSync(destination), false);
});

test("a durable Node path is returned without touching the filesystem", () => {
  assert.equal(relayOwnedNodePath("/usr/local/bin/node", {
    platform: "darwin",
    isTemporary: () => false,
    fsImpl: new Proxy({}, { get() { throw new Error("filesystem should not be used"); } }),
  }), "/usr/local/bin/node");
});
