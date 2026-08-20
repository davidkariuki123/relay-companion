import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  overlayWanted,
  createHostRunningTracker,
  shouldIgnoreDismiss,
  boundedPresentedRelayIds,
  recoverInterruptedAttentionPrefs,
  hostPollDelayMs,
  sentRefreshDelayMs,
} = require("../overlay/visibility.cjs");
const { loadQueue, saveQueue } = require("../overlay/attention-queue.cjs");

// ---- overlayWanted: the one boolean that decides if the pill window is on screen ----

test("pill shows while a host runs and the user has not dismissed it", () => {
  assert.equal(overlayWanted({ hostRunning: true, trayAvailable: true }), true);
});

test("pill remains available when no desktop host runs", () => {
  assert.equal(overlayWanted({ hostRunning: false, trayAvailable: true }), true);
});

test("legacy host-coupled mode can still be selected explicitly", () => {
  assert.equal(overlayWanted({ persistent: false, hostRunning: false, trayAvailable: true }), false);
});

test("a new-relay attention latch keeps the pill visible without a host", () => {
  assert.equal(overlayWanted({ hostRunning: false, trayAvailable: true, attentionLatched: true }), true);
});

test("an explicit dismissal clears visibility even if a stale latch is present", () => {
  assert.equal(
    overlayWanted({ hostRunning: false, trayAvailable: true, attentionLatched: true, dismissed: true }),
    false,
  );
});

test("dismissed pill stays hidden even while a host runs", () => {
  assert.equal(overlayWanted({ hostRunning: true, trayAvailable: true, dismissed: true }), false);
});

test("tray click (Show Relay) beats a dismissal", () => {
  // showFromTray() clears dismissed and sets trayForcedVisible before calling maybeShow.
  assert.equal(
    overlayWanted({ hostRunning: false, trayForcedVisible: true, trayAvailable: true, dismissed: false }),
    true,
  );
});

test("ghost notification overrides a dismissal while it is on screen", () => {
  assert.equal(
    overlayWanted({ hostRunning: true, trayAvailable: true, dismissed: true, ghostActive: true }),
    true,
  );
});

test("without a tray, dismissal is ignored (the pill must always be reachable)", () => {
  assert.equal(overlayWanted({ hostRunning: true, trayAvailable: false, dismissed: true }), true);
});

// ---- "Keep Relay hidden": a PREFERENCE, which nothing but the user may revoke ----

test("the hidden setting beats a running host", () => {
  assert.equal(overlayWanted({ hostRunning: true, trayAvailable: true, permanentlyHidden: true }), false);
});

test("a new relay's attention latch cannot revoke the hidden setting", () => {
  // This is the whole difference from `dismissed`: pumpAttention deliberately
  // latches the pill visible on arrival, and that must not defeat a stored choice.
  assert.equal(
    overlayWanted({ trayAvailable: true, permanentlyHidden: true, attentionLatched: true }),
    false,
  );
});

test("a ghost banner cannot revoke the hidden setting either", () => {
  assert.equal(
    overlayWanted({ hostRunning: true, trayAvailable: true, permanentlyHidden: true, ghostActive: true }),
    false,
  );
});

test("an explicit open (tray, Relay.lnk/Relay.app, `relay pill`) shows a hidden pill", () => {
  assert.equal(
    overlayWanted({ trayAvailable: true, permanentlyHidden: true, explicitlyOpened: true }),
    true,
  );
});

test("trayForcedVisible alone does NOT show a hidden pill", () => {
  // trayForcedVisible is a host-visibility handoff: pollHosts and
  // refreshOverlayForActiveSpace both clear it whenever a host is running. Gating the
  // hidden setting on it would hide the pill again within one poll of the user
  // opening it — which is why explicitlyOpened exists as its own flag.
  assert.equal(
    overlayWanted({ trayAvailable: true, permanentlyHidden: true, trayForcedVisible: true }),
    false,
  );
});

test("without a tray, the hidden setting is ignored (same law as dismissal)", () => {
  assert.equal(overlayWanted({ hostRunning: true, trayAvailable: false, permanentlyHidden: true }), true);
});

