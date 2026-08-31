import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const main = fs.readFileSync(new URL("../overlay/main.cjs", import.meta.url), "utf8");

test("main owns one canonical pushed Work feed behind scoped IPC", () => {
  assert.match(main, /ipcMain\.handle\("relay:runFeed:watch"/);
  assert.match(main, /event\.sender\.send\("relay:runFeed:update", envelope\)/);
  assert.match(main, /ipcMain\.on\("relay:runFeed:unwatch"/);
  assert.match(main, /ipcMain\.handle\("relay:runFeed:detail"/);
  assert.match(main, /ipcMain\.handle\("relay:runFeed:attachment"/);
  assert.match(main, /workEventAuthorized\(event, relayId\)/);
  assert.match(main, /current\.sessionId !== String\(input\.sessionId/);
  assert.match(main, /sender\.once\("destroyed"/);
  assert.match(main, /await unwatchAllWorkFeedsFor\(event\)/);
  assert.match(main, /providerWorkIdentity\(relayId\)/);
  assert.match(main, /coworkNativeEventsToWorkEvents/);
  assert.match(main, /createClaudeNativeWorkEventReconciler/);
  assert.match(main, /canonicalAttachmentReference/);
  assert.match(main, /resolveSafeAttachmentPreview/);
});

test("provider restarts reconnect the watched canonical generation", () => {
  assert.match(main, /async function reconnectCanonicalWorkFeed/);
  assert.equal((main.match(/void reconnectCanonicalWorkFeed\(id\)/g) || []).length, 3);
});
