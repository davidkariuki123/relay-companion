import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const html = fs.readFileSync(new URL("../overlay/inbox.html", import.meta.url), "utf8");
const preload = fs.readFileSync(new URL("../overlay/preload.cjs", import.meta.url), "utf8");
const main = fs.readFileSync(new URL("../overlay/main.cjs", import.meta.url), "utf8");

function between(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(end, -1, `missing marker: ${endMarker}`);
  return source.slice(start, end);
}

/** Drop line comments — this file's "must NOT contain" assertions are about code. */
function codeOnly(source) {
  return source.replace(/^\s*\/\/.*$/gm, "");
}

// "Show Relay automatically" and "Play sounds" are PREFERENCES, not snoozes:
// once set, nothing in the product may undo them except the user. These pin the
// pieces that make that true end to end.

test("Settings names notification controls positively and keeps their copy concise", () => {
  assert.match(html, /<div class="sv-quiet-title">Notifications<\/div>/);
  assert.match(html, /\.sv-open-title, \.sv-quiet-title \{[^}]*font-size:15px/);
  assert.match(html, /\.sv-quiet-title \{ margin-bottom:10px; \}/);
  assert.match(html, /<span class="sv-quiet-name">Show Relay automatically<\/span>/);
  assert.match(html, /<span class="sv-quiet-note">\$\{canHide[\s\S]*?"When new messages arrive\."/);
  assert.match(html, /<span class="sv-quiet-name">Play sounds<\/span>/);
  assert.match(html, /<span class="sv-quiet-note">For new messages\.<\/span>/);
  assert.doesNotMatch(html, />Quiet<\/div>|Relay keeps running and collecting your messages/);
  assert.match(html, /role="switch" data-quiet="\$\{esc\(key\)\}"/);
  assert.match(html, /aria-checked="\$\{checked \? "true" : "false"\}"/);
  assert.match(html, /svSwitchHtml\("pillHidden", !hidden, \{[^}]*inverted: true/);
  assert.match(html, /svSwitchHtml\("soundsMuted", !muted, \{[^}]*inverted: true/);
});

test("the notification section stops clicks, so flipping a switch never folds the card", () => {
  const section = between(html, 'class="sv-quiet-section" id="quietPrefs"', "</div>");
  assert.match(section, /data-stop="1"/);
});

test("the toggles reach main through named IPC channels", () => {
  assert.match(html, /const nextChecked = el\.getAttribute\("aria-checked"\) !== "true"/);
  assert.match(html, /data-quiet-inverted"\) === "1" \? !nextChecked : nextChecked/);
  assert.match(html, /window\.relay\.setPillHidden\(next\)/);
  assert.match(html, /window\.relay\.setSoundsMuted\(next\)/);
  assert.match(preload, /setPillHidden: \(v\) => ipcRenderer\.invoke\("relay:setPillHidden", Boolean\(v\)\)/);
  assert.match(preload, /setSoundsMuted: \(v\) => ipcRenderer\.invoke\("relay:setSoundsMuted", Boolean\(v\)\)/);
  assert.match(main, /ipcMain\.handle\("relay:setPillHidden"/);
  assert.match(main, /ipcMain\.handle\("relay:setSoundsMuted"/);
});

test("both preferences are written to overlay-prefs.json, whose writer is a whitelist", () => {
  const write = between(main, "function writeOverlayPrefs()", "// Commit startup recovery");
  assert.match(write, /\n\s+pillHidden,/, "a key missing from this literal is erased on the next write");
  assert.match(write, /\n\s+soundsMuted,/);
  assert.match(main, /let pillHidden = overlayPrefs\.pillHidden === true;/);
  assert.match(main, /let soundsMuted = overlayPrefs\.soundsMuted === true;/);
});

test("playTink is gated once, so every sound Relay makes is muted together", () => {
  const play = between(html, "function playTink()", "window.addEventListener(\"mousedown\"");
  assert.match(play, /if \(soundsMuted\) return;/);
  // All six call sites route through playTink; assert none of them grew a bypass.
  assert.doesNotMatch(html, /tinkBuf.*createBufferSource[\s\S]{0,80}playTink/);
  assert.match(html, /soundsMuted = Boolean\(next\.ui && next\.ui\.soundsMuted\)/, "kept in step with every payload");
  assert.match(main, /\n\s+soundsMuted,\n\s+\},/, "shipped to the renderer on payload.ui");
});

test("a hidden pill presents nothing: pumpAttention returns before it can touch the queue", () => {
  const pump = between(main, "function pumpAttention(", "if (userIsAway())");
  assert.match(pump, /if \(pillHidden\) \{/);
  assert.match(pump, /deferredAttention = false;/, "or the 1s return-edge poll spawns a process list every tick");
  // Returning before beginShow is what keeps attempts/sticky/notBefore clean, so
  // the relays present normally the moment the setting goes off.
  assert.ok(!codeOnly(pump).includes("attention.beginShow"), "the gate must precede beginShow");
});

test("a hidden pill does not spin the 2s return pump forever", () => {
  const pump = between(main, "function startReturnPump()", "function reconcileAttentionAfterReturn");
  assert.match(pump, /if \(pillHidden\) return;/);
  assert.match(pump, /if \(pillHidden \|\| !attention\.pendingCount\(attentionQueue\)\)/, "a running pump self-terminates");
  const reconcile = between(main, "function reconcileAttentionAfterReturn()", "function scheduleReturnReconciliation");
  assert.match(reconcile, /if \(pillHidden\) return;/);
});

test("hiding the window pairs with the throttling policy, like every other hide site", () => {
  // maybeShow's hide branch used to be near-dead code; turning automatic display off makes it
  // the primary way the window goes down, so it must release the power-save blocker.
  const show = between(main, "function maybeShow(", "function refreshOverlayForActiveSpace");
  assert.match(show, /win\.hide\(\);[\s\S]{0,600}applyThrottlingPolicy\(\);/);
});

test("the visibility gate uses explicitlyOpened, never trayForcedVisible", () => {
  const show = between(main, "function maybeShow(", "if (wanted) {");
  assert.match(show, /permanentlyHidden: pillHidden/);
  assert.match(show, /explicitlyOpened,/);
  // trayForcedVisible is cleared by both host pollers whenever an agent app runs, so
  // gating on it would re-hide the pill within one poll of the user opening it.
  for (const marker of ["function pollHosts(", "function refreshOverlayForActiveSpace("]) {
    const body = between(main, marker, "\n}\n");
    assert.match(body, /trayForcedVisible = false/, "still a host handoff flag, not an open latch");
  }
  assert.match(between(main, "function showFromTray()", "\n}\n"), /explicitlyOpened = true/);
  assert.match(between(main, "function hideFromTray()", "\n}\n"), /explicitlyOpened = false/);
});

test("hiding never strands the user: no status-area icon means the switch is refused", () => {
  const handler = between(main, 'ipcMain.handle("relay:setPillHidden"', 'ipcMain.handle("relay:setSoundsMuted"');
  assert.match(handler, /if \(next && !trayAvailable\) return \{ ok: false, error: "no_status_area_icon"/);
  assert.match(html, /info\.canHide !== false/);
  assert.match(html, /disabled: !canHide/);
  assert.match(main, /canHide: trayAvailable,/, "accountInfo carries it to the renderer");
});

test("turning hiding on drops the queue instead of banking a giant digest for later", () => {
  const handler = between(main, 'ipcMain.handle("relay:setPillHidden"', 'ipcMain.handle("relay:setSoundsMuted"');
  assert.match(handler, /attentionQueue\.clear\(\)/);
  // Not abortShow: that counts a failed attempt and would strand the entry sticky
  // forever, since a hidden pill never presents again.
  assert.match(handler, /abortCurrentShow\("hidden-by-setting", \{ penalize: false \}\)/);
  const abort = between(main, "function abortCurrentShow(", "\n}\n");
  assert.match(abort, /penalize = true/);
  assert.match(abort, /else attention\.drop\(attentionQueue, id\)/);
});

test("turning hiding off clears dismissed too, or the switch would appear to do nothing", () => {
  const handler = between(main, 'ipcMain.handle("relay:setPillHidden"', 'ipcMain.handle("relay:setSoundsMuted"');
  const off = handler.slice(handler.indexOf("} else {"));
  assert.match(off, /dismissed = false;/);
  // showFromTray would send openFull and snap the card to Relays, throwing the user
  // out of the Settings tab they are standing in.
  assert.ok(!codeOnly(off).includes("showFromTray("), "un-hiding must not bounce the user out of Settings");
});

test("the quiet state is diagnosable rather than looking like a broken pill", () => {
  const status = between(main, "function writePillStatus(", "const sig = JSON.stringify");
  assert.match(status, /pillHidden: Boolean\(pillHidden\)/);
  assert.match(status, /soundsMuted: Boolean\(soundsMuted\)/);
  // The tray tooltip is the only passive surface Relay has (skipTaskbar + dock.hide).
  const tray = between(main, "function syncTray()", "\n}\n");
  assert.match(tray, /unread \? `\$\{unread\} waiting`/);
});

test("Settings values ride on accountInfo, which repaints an open Settings tab", () => {
  // renderSettings only runs on ENTERING the tab, so payload.ui alone would leave a
  // stale switch on screen after a toggle.
  const info = between(main, "function accountInfo()", "\n}\n");
  assert.match(info, /\n\s+pillHidden,/);
  assert.match(info, /\n\s+soundsMuted,/);
  assert.match(html, /settingsInfo = \{ \.\.\.settingsInfo, \[key\]: applied \}/);
});