test("the hidden setting is off by default, so existing installs are untouched", () => {
  assert.equal(overlayWanted({ hostRunning: true, trayAvailable: true }), true);
});

test("quiet preferences survive an overlay-prefs round trip, and absent keys read false", () => {
  // writeOverlayPrefs rebuilds the file from a whitelist literal, so this is the
  // shape that has to come back out; a key it forgets is erased within seconds.
  const written = saveQueue(loadQueue({}), {
    dismissed: true,
    attentionLatched: false,
    pillHidden: true,
    soundsMuted: true,
    presentedRelayIds: [],
    activeAttentionIds: [],
  });
  const reread = JSON.parse(JSON.stringify(written));
  assert.equal(reread.pillHidden === true, true);
  assert.equal(reread.soundsMuted === true, true);

  const legacy = JSON.parse(JSON.stringify(saveQueue(loadQueue({}), { dismissed: false })));
  assert.equal(legacy.pillHidden === true, false, "a profile written before these existed is not hidden");
  assert.equal(legacy.soundsMuted === true, false);
});

test("presentation history never evicts ids that are still unread", () => {
  const unread = Array.from({ length: 501 }, (_, i) => `relay_${i}`);
  const bounded = boundedPresentedRelayIds([], unread, unread, 500);
  assert.equal(bounded.length, 501, "all unread ids remain presented, even above the soft cap");
  assert.deepEqual(bounded, unread);
});

test("presentation history returns to its cap by evicting read ids first", () => {
  const existing = Array.from({ length: 501 }, (_, i) => `relay_${i}`);
  const stillUnread = existing.slice(1);
  const bounded = boundedPresentedRelayIds(existing, [], stillUnread, 500);
  assert.equal(bounded.length, 500);
  assert.equal(bounded.includes("relay_0"), false);
  assert.ok(stillUnread.every((id) => bounded.includes(id)));
});

test("an attention stack interrupted by a crash becomes unpresented on restart", () => {
  const recovered = recoverInterruptedAttentionPrefs({
    dismissed: false,
    attentionLatched: true,
    presentedRelayIds: ["relay_seen", "relay_active_1", "relay_active_2"],
    activeAttentionIds: ["relay_active_1", "relay_active_2"],
  });

  assert.deepEqual(recovered.interruptedAttentionIds, ["relay_active_1", "relay_active_2"]);
  assert.deepEqual(recovered.prefs.presentedRelayIds, ["relay_seen"]);
  assert.deepEqual(recovered.prefs.activeAttentionIds, []);
  assert.equal(recovered.prefs.dismissed, false);
  assert.equal(recovered.prefs.attentionLatched, true);
});

test("attention recovery is idempotent and normalizes persisted ids", () => {
  const first = recoverInterruptedAttentionPrefs({
    presentedRelayIds: ["relay_seen", "relay_active", "relay_seen", null],
    activeAttentionIds: ["relay_active", "relay_active", ""],
  });
  const second = recoverInterruptedAttentionPrefs(first.prefs);

  assert.deepEqual(first.interruptedAttentionIds, ["relay_active"]);
  assert.deepEqual(first.prefs.presentedRelayIds, ["relay_seen"]);
  assert.deepEqual(second.interruptedAttentionIds, []);
  assert.deepEqual(second.prefs, first.prefs);
});

// ---- host-running debounce: no blink when a host restarts or a poll misreads ----

test("single missing poll does NOT hide the pill (host auto-update restart)", () => {
  const t = createHostRunningTracker({ missThreshold: 3 });
  assert.equal(t.update(true, false), true);
  assert.equal(t.update(false, false), true, "1st miss ignored");
  assert.equal(t.update(false, false), true, "2nd miss ignored");
  assert.equal(t.update(true, false), true, "host came back; no blink");
});

test("sustained absence hides the pill after the threshold", () => {
  const t = createHostRunningTracker({ missThreshold: 3 });
  t.update(true, false);
  t.update(false, false);
  t.update(false, false);
  assert.equal(t.update(false, false), false, "3rd consecutive miss hides");
});

test("host reappearing shows immediately (no debounce on the ON transition)", () => {
  const t = createHostRunningTracker({ missThreshold: 3 });
  assert.equal(t.update(false, false), false);
  assert.equal(t.update(false, true), true);
});

