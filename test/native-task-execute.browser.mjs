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
      taskExecute: async (id, choice) => {
        window.executeCalls.push(choice ? { id, choice } : id);
        if (window.offerWorkspaces && !choice) return { ok: false, cancelled: true, choose: window.offerWorkspaces };
        return { ok: true, message: "Launched in native app" };
      },
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
  // The one question: main offers app-and-workspace pairs, the page shows
  // them in place of the button, and the pick goes back as the choice.
  delete fixture.nativeExecutions;
  await page.evaluate((input) => {
    window.offerWorkspaces = { question: "Where should the agent work?", caption: "It will read and change files in this folder.",
      options: [{ provider: "claude", cwd: "C:\\w\\relay", label: "Claude Code · relay", why: "This Task is about relay" }],
      browse: [{ provider: "claude", label: "Claude Code · another folder…" }] };
    onPayload(input); renderReader();
  }, fixture);
  await page.locator("[data-native-execute]").click();
  await page.locator("[data-execute-pick][data-cwd]").waitFor();
  assert.match(await page.locator("#readerActions").textContent(), /Where should the agent work\?.*It will read and change files in this folder\./s);
  assert.equal(await page.locator("[data-native-execute]").count(), 0, "the verb steps aside while the question is open");
  await page.locator("[data-execute-pick][data-cwd]").click();
  await page.locator("[data-native-execute]").waitFor();
  const calls = await page.evaluate(() => window.executeCalls);
  assert.deepEqual(calls.at(-1), { id: "task-native", choice: { provider: "claude", cwd: "C:\\w\\relay", browse: false } }, "the pick is the offered pair");
  assert.equal(await page.locator("[data-execute-pick]").count(), 0, "a pick closes the question");
  assert.deepEqual(errors, []);
  console.log("PASS: Execute is hidden in prod; dev launches the exact Task, shows native continuation, and asks its one question in the page.");
} finally { await browser.close(); }
