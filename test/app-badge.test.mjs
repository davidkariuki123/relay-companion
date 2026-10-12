import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { appBadgeLabel, applyAppBadge } from "../overlay/app-badge.cjs";

test("appBadgeLabel is empty at zero and caps at 99+", () => {
  assert.equal(appBadgeLabel(0), "");
  assert.equal(appBadgeLabel(-3), "");
  assert.equal(appBadgeLabel("x"), "");
  assert.equal(appBadgeLabel(7), "7");
  assert.equal(appBadgeLabel(99), "99");
  assert.equal(appBadgeLabel(140), "99+");
});

test("macOS sets the Dock badge, and clears it at zero", () => {
  const calls = [];
  const app = { dock: { setBadge: (label) => calls.push(label) } };
  applyAppBadge({ app, platform: "darwin", count: 3 });
  applyAppBadge({ app, platform: "darwin", count: 0 });
  assert.deepEqual(calls, ["3", ""]);
});

test("Windows sets the taskbar overlay from the renderer's drawing, and clears it at zero", () => {
  const calls = [];
  const win = { isDestroyed: () => false, setOverlayIcon: (image, description) => calls.push([image, description]) };
  const image = { isEmpty: () => false };
  const nativeImage = { createFromDataURL: (url) => (url === "data:image/png;base64,AA" ? image : null) };
  applyAppBadge({ win, nativeImage, platform: "win32", count: 4, overlayDataUrl: "data:image/png;base64,AA" });
  applyAppBadge({ win, nativeImage, platform: "win32", count: 0, overlayDataUrl: "" });
  assert.deepEqual(calls, [[image, "4 unread"], [null, ""]]);
});

test("Linux sets the launcher count", () => {
  const calls = [];
  const app = { setBadgeCount: (n) => calls.push(n) };
  applyAppBadge({ app, platform: "linux", count: 5 });
  applyAppBadge({ app, platform: "linux", count: 0 });
  assert.deepEqual(calls, [5, 0]);
});

test("the pill publishes its unread count to the app icon", () => {
  const html = fs.readFileSync(new URL("../overlay/inbox.html", import.meta.url), "utf8");
  const preload = fs.readFileSync(new URL("../overlay/preload.cjs", import.meta.url), "utf8");
  const main = fs.readFileSync(new URL("../overlay/main.cjs", import.meta.url), "utf8");
  assert.match(html, /refreshCountLabel\(\);\n\s+publishAppBadge\(n\);/);
  assert.match(preload, /appBadge: \(count, overlay\) => ipcRenderer\.send\("relay:appBadge"/);
  assert.match(main, /ipcMain\.on\("relay:appBadge"/);
  // The new taskbar button and the newly shown Dock icon both get the badge.
  assert.match(main, /setCompanionAppWindow\(win, true, \{ owner: pillOwner \}\);[\s\S]{0,200}syncAppBadge\(\);/);
  assert.match(main, /app\.dock\.show\(\)\)[\s\S]{0,300}syncAppBadge\(\);/);
});
