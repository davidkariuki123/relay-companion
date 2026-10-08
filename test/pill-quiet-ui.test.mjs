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

test("Settings offers one New messages choice, loudest to quietest, and a sound switch", () => {
  // ao1 feedback (2026-10-08): "settings around notification style". One value
  // row, never two switches that can contradict each other.
  // Sven's cut (2026-10-08): rows name themselves, so the card has no
  // "Notifications" heading; the value row is the same species as every row.
  const quiet = between(html, "function quietPrefsHtml(info)", "function chatAgentDefaultsHtml()");
  assert.doesNotMatch(quiet, /sv-quiet-title|>Notifications</);
  assert.match(quiet, /<button class="sv-row sv-notify-row" type="button" id="svNotifyRow" aria-expanded="\$\{notifyTrayOpen \? "true" : "false"\}" aria-controls="svNotifyTray">/);
  assert.match(quiet, /<span class="sv-row-name">New messages<\/span>/);
  assert.match(quiet, /<span class="sv-row-value">\$\{esc\(currentChoice\.short\)\}<\/span>/);
  assert.match(quiet, /id="svNotifyTray" role="radiogroup" aria-label="New messages"/);
  const choices = between(html, "const NOTIFY_CHOICES = [", "];");
  assert.deepEqual([...choices.matchAll(/value:"([a-z]+)"/g)].map((m) => m[1]), ["all", "direct", "count", "hidden"]);
  assert.match(choices, /name:"Every message"/);
  assert.match(choices, /name:"Direct messages and mentions"/);
  assert.match(choices, /name:"Just the count"/);
  assert.match(html, /role="radio"[\s\S]{0,120}data-notify-choice="\$\{choice\.value\}"/);
  // The sound switch is one word, with a second line only when it is off
  // for a reason: sounds play only with banners.
  assert.match(quiet, /<div class="sv-row\$\{banners \? "" : " off"\}">\s*<span class="sv-row-copy"><span class="sv-row-name">Sounds<\/span>\$\{banners \? "" : `<span class="sv-row-sub">Only with banners<\/span>`\}<\/span>/);
  assert.match(quiet, /svSwitchHtml\("soundsMuted", !muted, \{ label: "Play sounds", inverted: true, disabled: !banners \}\)/);
  assert.doesNotMatch(html, />Quiet<\/div>|Relay keeps running and collecting your messages/);
  assert.match(html, /role="switch" data-quiet="\$\{esc\(key\)\}"/);
  assert.match(html, /aria-checked="\$\{checked \? "true" : "false"\}"/);
  assert.match(html, /svSwitchHtml\("soundsMuted", !muted, \{[^}]*inverted: true/);
});

test("Menu bar only is pillHidden; every other choice shows the pill and sets the banner style", () => {
  const choose = between(html, "async function chooseNotifyStyle(value)", "// Switch account / sign in");
  assert.match(choose, /const hidden = value === "hidden";/);
  assert.match(choose, /window\.relay\.setPillHidden\(hidden\)/);
  assert.match(choose, /window\.relay\.setSetting\("notification_style", value\)/);
  assert.match(html, /if \(info\.pillHidden === true\) return "hidden";/);
});

test("only arrivals the style lets through are queued; the rest are presented by the count alone", () => {
  const worthy = between(main, "function attentionWorthy(", "\n}\n");
  const attentionWorthy = new Function(`${worthy}\n}\nreturn attentionWorthy;`)();
  const dm = { recipientGroupId: null };
  const group = { recipientGroupId: "grp_1" };
  for (const [row, all, direct, count] of [
    [dm, true, true, false],
    [group, true, false, false],
    [{ ...group, recipientMentioned: true }, true, true, false],
    [{ ...group, kind: "task" }, true, true, false],
    [{ ...group, urgency: "high" }, true, true, false],
  ]) {
    assert.equal(attentionWorthy(row, "all"), all);
    assert.equal(attentionWorthy(row, "direct"), direct);
    assert.equal(attentionWorthy(row, "count"), count);
  }
  const push = between(main, "async function pushInboxNow(", "const sig = JSON.stringify(");
  assert.match(push, /const unreadIds = unreadRows\.filter\(\(row\) => attentionWorthy\(row\)\)/);
  assert.match(push, /markRelaysPresented\(quietIds, /, "a louder style later must not burst a backlog");
  const pump = between(main, "function pumpAttention(", "const digestMode");
  assert.match(pump, /r\.unread && attentionWorthy\(r\)/);
  assert.match(main, /\n\s+notifyStyle,\n\s+onboardingVersions,/, "written to overlay-prefs.json's whitelist");
  assert.match(main, /if \(NOTIFY_STYLES\.has\(next\.notifyStyle\) && next\.notifyStyle !== notifyStyle\) applyNotifyStyle\(next\.notifyStyle\);/);
});

test("the notification section stops clicks, so flipping a switch never folds the card", () => {
  // The preferences card is one .sv-group wrapping the New messages row, the
  // sound switch and the draft-a-Relay switch; the wrapper itself stops clicks.
  const settings = between(html, "function renderSettings()", "function wireSettings()");
  assert.match(settings, /html \+= `<div class="sv-group" id="quietPrefs" data-stop="1"><div class="sv-open-list">\$\{quietPrefsHtml\(info\)\}\$\{milestoneRelaysHtml\(info\)\}<\/div><\/div>`;/);
  // and wireSettings really stops every data-stop zone.
  const wire = between(html, "function wireSettings()", "const slackConnect =");
  assert.match(wire, /for \(const z of settingsViewEl\.querySelectorAll\('\[data-stop="1"\]'\)\) \{\s*z\.addEventListener\("click", \(e\) => e\.stopPropagation\(\)\);/);
  assert.match(wire, /for \(const sw of settingsViewEl\.querySelectorAll\("\[data-quiet\]"\)\) \{\s*sw\.addEventListener\("click", \(\) => toggleQuietPref\(sw\.getAttribute\("data-quiet"\), sw\)\);/);
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

test("one arrival sound, gated once: never for your own taps, never a macOS alert sound", () => {
  // ao1 feedback (2026-10-08): "it makes an error noise every time i interact
  // with the relay box". The old Tink is a macOS ALERT sound and played on every
  // open and fold as well as on arrivals.
  const play = between(html, "function playArrivalSound()", "let audioPrimeQueued");
  assert.match(play, /if \(soundsMuted\) return;/);
  assert.match(play, /now - lastArrivalSoundAt < ARRIVAL_SOUND_GAP_MS/, "a burst of messages is one chime");
  assert.doesNotMatch(html, /playTink|"Tink"/);
  assert.match(html, /window\.relay\.soundBytes\("Arrive"\)/);
  assert.ok(fs.existsSync(new URL("../overlay/sounds/arrive.wav", import.meta.url)));
  assert.ok(!fs.existsSync(new URL("../overlay/sounds/tink.wav", import.meta.url)));
  assert.doesNotMatch(between(main, 'ipcMain.handle("relay:soundBytes"', "\n});"), /\/System\/Library\/Sounds/);
  // Your own open, fold and expand are silent.
  for (const marker of ["function setCollapsed(v)", "function trayOpen()", "function openFull()"]) {
    const at = html.indexOf(marker);
    assert.notEqual(at, -1, marker);
    const body = html.slice(at, html.indexOf("\n  }\n", at));
    assert.doesNotMatch(body, /playArrivalSound\(\)/, marker);
  }
  assert.equal((html.match(/playArrivalSound\(\);/g) || []).length, 3, "banner, ghost banner and on-stage arrival");
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
  assert.match(between(main, "function showFromTray(", "\n}\n"), /explicitlyOpened = true/);
  assert.match(between(main, "function hideFromTray()", "\n}\n"), /explicitlyOpened = false/);
});

test("hiding never strands the user: no status-area icon means the switch is refused", () => {
  const handler = between(main, 'function applyPillHidden(', 'ipcMain.handle("relay:setSoundsMuted"');
  assert.match(handler, /if \(next && !trayAvailable\) return \{ ok: false, error: "no_status_area_icon"/);
  assert.match(html, /info\.canHide !== false/);
  assert.match(html, /const disabled = choice\.value === "hidden" && !canHide && current !== "hidden";/);
  assert.match(main, /canHide: trayAvailable,/, "accountInfo carries it to the renderer");
});

test("turning hiding on drops the queue instead of banking a giant digest for later", () => {
  const handler = between(main, 'function applyPillHidden(', 'ipcMain.handle("relay:setSoundsMuted"');
  assert.match(handler, /attentionQueue\.clear\(\)/);
  // Not abortShow: that counts a failed attempt and would strand the entry sticky
  // forever, since a hidden pill never presents again.
  assert.match(handler, /abortCurrentShow\("hidden-by-setting", \{ penalize: false \}\)/);
  const abort = between(main, "function abortCurrentShow(", "\n}\n");
  assert.match(abort, /penalize = true/);
  assert.match(abort, /else attention\.drop\(attentionQueue, id\)/);
});

test("turning hiding off clears dismissed too, or the switch would appear to do nothing", () => {
  const handler = between(main, 'function applyPillHidden(', 'ipcMain.handle("relay:setSoundsMuted"');
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
