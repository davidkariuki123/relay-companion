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

test("an explicit open stays on top when the launcher quits and focus falls back", () => {
  const { startExplicitOpenHold, applyExplicitOpenHold } = policy;
  const selfBundles = [RELAY_MAC_BUNDLE_IDENTIFIER, "work.relay.application"];
  let hold = startExplicitOpenHold({ now: 1000, graceMs: 5000 });
  // Relay.app is briefly frontmost, then macOS hands focus back to Safari.
  let step = applyExplicitOpenHold({ hold, bundle: "work.relay.application", now: 1200, selfBundles });
  assert.equal(step.keep, false, "Relay's own activation defers to the ordinary policy");
  step = applyExplicitOpenHold({ hold: step.hold, bundle: "com.apple.Safari", now: 1600, selfBundles });
  assert.equal(step.keep, true);
  // A later poll still sees Safari: the person has not left, so the pill stays up.
  step = applyExplicitOpenHold({ hold: step.hold, bundle: "com.apple.Safari", now: 60_000, selfBundles });
  assert.equal(step.keep, true);
  // Switching to another app ends the hold and the ordinary policy takes over.
  step = applyExplicitOpenHold({ hold: step.hold, bundle: "net.whatsapp.WhatsApp", now: 61_000, selfBundles });
  assert.deepEqual(step, { hold: null, keep: false });
  hold = step.hold;
  assert.deepEqual(applyExplicitOpenHold({ hold, bundle: "com.apple.Safari", now: 62_000, selfBundles }), { hold: null, keep: false });
});

test("the open itself, not a timer, decides: no hold means the ordinary policy", () => {
  const { applyExplicitOpenHold } = policy;
  assert.deepEqual(applyExplicitOpenHold({ hold: null, bundle: "com.apple.Safari", now: 1 }), { hold: null, keep: false });
});

test("the Dock's Relay.app counts as Relay itself", async () => {
  const fs = await import("node:fs");
  const source = fs.readFileSync(new URL("../overlay/main.cjs", import.meta.url), "utf8");
  const ids = source.slice(source.indexOf("const RELAY_BUNDLE_IDS = ["), source.indexOf("].filter(Boolean);", source.indexOf("const RELAY_BUNDLE_IDS = [")));
  assert.match(ids, /"work\.relay\.application"/);
  assert.match(source, /explicitOpenHold = startExplicitOpenHold\(/, "every explicit open starts the hold");
});
