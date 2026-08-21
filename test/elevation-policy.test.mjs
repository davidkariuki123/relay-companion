import test from "node:test";
import assert from "node:assert/strict";
import policy from "../overlay/elevation-policy.cjs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { RELAY_MAC_BUNDLE_IDENTIFIER } = require("../src/mac-app-identity.cjs");

const { elevationForFrontmost } = policy;

test("Relay floats over Claude and Codex but yields to every ordinary app", () => {
  assert.equal(elevationForFrontmost({ bundle: "com.anthropic.claudefordesktop", host: "claude", platform: "darwin" }), true);
  assert.equal(elevationForFrontmost({ bundle: "com.openai.codex", host: "codex", platform: "darwin" }), true);
  assert.equal(elevationForFrontmost({ bundle: "net.whatsapp.WhatsApp", host: null, platform: "darwin" }), false);
});

test("Relay's own composer activation preserves the prior elevation", () => {
  const selfBundles = [RELAY_MAC_BUNDLE_IDENTIFIER, "com.github.Electron"];
  assert.equal(elevationForFrontmost({ bundle: RELAY_MAC_BUNDLE_IDENTIFIER, current: true, selfBundles, platform: "darwin" }), true);
  assert.equal(elevationForFrontmost({ bundle: RELAY_MAC_BUNDLE_IDENTIFIER, current: false, selfBundles, platform: "darwin" }), false);
  assert.equal(elevationForFrontmost({ bundle: "com.github.Electron", current: true, selfBundles, platform: "darwin" }), true);
  assert.equal(elevationForFrontmost({ bundle: "com.github.Electron", current: false, selfBundles, platform: "darwin" }), false);
});

test("unknown activation data is conservative and Windows stays topmost", () => {
  assert.equal(elevationForFrontmost({ bundle: "", current: true, platform: "darwin" }), true);
  assert.equal(elevationForFrontmost({ bundle: "", current: false, platform: "darwin" }), false);
  assert.equal(elevationForFrontmost({ bundle: "net.whatsapp.WhatsApp", host: null, platform: "win32" }), true);
});
