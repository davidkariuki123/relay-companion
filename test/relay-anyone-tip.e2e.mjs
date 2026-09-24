// Native close/reopen regression gate. Isolated test home and account; the
// installed Companion, real inbox and clipboard are never changed.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const { _electron: electron } = require(process.env.RELAY_PLAYWRIGHT_MODULE || "playwright");
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "relay-tip-native-"));
const home = path.join(sandbox, "home");
fs.mkdirSync(home);
fs.writeFileSync(path.join(home, "overlay-prefs.json"), JSON.stringify({soundsMuted:true,onboardingVersions:{"user:tip_test_user":2}}));
const config = path.join(sandbox, "config.json");
fs.writeFileSync(config, JSON.stringify({deviceToken:"tip_test_token",deviceId:"tip_test_device",deviceName:"Tip test",user:{id:"tip_test_user",name:"Test User",email:"tip@example.test",accountKind:"human",isDeveloper:false}}));
fs.writeFileSync(path.join(home, "state.json"), JSON.stringify({version:1,account:{},profile:{name:"",handle:"",email:"",transport:{type:"relay_api"}},contacts:[],packets:{},meetingNotes:{},setup:{},emailThreads:{},chats:{}}));
let app;
try {
  app = await electron.launch({
    executablePath:process.env.RELAY_PARITY_ELECTRON || require("electron"),
    args:[fileURLToPath(new URL("../overlay/main.cjs", import.meta.url))],
    env:{...process.env,RELAY_HOME:home,RELAY_CONFIG:config,RELAY_OVERLAY_USER_DATA:path.join(sandbox,"userdata"),
      RELAY_OVERLAY_TEST:"1",RELAY_OVERLAY_TEST_FORCE_ACTIVE:"1",RELAY_OVERLAY_TEST_IGNORE_POINTER:"1",RELAY_OVERLAY_TEST_NO_HOST_OPEN:"1",
      RELAY_WEB_URL:"http://127.0.0.1:9",RELAY_API_URL:"http://127.0.0.1:9"},
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.waitForFunction(() => typeof window.RelayAnyoneTip === "object");
  await app.evaluate(() => global.__relayTest.showFromTray());
  await page.locator(".rat-summary").waitFor();
  assert.equal(await page.locator(".rat-card").isVisible(), false, "the tip opens collapsed");
  await page.getByRole("button", {name:"Expand tip: Five ways to use Relay",exact:true}).click();
  await page.locator(".rat-card").waitFor();
  const first = await page.locator(".rat-slide.active .rat-prompt").innerText();
  assert.match(first, /asking Alice/);
  await page.getByRole("button", {name:"Minimise tip",exact:true}).click();
  assert.equal(await page.locator(".rat-summary").isVisible(), true);
  await page.locator("#closeX").click();
  await page.waitForFunction(() => document.getElementById("card").classList.contains("offstage"));
  assert.equal(await app.evaluate(() => global.__relayTest.state().dismissed), true);
  assert.equal(await app.evaluate(() => global.__relayTest.getWin().isVisible()), false);
  await app.evaluate(() => global.__relayTest.showFromTray());
  await page.locator(".rat-summary").waitFor();
  assert.equal(await page.locator(".rat-card").isVisible(), false);
  assert.equal(await page.locator(".rat-slide.active .rat-prompt").innerText(), first);
  assert.equal(await app.evaluate(() => global.__relayTest.getWin().isVisible()), true);
  await page.locator("#closeX").click();
  // Also cover a reopen while the renderer's 300 ms exit is still in flight.
  await app.evaluate(() => global.__relayTest.showFromTray());
  await page.locator(".rat-summary").waitFor();
  await page.waitForFunction(() => !document.getElementById("card").classList.contains("bye"));
  assert.equal(await app.evaluate(() => global.__relayTest.state().dismissed), false);
  assert.deepEqual(errors, []);
  console.log("PASS: real Electron minimise, native X hide, tray reopen, first-example reset, and reopen during exit.");
} finally {
  if (app) await app.close();
  fs.rmSync(sandbox, {recursive:true,force:true});
}
