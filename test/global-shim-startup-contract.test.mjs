import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const main = fs.readFileSync(new URL("../overlay/main.cjs", import.meta.url), "utf8");

test("the newly activated pill repairs a stale global CLI before its first window", () => {
  const ready = main.indexOf("app.whenReady().then(async () =>");
  const repair = main.indexOf("await repairLegacyGlobalShimBeforeFirstWindow();", ready);
  const window = main.indexOf("createWindow();", ready);

  assert.ok(ready >= 0);
  assert.ok(repair > ready, "startup must invoke the bridge migration");
  assert.ok(window > repair, "the migration must settle before the first pill window");
  assert.match(main, /repairLegacyGlobalCliShim\(\{/);
  assert.match(main, /readCanonicalRuntime\(\{ homeDir: os\.homedir\(\), platform: process\.platform \}\)/);
  assert.match(main, /RELAY_OVERLAY_TEST === "1"/);
});
