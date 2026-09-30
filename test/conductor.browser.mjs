// Real renderer, fake IPC. Conductor needs a Mac and the pill needs Electron;
// this proves what the page paints and what it hands main, on any box.
import assert from "node:assert/strict";
import { chromium } from "playwright";
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 700, height: 850 }, reducedMotion: "reduce" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    window.conductorCalls = [];
    window.executeCalls = [];
    window.surfaces = { "Claude Code": { available: true }, Codex: { available: false, reason: "Codex isn’t installed on this Mac" },
      _claudeDesktop: { available: true }, _claudeCli: { available: false }, _codexDesktop: { available: false }, _codexCli: { available: false } };
    const empty = { account: { paired: true, userId: "self", email: "self@example.com" }, features: {}, ui: { soundsMuted: true }, relays: [], sent: [], contacts: [], outbox: [] };
    window.relay = new Proxy({
      isTestOverlay: true, refresh: async () => empty, contacts: async () => [], rendererReady: () => { window.ready = true; },
      capabilities: async () => window.surfaces,
      accountInfo: async () => ({ ok: true, paired: true, name: "Self", email: "self@example.com" }),
      openInConductor: async (id, prompt) => { window.conductorCalls.push({ id, prompt }); return window.conductorResult || { ok: true, repository: "/w/relay" }; },
      taskExecute: async (id, choice) => {
        window.executeCalls.push(choice ? { id, choice } : id);
        if (!choice) return { ok: false, cancelled: true, choose: window.offerWorkspaces };
        return { ok: true, awaitingCreate: true, message: "Opened in Conductor · check the repository there, then click Create to start" };
      },
    }, { get: (target, key) => key in target ? target[key] : String(key).startsWith("on") ? () => {} : async () => ({ ok: true }) });
  });
  await page.goto(new URL("../overlay/inbox.html", import.meta.url).href);
  await page.waitForFunction(() => window.ready);
  const id = "relay_20260930135457894_4a68af5538f3";
  const fixture = {
    account: { paired: true, userId: "self", email: "self@example.com" }, ui: { soundsMuted: true }, features: { requests: true }, contacts: [], sent: [], outbox: [],
    relays: [{ id, kind: "message", relayNotificationKind: "plain_relay", title: "Ship the installer", forHuman: "Here is where it stands.", forAgent: "Context",
      senderName: "Sven Wellmann", senderEmail: "sven@example.com", createdAt: new Date().toISOString(), attachments: [] }],
  };
  const show = async () => page.evaluate(async (input) => { onPayload(input); await loadAgentSurfaces(); openReader(input.relays[0].id, "relays"); renderReader(); }, fixture);
  const tile = page.locator('#readerActions [data-app-open][data-app="conductor"]');
  const anywhere = async () => page.evaluate(() => /conductor/i.test(document.body.innerText) || Boolean(document.querySelector('[data-app="conductor"], [data-conductor-app], img[src="conductorMark.svg"]')));

  // Neither the row nor the app: nothing.
  await show();
  assert.equal(await tile.count(), 0);
  assert.equal(await anywhere(), false, "an ordinary account without Conductor sees no word of it");
  // The app without the row (a production account on a Mac with Conductor).
  await page.evaluate(() => { window.surfaces = { ...window.surfaces, Conductor: { available: true, reason: "", via: "conductor://" } }; });
  await show();
  assert.equal(await anywhere(), false, "Conductor installed is not enough without the account's row");
  // The row without the app (a developer without Conductor).
  fixture.features.conductor = true;
  await page.evaluate(() => { window.surfaces = { ...window.surfaces, Conductor: { available: false, reason: "Conductor isn’t installed on this Mac", via: "" } }; });
  await show();
  assert.equal(await anywhere(), false, "a developer without Conductor sees no Conductor option");
  // Both: one tile, after the agents on this Mac.
  await page.evaluate(() => { window.surfaces = { ...window.surfaces, Conductor: { available: true, reason: "", via: "conductor://" } }; });
  await show();
  assert.equal(await tile.count(), 1);
  assert.equal(await tile.getAttribute("aria-label"), "Open in Conductor");
  const hosts = await page.locator("#readerActions .th-host-tile").evaluateAll((tiles) => tiles.map((t) => t.getAttribute("data-host")));
  assert.equal(hosts.at(-1), "conductor");
  assert.ok(hosts.includes("claude"), "the agents on this Mac keep their tiles");

  // The click hands main the pull sentence and this Relay's id; the note says
  // the next step is in Conductor.
  await tile.click();
  await page.waitForFunction(() => window.conductorCalls.length === 1);
  const call = (await page.evaluate(() => window.conductorCalls))[0];
  assert.equal(call.id, id);
  assert.equal(call.prompt, `Pull Sven’s relay “Ship the installer” from Relay and tell me what’s happening. Its Relay id is ${id}.`);
  await page.waitForFunction(() => /Opened in Conductor\. Click Create there to start\./.test(document.body.innerText));
  // A refusal from main is shown as main worded it.
  await page.evaluate(() => { window.conductorResult = { ok: false, error: "Conductor did not open. Check that it is installed, then try again." }; });
  await tile.click();
  await page.waitForFunction(() => /Conductor did not open\./.test(document.body.innerText));

  // Settings: one more switch, and turning it off removes the tile.
  await page.evaluate(() => { activeView = "settings"; commitNavigation(); });
  const toggle = page.locator("[data-conductor-app]");
  await toggle.waitFor();
  assert.equal(await toggle.getAttribute("aria-checked"), "true");
  await toggle.click();
  assert.equal(await page.locator("[data-conductor-app]").getAttribute("aria-checked"), "false");
  await show();
  assert.equal(await tile.count(), 0, "the switch decides the tile");
  await page.evaluate(() => { setConductorEnabled(true); });

  // Execute: Conductor is one of the offered pairs, drawn with its own mark,
  // and the pick goes back to main as offered.
  fixture.features.taskExecution = true;
  fixture.relays = [{ id: "task-conductor", kind: "task", relayNotificationKind: "task", title: "Fix login", forHuman: "Please fix it.", forAgent: "Context",
    senderName: "Sven Wellmann", senderEmail: "sven@example.com", createdAt: new Date().toISOString(), attachments: [] }];
  await page.evaluate((input) => {
    window.offerWorkspaces = { question: "Where should the agent work?", caption: "It will read and change files in this folder.",
      options: [{ provider: "conductor", cwd: "/w/relay", name: "relay", app: "Conductor", label: "Conductor · relay", why: "This Task is about relay" },
        { provider: "claude", cwd: "/w/relay", name: "relay", app: "Claude Code", label: "Claude Code · relay", why: "This Task is about relay" }],
      browse: [{ provider: "conductor", app: "Conductor", label: "Conductor · another folder…" }, { provider: "claude", app: "Claude Code", label: "Claude Code · another folder…" }] };
    onPayload(input); openReader("task-conductor", "relays"); renderReader();
  }, fixture);
  await page.locator("[data-native-execute]").click();
  const pick = page.locator('[data-execute-pick][data-provider="conductor"][data-cwd]');
  await pick.waitFor();
  assert.equal(await pick.locator("img").getAttribute("src"), "conductorMark.svg");
  assert.match(await pick.textContent(), /relay\s*Conductor/);
  assert.equal(await page.locator('[data-execute-pick][data-provider="conductor"][data-browse="1"] img').getAttribute("src"), "conductorMark.svg");
  await pick.click();
  await page.locator("[data-native-execute]").waitFor();
  assert.deepEqual((await page.evaluate(() => window.executeCalls)).at(-1), { id: "task-conductor", choice: { provider: "conductor", cwd: "/w/relay", browse: false } });
  // Waiting on Create: the verb is still Execute, with where things stand.
  fixture.nativeExecutions = { "task-conductor": { phase: "conductor_opened", provider: "conductor", status: "Opened in Conductor · check the repository there, then click Create to start" } };
  await page.evaluate((input) => { onPayload(input); renderReader(); }, fixture);
  assert.equal(await page.locator("[data-native-execute]").textContent(), "Execute");
  assert.match(await page.locator("#readerActions").textContent(), /click Create to start/);
  // The agent stamped it Started: main retires its record and Execute is gone.
  delete fixture.nativeExecutions;
  fixture.relays[0].taskStartedAt = new Date().toISOString();
  await page.evaluate((input) => { onPayload(input); renderReader(); }, fixture);
  assert.equal(await page.locator("[data-native-execute]").count(), 0);
  assert.deepEqual(errors, []);
  console.log("PASS: Conductor is painted only with the account's row and the app; the tile hands main the sentence; Execute offers it as a pair and waits on Create.");
} finally { await browser.close(); }
