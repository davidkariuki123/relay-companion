// Real renderer, fake IPC. No installed apps or accounts are touched.
import assert from "node:assert/strict";
import { chromium } from "playwright";
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 700, height: 850 }, reducedMotion: "reduce" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    window.executeCalls = [];
    const empty = { account: { paired: true, userId: "self", email: "self@example.com" }, features: {}, ui: { soundsMuted: true }, relays: [], sent: [], contacts: [], outbox: [] };
    window.relay = new Proxy({
      isTestOverlay: true, refresh: async () => empty, contacts: async () => [], rendererReady: () => { window.ready = true; },
      taskExecute: async (id) => { window.executeCalls.push(id); return { ok: true, message: "Launched in native app" }; },
    }, { get: (target, key) => key in target ? target[key] : String(key).startsWith("on") ? () => {} : async () => ({ ok: true }) });
  });
  await page.goto(new URL("../overlay/inbox.html", import.meta.url).href);
  await page.waitForFunction(() => window.ready);
  const fixture = {
    account: { paired: true, userId: "self", email: "self@example.com" }, ui: { soundsMuted: true }, features: { requests: true, taskExecution: false }, contacts: [], sent: [], outbox: [],
    relays: [{ id: "task-native", kind: "task", relayNotificationKind: "task", title: "Native launch", forHuman: "Check this Task", forAgent: "Context", senderName: "Test Sender", senderEmail: "sender@example.com", createdAt: new Date().toISOString(), attachments: [] }],
  };
  await page.evaluate((input) => { onPayload(input); openReader("task-native", "relays"); }, fixture);
  assert.equal(await page.locator("[data-native-execute]").count(), 0, "production has no Execute");
  fixture.features.taskExecution = true;
  await page.evaluate((input) => { onPayload(input); renderReader(); }, fixture);
  await page.locator("[data-native-execute]").click();
  assert.deepEqual(await page.evaluate(() => window.executeCalls), ["task-native"]);
  fixture.nativeExecutions = { "task-native": { phase: "accepted", provider: "claude", status: "Working in Claude Code" } };
  await page.evaluate((input) => { onPayload(input); renderReader(); }, fixture);
  assert.equal(await page.locator("[data-native-execute]").textContent(), "Continue in native app");
  assert.match(await page.locator("#readerActions").textContent(), /Working in Claude Code/);
  assert.deepEqual(errors, []);
  console.log("PASS: Execute is hidden in prod; dev launches the exact Task and shows native continuation.");
} finally { await browser.close(); }
