import assert from "node:assert/strict";
import test from "node:test";
import { defaultCodexCommand } from "../src/codex-app-server.js";
import { acpProviderBinary } from "../src/acp-provider-binary.js";
test("native app metadata uses the same bundled Codex as ACP", () => {
  assert.equal(defaultCodexCommand(), acpProviderBinary("codex"));
});
