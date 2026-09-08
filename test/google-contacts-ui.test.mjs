import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import vm from "node:vm";
const require = createRequire(import.meta.url);
const { view } = require("../overlay/google-contacts-ui.cjs");
test("Google contacts distinguishes initial, empty success, permission, transport, and in-flight states", () => {
  assert.equal(view(null, false, false).action, "Connect");
  assert.match(view({ state: "healthy", contactCount: 0 }, false, false).detail, /^0 contacts synced/);
  assert.equal(view({ state: "permission_required", connected: true }, false, false).action, "Reconnect");
  assert.equal(view({ state: "healthy" }, false, true).action, "Try again");
  assert.equal(view({ state: "syncing" }, false, false).disabled, true);
});
function renderer(bridge) {
  const html = readFileSync(new URL("../overlay/inbox.html", import.meta.url), "utf8");
  const block = html.slice(html.indexOf('  const cvGoogleEl ='), html.indexOf('  async function loadContacts()'));
  const elements = new Map(); const intervals = []; let loads = 0;
  const context = vm.createContext({ RelayGoogleContacts: { view }, document: { getElementById(id) { if (!elements.has(id)) elements.set(id, { textContent: "", addEventListener(_, fn) { this.click = fn; } }); return elements.get(id); } }, window: { relay: bridge, addEventListener() {} }, payload: { features: { googleContacts: true } }, signupAccountKey: () => context.accountKey, accountKey: "one", activeView: "contacts", contactsPane: "people", loadContacts: async () => { loads++; }, setInterval: (fn) => intervals.push(fn) });
  vm.runInContext(block, context);
  return { context, elements, intervals, loads: () => loads };
}
test("People connect opens browser, observes completed sync, and refreshes people", async () => {
  let connected = false, opened = 0;
  const r = renderer({ googleContactsStatus: async () => ({ ok: true, result: connected ? { state: "healthy", lastSyncedAt: "2026-09-08T14:00:00Z", contactCount: 2 } : { state: "pending" } }), googleContactsConnect: async () => { opened++; return { ok: true }; } });
  await r.context.loadGoogleContacts();
  await r.elements.get("cvGoogleAction").click(); assert.equal(opened, 1);
  assert.match(r.elements.get("cvGoogleDetail").textContent, /browser/);
  connected = true; await r.context.loadGoogleContacts();
  assert.match(r.elements.get("cvGoogleDetail").textContent, /^2 contacts synced/);
  assert.equal(r.loads(), 1);
});
test("failed sync rechecks permission and stale account responses never paint", async () => {
  let permission = false;
  const r = renderer({ googleContactsStatus: async () => ({ ok: true, result: { state: permission ? "permission_required" : "healthy", connected: true, contactCount: 1 } }), googleContactsSync: async () => { permission = true; return { ok: false }; } });
  await r.context.loadGoogleContacts(); await r.elements.get("cvGoogleAction").click();
  assert.equal(r.elements.get("cvGoogleAction").textContent, "Reconnect");
  let release;
  r.context.window.relay.googleContactsStatus = () => new Promise(resolve => { release = resolve; });
  const pending = r.context.loadGoogleContacts(); r.context.accountKey = "two";
  release({ ok: true, result: { state: "healthy", contactCount: 999 } }); await pending;
  assert.doesNotMatch(r.elements.get("cvGoogleDetail").textContent, /999/);
});

test("Google consent follows the dev API despite a saved production account website", () => {
  const source = readFileSync(new URL("../overlay/main.cjs", import.meta.url), "utf8");
  const block = source.slice(source.indexOf("function googleContactsWebUrl("), source.indexOf("function accountSettingsPath("));
  for (const [api, web, expected] of [
    ["https://dev-api.sendrelays.com", "https://sendrelays.com", "https://dev.sendrelays.com"],
    ["https://api.sendrelays.com", "https://sendrelays.com", "https://sendrelays.com"],
    ["http://localhost:4000", "http://localhost:3000", "http://localhost:3000"],
  ]) {
    const context = vm.createContext({ URL, process: { env: {} }, readConfigFile: () => ({ apiUrl: api }), webBase: () => web });
    vm.runInContext(block, context);
    const url = new URL(context.googleContactsWebUrl("account/with spaces"));
    assert.equal(url.origin, expected); assert.equal(url.pathname, "/app/contacts/google");
    assert.equal(url.searchParams.get("account"), "account/with spaces");
  }
});

test("Google Contacts stays hidden and unreachable outside the Dev feature gate", () => {
  const inbox = readFileSync(new URL("../overlay/inbox.html", import.meta.url), "utf8");
  const main = readFileSync(new URL("../overlay/main.cjs", import.meta.url), "utf8");
  assert.match(inbox, /class="cv-google gone" id="cvGoogle"/);
  assert.match(inbox, /cvGoogleEl\.classList\.toggle\("gone", !people \|\| payload\.features\?\.googleContacts !== true\)/);
  assert.match(inbox, /async function loadGoogleContacts\(\) \{\s*if \(payload\.features\?\.googleContacts !== true\) return;/);
  assert.match(main, /relay:googleContactsStatus[\s\S]*PRODUCT_FEATURES\.googleContacts === true/);
  assert.match(main, /relay:googleContactsSync[\s\S]*PRODUCT_FEATURES\.googleContacts !== true/);
  assert.match(main, /relay:googleContactsConnect[\s\S]*PRODUCT_FEATURES\.googleContacts !== true/);
});
