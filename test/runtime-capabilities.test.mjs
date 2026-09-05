import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  assertRuntimeCapabilities,
  REQUIRED_RUNTIME_CAPABILITIES,
} from "../scripts/assert-runtime-capabilities.mjs";

test("the shipped runtime retains exact session routing and task completion wakes", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const result = assertRuntimeCapabilities(root);
  assert.deepEqual(result.capabilities, ["agentProtocol", "exactSessionRouting", "taskCompletionWake"]);
});

test("the release gate rejects a runtime whose capability wiring disappeared", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-runtime-capabilities-"));
  try {
    for (const files of Object.values(REQUIRED_RUNTIME_CAPABILITIES)) {
      for (const [relative, markers] of Object.entries(files)) {
        const absolute = path.join(root, relative);
        fs.mkdirSync(path.dirname(absolute), { recursive: true });
        fs.writeFileSync(absolute, markers.join("\n"));
      }
    }
    assert.equal(assertRuntimeCapabilities(root).ok, true);
    fs.writeFileSync(path.join(root, "src", "session-delivery.js"), "feature removed\n");
    assert.throws(() => assertRuntimeCapabilities(root), /exactSessionRouting/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