// ---- dismiss-vs-tray-click race ----

test("a dismiss whose IPC was already in flight at Show Relay (within ~IPC latency) is ignored", () => {
  const clickedAt = 1_000_000;
  assert.equal(shouldIgnoreDismiss({ now: clickedAt + 100, lastTrayShowAt: clickedAt }), true);
});

test("a GENUINE ✕ click shortly after Show Relay is honored (no wide swallow window)", () => {
  const clickedAt = 1_000_000;
  // 300ms after Show Relay is a deliberate user action, not the in-flight-dismiss race.
  assert.equal(shouldIgnoreDismiss({ now: clickedAt + 300, lastTrayShowAt: clickedAt }), false);
});

test("a genuine dismiss (long after any tray click) is honored", () => {
  const clickedAt = 1_000_000;
  assert.equal(shouldIgnoreDismiss({ now: clickedAt + 5_000, lastTrayShowAt: clickedAt }), false);
});

test("a dismiss with no prior tray click is honored", () => {
  assert.equal(shouldIgnoreDismiss({ now: Date.now(), lastTrayShowAt: 0 }), false);
});

test("hostPollDelayMs: fast only while engaged; Windows idles slowest (spawn cost)", () => {
  assert.equal(hostPollDelayMs({ testMode: true }), 1500);
  assert.equal(hostPollDelayMs({ engaged: true, platform: "darwin" }), 1500);
  assert.equal(hostPollDelayMs({ engaged: true, platform: "win32" }), 3000);
  assert.equal(hostPollDelayMs({ engaged: false, platform: "darwin" }), 10000);
  assert.equal(hostPollDelayMs({ engaged: false, platform: "win32" }), 20000);
});

test("hostPollDelayMs: a hidden pill backs off further; engagement still wins", () => {
  // Hidden (dismissed or off screen): host freshness only matters again at the
  // show edge, which takes its own process-list reading.
  assert.equal(hostPollDelayMs({ engaged: false, visible: false, platform: "darwin" }), 30000);
  assert.equal(hostPollDelayMs({ engaged: false, visible: false, platform: "win32" }), 45000);
  // Engagement (a live card / recent hover) always keeps the tight cadence.
  assert.equal(hostPollDelayMs({ engaged: true, visible: false, platform: "darwin" }), 1500);
  // Legacy callers that pass no `visible` keep the visible-idle cadence.
  assert.equal(hostPollDelayMs({ engaged: false, platform: "darwin" }), 10000);
  assert.equal(hostPollDelayMs({ testMode: true, visible: false }), 1500);
});

test("sentRefreshDelayMs: tight while engaged or a card is on stage, slow at rest", () => {
  assert.equal(sentRefreshDelayMs({ testMode: true }), 5000);
  assert.equal(sentRefreshDelayMs({ engaged: true }), 5000);
  assert.equal(sentRefreshDelayMs({ showActive: true }), 5000);
  assert.equal(sentRefreshDelayMs({}), 30000);
});

test("quitRelayCommand stops the daemon BEFORE the pill's own service (macOS) and both scheduled tasks (Windows)", async () => {
  const { quitRelayCommand } = await import("../overlay/visibility.cjs");
  const [sh, args] = quitRelayCommand({ platform: "darwin", uid: 501 });
  assert.equal(sh, "/bin/sh");
  const script = args[1];
  const daemonAt = script.indexOf("gui/501/work.relay.companion ");
  const pillAt = script.indexOf("gui/501/work.relay.companion.pill");
  assert.ok(daemonAt !== -1 && pillAt !== -1, "boots out both services");
  assert.ok(daemonAt < pillAt, "daemon first: the pill's own bootout kills the spawning process");
  assert.match(script, /bootout/, "bootout (not stop/kickstart) is what beats KeepAlive");
  const [cmd, winArgs] = quitRelayCommand({ platform: "win32" });
  assert.equal(cmd, "cmd");
  assert.match(winArgs[1], /Relay Companion Daemon/);
  assert.match(winArgs[1], /Relay Companion Pill/);
});
