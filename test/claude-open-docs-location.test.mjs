import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { materializeRelayOpenDocumentFiles, relayOpenDocumentsDir } from "../src/claude-materializer.js";

// Bug 2 (Sven, 2026-09-10): Claude Desktop's file panel only reads paths inside
// the session's granted roots (cwd first). Documents in ~/.relay-companion were
// outside every root, so every For-Agent / For-Human link died with "Couldn't
// find this file". They must be written under the session cwd.
test("Claude open documents are written under the session cwd, git-invisible", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "relay-open-cwd-"));
  try {
    const row = { id: "relay_x", forHuman: "human copy", forAgent: "agent copy" };
    const { forHuman, forAgent } = materializeRelayOpenDocumentFiles(row, { provider: "claude-inbox", cwd });
    // Both documents live under <cwd>/.relay-inbox, i.e. inside a granted root.
    const inbox = path.join(cwd, ".relay-inbox");
    assert.ok(forAgent.startsWith(inbox + path.sep), `${forAgent} is under ${inbox}`);
    assert.ok(forHuman.startsWith(inbox + path.sep));
    assert.equal(fs.readFileSync(forAgent, "utf8").trim().endsWith("agent copy"), true);
    // A `*` .gitignore keeps the whole dir out of a passport checkout's git status.
    assert.equal(fs.readFileSync(path.join(inbox, ".gitignore"), "utf8"), "*\n");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("the cwd copy is created even when the cwd does not exist yet (~/Relay first use)", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "relay-open-firstuse-"));
  const cwd = path.join(parent, "Relay"); // deliberately absent
  try {
    const dir = relayOpenDocumentsDir({ provider: "claude-inbox", id: "relay_y", cwd });
    assert.ok(dir.startsWith(path.join(cwd, ".relay-inbox") + path.sep));
    assert.ok(fs.existsSync(path.join(cwd, ".relay-inbox", ".gitignore")));
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("with no cwd, documents fall back to the companion store (Codex path unchanged)", () => {
  const dir = relayOpenDocumentsDir({ provider: "codex-inbox", id: "relay_z", cwd: "" });
  assert.ok(dir.includes(path.join("codex-inbox", "relay_z")), `${dir} stays in the store`);
  assert.ok(!dir.includes(".relay-inbox"));
});
