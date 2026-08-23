// Source-level guards for the three Windows open-flow bugs fixed in 0.1.68:
// the stdout race that sent successful opens to the browser, the ack that retired
// relays which never actually opened, and the "Open in current chat" no-op on
// machines with no claude-hook runtime. main.cjs requires electron at load time, so
// (like pill-read-ui.test.mjs) these read the shipped source — except parseOpenResult,
// which is small and pure enough to lift out and exercise for real.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const main = fs.readFileSync(new URL("../overlay/main.cjs", import.meta.url), "utf8");
const preload = fs.readFileSync(new URL("../overlay/preload.cjs", import.meta.url), "utf8");
const html = fs.readFileSync(new URL("../overlay/inbox.html", import.meta.url), "utf8");
const materializer = fs.readFileSync(new URL("../src/materializer.js", import.meta.url), "utf8");
const codexDesktop = fs.readFileSync(new URL("../src/codex-desktop.js", import.meta.url), "utf8");

// Slice a top-level function by brace counting from its header (string literals in
// this file never contain unbalanced braces, so a plain count is enough).
function sliceFunction(src, header) {
  const start = src.indexOf(header);
  assert.notEqual(start, -1, `missing ${header}`);
  let depth = 0;
  // Start at the body brace, not the first "{" — the parameter list destructures.
  for (let i = src.indexOf(") {", start) + 2; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated ${header}`);
}

const openPacket = sliceFunction(main, "async function openPacket(");
const openTaskDetail = sliceFunction(main, "function openTaskDetail(");
const openInCurrent = sliceFunction(main, "async function openPacketInCurrent(");

// ---- macOS launch ownership ------------------------------------------------

test("a bare second instance cannot reopen the pill", () => {
  const handlerStart = main.indexOf('app.on("second-instance"');
  const handlerEnd = main.indexOf('app.on("activate"', handlerStart);
  assert.notEqual(handlerStart, -1);
  assert.notEqual(handlerEnd, -1);
  const handler = main.slice(handlerStart, handlerEnd);
  const guard = handler.indexOf("if (!nonce) return;");
  const reopen = handler.indexOf("requestExternalReopen(nonce)");
  assert.ok(guard >= 0, "bare second instances need an explicit-intent guard");
  assert.ok(reopen > guard, "the nonce guard must run before reopening the pill");
});

test("the macOS menu-bar icon has a stable shipped identity", () => {
  assert.match(main, /RELAY_TRAY_GUID,[\s\S]*?prepareMacTrayPosition,[\s\S]*?require\("\.\/tray-position\.cjs"\)/);

  const createTray = sliceFunction(main, "function createTray(");
  const register = createTray.indexOf("prepareMacTrayPosition(");
  const construct = createTray.indexOf("new Tray(icon, RELAY_TRAY_GUID)");
  assert.ok(register >= 0, "missing first-run macOS tray position registration");
  assert.ok(construct > register, "the position default must be registered before AppKit constructs the status item");
  assert.match(createTray, /readMacDefaultsNumber\(domain, key, \{ execFileSync \}\)/, "migration uses the tri-state defaults adapter");
  assert.match(createTray, /process\.platform === "darwin"[\s\S]*?new Tray\(icon, RELAY_TRAY_GUID\)/);
  assert.match(createTray, /:\s*new Tray\(icon\)/, "other platforms retain their existing tray semantics");
  assert.match(createTray, /writePillStatus\(\)/, "tray creation must publish observable health state");
  assert.match(main, /preferredPositionKey: process\.platform === "darwin" \? RELAY_TRAY_POSITION_KEY : null/);
  assert.match(main, /preferredPositionDefault: process\.platform === "darwin" \? RELAY_TRAY_DEFAULT_POSITION : null/);
  assert.match(main, /persistentId:[\s\S]*?tray\.getGUID\(\)/, "health reports the native Tray identity");
  assert.match(main, /RELAY_BUNDLE_IDS = \[[\s\S]*?RELAY_MAC_BUNDLE_IDENTIFIER/, "the branded pill remains self-owned when its composer activates");
  assert.match(main, /app\.on\("will-quit", preserveMacTrayPositionForExit\)/);
  assert.match(main, /preserveMacTrayPositionForExit\(\);\s*app\.exit\(0\)/, "app.exit preserves position explicitly");
  assert.match(main, /tray: trayStatus\(\)/);
});

// ---- Fix 1: the CLI stdout race -------------------------------------------

test("open spawns parse stdout on close, never on exit", () => {
  // "exit" fires before the stdout pipe drains on Windows, which emptied `out` and
  // routed a successful open to the web fallback.
  assert.doesNotMatch(main, /child\.on\("exit"/);
  assert.match(openPacket, /child\.on\("close"/);
  assert.match(openTaskDetail, /child\.on\("close"/);
});

test("both open spawns share the hardened result parser", () => {
  assert.match(openPacket, /parseOpenResult\(out\)/);
  assert.match(openTaskDetail, /parseOpenResult\(out\)/);
  assert.doesNotMatch(openPacket, /JSON\.parse\(out\.trim\(\)\)/);
  assert.doesNotMatch(openTaskDetail, /JSON\.parse\(out\.trim\(\)\)/);
});

test("open failure logs stdout as well as stderr", () => {
  for (const fn of [openPacket, openTaskDetail]) {
    assert.match(fn, /"stdout:",\s*\n?\s*tailFor\(out\)/);
    assert.match(fn, /"stderr:",\s*\n?\s*tailFor\(err\)/);
  }
});

// parseOpenResult is pure; lift it out of the source and run it.
const parseOpenResult = new Function(
  `${sliceFunction(main, "function parseOpenResult(")}\nreturn parseOpenResult;`,
)();

test("parseOpenResult reads a clean CLI payload", () => {
  const out = JSON.stringify({ url: "claude://x", skipExternalOpen: true, claudeFreshlyForged: true }, null, 2);
  assert.deepEqual(parseOpenResult(out), {
    url: "claude://x",
    skipExternalOpen: true,
    freshlyForged: true,
    cwd: null,
    cwdReason: null,
    workspaceKey: null,
    error: null,
  });
});

test("parseOpenResult recovers when stdout carries stray non-JSON lines", () => {
  const out = `(node:1) Warning: something\n{\n  "url": "https://relay/app"\n}\ntrailing noise`;
  assert.deepEqual(parseOpenResult(out), {
    url: "https://relay/app",
    skipExternalOpen: false,
    freshlyForged: false,
    cwd: null,
    cwdReason: null,
    workspaceKey: null,
    error: null,
  });
});

test("parseOpenResult returns safe defaults for empty or junk stdout", () => {
  for (const out of ["", "   ", undefined, "not json at all"]) {
    assert.deepEqual(parseOpenResult(out), {
      url: null,
      skipExternalOpen: false,
      freshlyForged: false,
      cwdReason: null,
      workspaceKey: null,
      error: null,
    });
  }
});

test("parseOpenResult carries passport-routing failure context", () => {
  const out = JSON.stringify({ error: "workspace-unmapped", cwdReason: "workspace-unmapped", workspaceKey: "git:github.com/acme/relay" });
  assert.deepEqual(parseOpenResult(out), {
    url: null,
    skipExternalOpen: false,
    freshlyForged: false,
    cwd: null,
    cwdReason: "workspace-unmapped",
    workspaceKey: "git:github.com/acme/relay",
    error: "workspace-unmapped",
  });
});

// ---- Fix 2: only a surfaced relay gets acked -------------------------------

test("openPacket acks exactly once, inside finishOpened", () => {
  assert.match(openPacket, /const finishOpened = \(\) => \{\s*\n\s*if \(!sent\) ackPacket\(packetId\);/);
  assert.equal(openPacket.match(/ackPacket\(/g).length, 1);
  // Every path stops the spinner, including the failing ones.
  assert.match(openPacket, /const finishFailed = \(message\) => \{[\s\S]*?send\("openDone", packetId\)/);
});

test("openPacket surfaced paths ack: test seam, connector reauth, CLI success", () => {
  assert.match(openPacket, /RELAY_OVERLAY_TEST_NO_HOST_OPEN === "1"\) return finishOpened\(\);/);
  assert.match(openPacket, /connectors`\)[\s\S]*?return finishOpened\(\);/);
  assert.match(openPacket, /if \(url \|\| skipExternalOpen\) \{[\s\S]*?finishOpened\(\);\s*\n\s*\} else \{/);
});

test("Codex suppresses the deep-link fallback only after the target task is visibly confirmed", () => {
  // Materialization may suppress codex:// only for the stronger confirmation.
  // A generic notify result (`ok`) means the renderer ran and is insufficient.
  const openedInHostAssignment = materializer.match(/openedInHost = Boolean\(([^;]+)\);/);
  assert.ok(openedInHostAssignment, "missing Codex openedInHost decision");
  assert.doesNotMatch(openedInHostAssignment[1], /\?\.ok\b/);

  // Current Codex Desktop exposes its routed task through the same stable DOM
  // attributes used by app.get_summary. A successful postMessage is only a
  // request; the target row becoming active is the observable route ack.
  assert.ok(codexDesktop.includes("data-app-action-sidebar-thread-id"), "bridge must inspect the target task id");
  assert.ok(codexDesktop.includes("data-app-action-sidebar-thread-active"), "bridge must confirm the target task is active");
  assert.match(codexDesktop, /openConfirmed:\s*Boolean\(openId && reached\)/,
    "desktop result must expose the verified open separately from generic refresh success");

  // focus() is also a request on macOS. The bridge must report the state it can
  // observe after that request, not merely that the call returned without an
  // exception.
  assert.ok(/focused:\s*win\.isFocused\(\)/.test(codexDesktop), "bridge must report observed focus");

  // If either confirmation is absent, the CLI contract leaves skipExternalOpen
  // false and the overlay owns the existing codex:// fallback.
  assert.match(materializer, /skipExternalOpen = openedInHost;/);
  assert.match(openPacket, /if \(url && !skipExternalOpen\) \{[\s\S]*?shell\.openExternal\(url\)/);
});

test("openPacket failure paths recover into the exact local Preview, never the web inbox", () => {
  assert.match(openPacket, /non-developer account:", packetId\);\s*\n\s*return finishFailed\(\);/);
  assert.match(openPacket, /const finishInPreview = \(message\) => \{\s*\n\s*if \(openPreview\(packetId\)\)/);
  assert.match(openPacket, /workspace-unmapped[\s\S]*?finishInPreview\(message\)/);
  assert.match(openPacket, /open spawn error:[\s\S]*?finishInPreview\("Couldn't open this Relay/);
  assert.doesNotMatch(openPacket, /opened on the web instead/);
  assert.doesNotMatch(openPacket, /web fallback failed/);
  assert.doesNotMatch(openPacket, /row\.actionUrl/);
});

test("openError reaches the row through preload and the renderer", () => {
  assert.match(main, /send\("openError", packetId, message\)/);
  assert.match(preload, /onOpenError: \(cb\) => ipcRenderer\.on\("openError", \(_e, id, message\) => cb\(id, message \|\| ""\)\)/);
  assert.match(html, /window\.relay\.onOpenError\(\(id, message\) => \{/);
  // 0.1.81: error notes render through the rebuild-proof rowNotes state (a
  // payload push used to wipe the explanation while the user was reading it).
  assert.match(html, /setRowNote\(id, message, "err"\)/);
  // ...and a retry of the same row wipes the stale message.
  assert.match(html, /clearRowNote\(id\); \/\/ a previous open's failure text/);
  assert.match(html, /function clearRowNote\(id\) \{[\s\S]*?data-err="\$\{CSS\.escape\(id\)\}"/);
});

// ---- Fix 3: no silent staging without the hook runtime ---------------------

test("openPacketInCurrent stages only when the claude-hook runtime is registered", () => {
  assert.equal(openInCurrent.match(/stageInjection\(/g).length, 1);
  assert.match(openInCurrent, /const stageNow = \(\) => \{[\s\S]*?claudeInject\.stageInjection\(/);
  assert.match(openInCurrent, /loadClaudeHooksModule\(\)\.then\(/);
  // 0.1.84: the hook gate now routes through the channel wake tier first,
  // falling back to stageNow when no (or several) channel sessions are live.
  assert.match(openInCurrent, /if \(claudeHooksInstalled\(install\)\) \{\s*\n\s*return tryChannelWake\(\)/);
  assert.match(openInCurrent, /\.then\(\(woke\) => \{\s*\n\s*if \(!woke\) stageNow\(\);/);
});

test("a missing hook runtime installs for next time and opens fresh now", () => {
  // Since 0.1.77 the fallback carries a user-visible note (row note in the pill)
  // so a "current chat" click never silently turns into a new chat.
  assert.match(openInCurrent, /console\.error\([\s\S]*?repairClaudeHooks\(install\);\s*\n\s*fallbackFresh\("Claude needs a restart before in-chat opens work"\);/);
  // The repair must NOT bake process.execPath (the Electron binary) in as the hook's node.
  const repair = sliceFunction(main, "function repairClaudeHooks(");
  assert.match(repair, /install\.installClaudeHooksWithStableLauncher\(undefined, install\.stableNodePath\(node\)\)/);
  assert.match(repair, /no node found on PATH/);
  // No ack on that path — openPacket owns the read state for the fresh open.
  const notInstalled = openInCurrent.slice(openInCurrent.indexOf("if (claudeHooksInstalled(install))"));
  assert.doesNotMatch(notInstalled, /ackPacket\(/);
});

test("the hook check uses install.js exports through a cached lazy import", () => {
  assert.match(main, /let claudeHooksModulePromise = null;/);
  assert.match(main, /claudeHooksModulePromise = import\(installUrl\)/);
  assert.match(main, /install\.claudeSettingsPath\(\)/);
  assert.match(main, /install\.isRelayClaudeHookCommand\(hook\)/);
  // Unreadable/missing settings must read as "not installed".
  assert.match(main, /function claudeHooksInstalled\(install\) \{[\s\S]*?\} catch \{\s*\n\s*return false;/);
});

// claudeHooksInstalled only closes over `fs`, so it can be lifted out and run against a
// settings file written by the REAL installer — the detection is the crux of the fix.
const claudeHooksInstalled = new Function(
  "fs",
  `${sliceFunction(main, "function claudeHooksInstalled(")}\nreturn claudeHooksInstalled;`,
)(fs);

test("claudeHooksInstalled agrees with the real installer", async (t) => {
  const install = await import("../src/install.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-hookcheck-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const settingsPath = path.join(dir, "settings.json");
  const module = { claudeSettingsPath: () => settingsPath, isRelayClaudeHookCommand: install.isRelayClaudeHookCommand };

  assert.equal(claudeHooksInstalled(module), false, "missing file counts as not installed");
  fs.writeFileSync(settingsPath, "{ not json");
  assert.equal(claudeHooksInstalled(module), false, "unparseable file counts as not installed");
  // A settings file full of the user's OWN hooks is still not our runtime.
  fs.writeFileSync(
    settingsPath,
    JSON.stringify({ hooks: { Stop: [{ matcher: "*", hooks: [{ type: "command", command: "echo hi" }] }] } }),
  );
  assert.equal(claudeHooksInstalled(module), false);
  assert.equal(install.installClaudeHooks(undefined, "/usr/bin/node", { settingsPath }).ok, true);
  assert.equal(claudeHooksInstalled(module), true);
  install.uninstallClaudeHooks({ settingsPath });
  assert.equal(claudeHooksInstalled(module), false);
});

// ---- Fix 4: topmost level on Windows --------------------------------------

test("the overlay window uses the screen-saver level on win32", () => {
  assert.match(main, /win\.setAlwaysOnTop\(true, process\.platform === "win32" \? "screen-saver" : "floating"\)/);
});

// ---- 0.1.81: visible hand-off — waiting vs delivered ----------------------

test("stageNow stages, confirms an awaiting-turn hand-off, and arms the delivery watcher", () => {
  assert.match(openInCurrent, /staged = claudeInject\.stageInjection\(/);
  // 0.1.95: the confirmation also names the chat it went to.
  assert.match(openInCurrent, /confirmInjected\("claude", \{ awaitingTurn: true, chat: target\.label \|\| "" \}\)/);
  assert.match(openInCurrent, /watchInjectionDelivery\(packetId, staged\.path, \{/);
  // 0.1.83: the hop is opt-in — default grace is 0 (current chat means current chat).
  assert.match(main, /return Number\.isFinite\(raw\) && raw > 0 \? raw : 0;/);
  assert.match(openInCurrent, /onAutoFresh: \(\) => \{[\s\S]*?send\("injectionAutoFresh", packetId\)[\s\S]*?openPacket\(packetId, \{ fresh: true \}\)/);
});

test("watchInjectionDelivery reports delivery when the consume-once file disappears", async () => {
  const src = sliceFunction(main, "function watchInjectionDelivery(");
  const sent = [];
  const fakeWin = { isDestroyed: () => false, webContents: { send: (...args) => sent.push(args) } };
  const fsMod = await import("node:fs");
  const osMod = await import("node:os");
  const pathMod = await import("node:path");
  const dir = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), "relay-inject-watch-"));
  const stagedPath = pathMod.join(dir, "sess.json");
  fsMod.writeFileSync(stagedPath, "{}");
  const injectionWatchers = new Map();
  const reclaimSrc = sliceFunction(main, "function reclaimInjection(");
  const fn = new Function(
    "fs",
    "win",
    "injectionWatchers",
    "console",
    "AUTO_FRESH_GRACE_MS",
    "process",
    `${reclaimSrc}; ${src}; return watchInjectionDelivery;`,
  )(fsMod, fakeWin, injectionWatchers, { error: () => {} }, 6000, process);
  fn("relay_x", stagedPath, { intervalMs: 20, timeoutMs: 5000 });
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(sent.length, 0, "file still present -> no delivery signal");
  fsMod.rmSync(stagedPath); // the hook consumed it
  await new Promise((r) => setTimeout(r, 120));
  assert.deepEqual(sent, [["injectionDelivered", "relay_x"]]);
  assert.equal(injectionWatchers.size, 0, "watcher cleans up after delivery");
});

test("the renderer shows a persistent waiting note, a delivered flip, and rebuild-proof notes", async () => {
  const fsMod = await import("node:fs");
  const pathMod = await import("node:path");
  const url = await import("node:url");
  const here = pathMod.dirname(url.fileURLToPath(import.meta.url));
  const html = fsMod.readFileSync(pathMod.join(here, "..", "overlay", "inbox.html"), "utf8");
  assert.match(html, /Delivered into \$\{where\} — lands when it next takes a turn/); // the Hand verb is retired
  assert.match(html, /your \\u201c\$\{info\.chat\}\\u201d chat/, "the destination chat is named when known");
  assert.match(html, /Your current chat was idle, so this is opening in a new chat instead\./);
  assert.match(html, /onInjectionAutoFresh/);
  assert.match(html, /✓ Delivered — \$\{chat \? `your/);
  assert.match(html, /onInjectionDelivered/);
  // Notes are rendered from state during row rebuilds, not one-shot DOM writes.
  assert.match(html, /rowNotes\.get\(r\.id\)/);
  const preload = fsMod.readFileSync(pathMod.join(here, "..", "overlay", "preload.cjs"), "utf8");
  assert.match(preload, /onInjectionDelivered: \(cb\) => ipcRenderer\.on\("injectionDelivered"/);
});


test("past the grace window an idle target's injection is reclaimed and the fresh hop fires", async () => {
  const src = sliceFunction(main, "function watchInjectionDelivery(");
  const reclaimSrc = sliceFunction(main, "function reclaimInjection(");
  const sent = [];
  const fakeWin = { isDestroyed: () => false, webContents: { send: (...args) => sent.push(args) } };
  const fsMod = await import("node:fs");
  const osMod = await import("node:os");
  const pathMod = await import("node:path");
  const dir = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), "relay-inject-grace-"));
  const stagedPath = pathMod.join(dir, "sess.json");
  fsMod.writeFileSync(stagedPath, "{}");
  const injectionWatchers = new Map();
  let freshFired = 0;
  const fn = new Function(
    "fs", "win", "injectionWatchers", "console", "AUTO_FRESH_GRACE_MS", "process",
    `${reclaimSrc}; ${src}; return watchInjectionDelivery;`,
  )(fsMod, fakeWin, injectionWatchers, { error: () => {} }, 6000, process);
  fn("relay_idle", stagedPath, { intervalMs: 20, autoFreshMs: 80, onAutoFresh: () => { freshFired += 1; } });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(freshFired, 1, "grace expiry hops to a fresh open");
  assert.equal(fsMod.existsSync(stagedPath), false, "the injection was reclaimed — no later double delivery");
  assert.deepEqual(sent, [["injectionAutoFresh is sent by the caller, not the watcher"]].slice(0, 0), "no delivery event on the reclaim path");
  assert.equal(injectionWatchers.size, 0);
});


// ---- 0.1.84: channel wake tier --------------------------------------------

test("the wake tier addresses the chat's own CLI process, never just its directory", () => {
  // A cwd join cannot identify a chat: several chats commonly share one repo,
  // so the join finds no unique match and the wake silently never fires. The
  // hook records cliPid, which is unique per chat, and the event is addressed
  // to it — so a wake can only ever surface in the chat that was clicked.
  assert.match(openInCurrent, /targetCliPid = Number\(JSON\.parse\(fs\.readFileSync\(rendezvousPath, "utf8"\)\)\.cliPid\) \|\| 0/);
  assert.match(openInCurrent, /if \(!targetCliPid \|\| !channel\.channelWakeAvailable\(RELAY_HOME, targetCliPid\)\) return false/);
  assert.match(openInCurrent, /targetCliPid,/);
  assert.match(openInCurrent, /safeSessionKey\(target\.sessionId\)/);
  assert.match(openInCurrent, /return false; \/\/ no rendezvous -> no join evidence -> hook path/);
  assert.match(openInCurrent, /enqueueChannelEvent\(RELAY_HOME, \{/);
  assert.match(openInCurrent, /confirmInjected\("claude", \{ awaitingTurn: true, channel: true \}\)/);
  // Unclaimed event falls back to session-targeted hook staging — never a dead end.
  assert.match(openInCurrent, /onTimeout: \(\) => \{[\s\S]*?stageNow\(\)/);
  // The wake tier runs only when the hook runtime exists (fallback must work).
  const gated = openInCurrent.indexOf("if (claudeHooksInstalled(install))");
  assert.ok(gated !== -1 && openInCurrent.indexOf("tryChannelWake()", gated) > gated);
  assert.match(html, /Pushed to your current Claude chat — waking it now…/);
});

// ---- 0.1.87: open-status notes reach the thread surfaces too ---------------

test("open-status notes render where actions happen: the reader and every bubble", () => {
  // The topic list carries no actions anymore (chat-first IA) — the note slot
  // lives in the reader page and inside EVERY bubble, rendered from rowNotes
  // state so payload rebuilds keep them. No thread-level note div: it repeated
  // the newest bubble's own note (Sven's double "Copied.").
  assert.match(html, /const note = rowNotes\.get\(r\.id\);/);
  assert.match(html, /data-err="\$\{esc\(r\.id\)\}" data-stop="1">\$\{esc\(\(note && note\.text\) \|\| ""\)\}/);
  assert.match(html, /data-err="\$\{esc\(m\.id\)\}" data-stop="1">\$\{esc\(rowNotes\.get\(m\.id\)\?\.text \|\| ""\)\}/);
  assert.doesNotMatch(html, /threadNote/);
});

// ---- thread detail is chat-shaped -----------------------------------------
// The restyle briefly reversed this (newest first, actions pinned on top) on
// the grounds that bottom-anchoring needs a composer. Read in place it lost the
// shape every messaging app has trained, and the pinned action slab dominated
// the view, so the 0.1.92 order stands.


// ---- 0.1.93: Sent rows get the same three-action menu ---------------------

test("sent rows expand into Preview / Open in Current Chat / Open in New Chat", () => {
  // The shared menu builder has a sent namespace so the two lists wire independently.
  assert.match(html, /const preview = sent \? `data-sent-preview=/);
  assert.match(html, /const cur = sent \? `data-sent-open-current=/);
  assert.match(html, /const fresh = sent \? `data-sent-open-fresh=/);
  // Sent rows render the menu when expanded, and carry a status-note slot.
  assert.match(html, /const openCard = expanded \? openActionsHtml\(id, \{ sent: true, shareLinkUrl: shareCopyUrl \}\) : "";/);
  assert.match(html, /data-err="\$\{esc\(id\)\}">\$\{esc\(rowNotes\.get\(id\)\?\.text \|\| ""\)\}/);
  // Each action routes to its own sent-side path.
  assert.match(html, /source === "sent" && mode === "current" && window\.relay\.openSentInCurrent/);
  assert.match(html, /source === "sent" && mode === "fresh" && window\.relay\.openSentFresh/);
  assert.match(preload, /openSentInCurrent: \(id, host\) => ipcRenderer\.send\("relay:openSentInCurrent", id, host\)/);
  assert.match(html, /window\.relay\.openSentFresh\(id, host \|\| hostKeyFor\(agentAppName\(\)\)\)/);
  assert.match(preload, /openSentFresh: \(id, host\) => ipcRenderer\.send\("relay:openSentFresh", id, host\)/);
});

test("previewing a sent relay reads sentCache and never acks a read receipt", () => {
  const fn = sliceFunction(main, "function previewPayloadForSent(");
  assert.match(fn, /sentCache \|\| \[\]/);
  assert.match(fn, /unread: false/);
  assert.match(fn, /outbound: true/);
  // The shared payload builder falls through to the sent lookup.
  assert.match(main, /return previewPayloadForSent\(id\);/);
});

test("open-in-current on a sent relay forges the sent copy first and never acks", () => {
  assert.match(openInCurrent, /async function openPacketInCurrent\(packetId, \{ sent = false, host: hostOverride = "" \} = \{\}\)/);
  assert.match(openInCurrent, /const stageSentRelayItem = await loadSentStager\(\);/);
  assert.match(openInCurrent, /if \(!sent\) ackPacket\(packetId\);/);
  // The fresh fallback keeps the sent flag, so it opens the sent copy too.
  assert.match(openInCurrent, /openPacket\(packetId, \{ fresh: true, sent, host: hostOverride \}\)/);
  assert.match(main, /ipcMain\.on\("relay:openSentInCurrent"/);
  assert.match(main, /ipcMain\.on\("relay:openSentFresh"/);
  assert.match(main, /openPacket\(id, \{ sent: true, fresh: true, host: String\(host \|\| ""\) \}\)/);
});

test("the agent row opens the Relay's exact provider task or session", () => {
  // Was "the two permanent agent rows…": since 2026-08-17 the footer is ONE
  // row, the app Settings chose (room-reading-laws pins that). What this test
  // guards is unchanged — the row's host reaches main untouched.
  assert.match(preload, /open: \(id, host\) => ipcRenderer\.send\("relay:open", id, host\)/);
  assert.match(preload, /openSent: \(id, host\) => ipcRenderer\.send\("relay:openSent", id, host\)/);
  // The row names its host and that host reaches main unchanged; an open that
  // names NO host falls back to the Settings choice ("Open relays in"), never
  // to the frontmost-window guess (Sven, 2026-08-17: the named app is a promise).
  assert.match(html, /openSent\(id, host \|\| hostKeyFor\(agentAppName\(\)\)\)/);
  assert.match(html, /window\.relay\.open\(id, host \|\| hostKeyFor\(agentAppName\(\)\)\)/);
  assert.match(html, /openRelayFromUI\(id, source, "open", host\)/);

  const sentHandler = main.slice(main.indexOf('ipcMain.on("relay:openSent"'), main.indexOf('// "Open in new chat"'));
  assert.match(sentHandler, /openPacket\(id, \{ sent: true, host: String\(host \|\| ""\) \}\)/);
  const receivedHandler = main.slice(main.indexOf('ipcMain.on("relay:open"'), main.indexOf('// Sent rows get'));
  assert.match(receivedHandler, /openPacket\(id, \{ host: String\(host \|\| ""\) \}\)/);
});

test("Open in Codex imports the request's existing native thread instead of forking it", () => {
  const handler = main.slice(main.indexOf('ipcMain.on("relay:openInCurrent"'), main.indexOf('ipcMain.on("relay:preview"'));
  assert.match(handler, /selectedHost === "codex"[\s\S]*?openPacket\(id, \{ host: "codex" \}\)/);
  assert.doesNotMatch(handler, /selectedHost === "codex"[\s\S]*?fresh: true/);
});

// ---- a notification presents as a banner ----------------------------------

test("a notification presents as a banner, sized to the rows it actually shows", () => {
  const notifyFn = sliceFunction(html, "function notifyArrival(");
  const peekHeightFn = sliceFunction(html, "function peekHeight()");
  // The notification list is unread-only, so at full expanded height a single
  // new relay sat above ~380px of empty card and read as a broken window.
  assert.match(notifyFn, /classList\.add\("peek", "notifying"\)/);
  // Sized AFTER the render, because peekHeight measures the rows now in the DOM.
  assert.match(notifyFn, /renderAll\(\);[\s\S]*sizePeek\(\);/);
  // Relay notifications are `.relay-row`; measuring only the retired
  // `.row` species silently fell back to 118px and clipped the stack.
  assert.match(peekHeightFn, /querySelectorAll\("\.relay-row, \.row"\)/);
  assert.doesNotMatch(notifyFn, /springTo\(EXPANDED\.w, EXPANDED\.h\);/);
  // Engaging with a peek still restores the full chrome via clearPeek.
  const openFullFn = sliceFunction(html, "function openFull()");
  assert.match(openFullFn, /clearPeek\(\);/);
  const clearPeekFn = sliceFunction(html, "function clearPeek()");
  assert.match(clearPeekFn, /cardEl\.classList\.remove\("peek", "notifying"\)/);
  assert.match(peekHeightFn, /querySelectorAll\("\.relay-row, \.row"\)/);
  assert.match(html, /\.card\.peek \.scroll \{[\s\S]*padding-bottom:20px/);
  assert.doesNotMatch(html, /\.card\.peek \.scroll \{[\s\S]{0,300}mask-image/);
});

test("dismissing a visible notification retires it instead of replaying it", () => {
  const dismissFn = sliceFunction(html, "function dismissOverlay()");
  assert.match(dismissFn, /if \(!wasGhost\) sendAttentionDone\(true\)/);
  assert.doesNotMatch(dismissFn, /sendAttentionDone\(false\)/);
});

test("an arrival while the card is open lands in the list — it never re-banners the open inbox", () => {
  // The attention queue presents pending unread one batch at a time; without
  // this guard each batch yanked a just-opened card back to banner height.
  const notifyFn = sliceFunction(html, "function notifyArrival(");
  assert.match(notifyFn, /const onStageFull = fullCardIsOnStage\(\);/);
  assert.match(notifyFn, /if \(onStageFull\) \{/);
  // The on-stage path keeps whatever chrome the card has and settles attention.
  assert.match(notifyFn, /cardEl\.classList\.add\("notifying"\); \/\/ state-only marker; the chrome stays put/);
  assert.match(notifyFn, /sendAttentionDone\(true\);\s*\n\s*return;/);
  // The early return must come BEFORE any peek state is taken, or an arrival
  // over an open card leaves `peeking` true for a banner that never appeared.
  const guard = notifyFn.indexOf("if (onStageFull) {");
  assert.ok(guard > 0 && guard < notifyFn.indexOf("peeking = true;"));
});

test("only a deliberately presented full card counts as on stage", () => {
  const predicate = sliceFunction(html, "function fullCardIsOnStage()");
  const isOnStage = Function(
    "presented", "collapsed", "peeking", "ghost", "cardEl",
    `"use strict"; ${predicate}; return fullCardIsOnStage();`,
  );
  const card = (...classes) => ({ classList: { contains: (name) => classes.includes(name) } });

  assert.equal(isOnStage(true, false, false, false, card()), true);
  assert.equal(isOnStage(false, false, false, false, card()), false, "never presented");
  assert.equal(isOnStage(true, true, false, false, card()), false, "folded to the pill");
  assert.equal(isOnStage(true, false, true, false, card()), false, "showing an arrival banner");
  assert.equal(isOnStage(true, false, false, true, card()), false, "notification-only ghost");
  assert.equal(isOnStage(true, false, false, false, card("offstage")), false, "OS window hidden");
  assert.equal(isOnStage(true, false, false, false, card("bye")), false, "dismissal in progress");
});

// The guard above is only correct if "the card is open" means the reader was
// actually shown it. The DOM boots un-collapsed and unparked, so `!collapsed`
// alone made a launch-time backlog look like an arrival over an open inbox: it
// never bannered, never folded back to the pill, and settled its own attention.
test("a card nobody has opened yet is not 'on stage' — a backlog at launch still banners", () => {
  assert.match(html, /^\s*let presented = false;$/m, "the renderer starts un-presented");

  // Only a deliberate presentation turns it on.
  assert.match(sliceFunction(html, "function trayOpen()"), /presented = true;/);
  assert.match(sliceFunction(html, "function openFull()"), /presented = true;/);
  assert.match(sliceFunction(html, "function setCollapsed("), /if \(!collapsed\) presented = true;/);
  // Parking the card takes it back, so the next arrival banners rather than
  // landing silently in a list nobody is looking at.
  assert.match(sliceFunction(html, "function resetOffstage()"), /presented = false;/);
});

// `notifying` is watched from outside as "an arrival is mid-presentation". The
// on-stage path settles its arrival immediately, so leaving the marker set left
// the card permanently mid-notification for the life of the process.
test("settling an arrival clears the notifying marker on every path", () => {
  const settle = sliceFunction(html, "function sendAttentionDone(");
  assert.match(settle, /cardEl\.classList\.remove\("notifying"\)/);
  // The banner path drops it on the way out, as before.
  assert.match(sliceFunction(html, "function clearPeek()"), /classList\.remove\("peek", "notifying"\)/);
  assert.match(sliceFunction(html, "function foldToPill()"), /classList\.remove\("peek", "notifying"\)/);
});

// Slack-style run grouping is right for chat utterances and wrong for these:
// every row is a whole relay with its own title, actions and moment in time.
// Two relays from one sender collapsed into a single headerless block with one
// timestamp, and David could not tell there were two.


test("theme has two layers — system default, explicit button choice sticks", () => {
  // Boot resolves from the stored choice first, falling back to the OS sheet.
  assert.match(html, /const dark = stored \? stored === "dark" : true;/); // dark is the default face
  // A live OS change re-skins only while no explicit choice exists…
  assert.match(html, /catch \{ document\.documentElement\.dataset\.theme = "dark"; \}/); // dark even if storage fails
  // …and the button persists the explicit pick, ending the follow.
  assert.match(html, /localStorage\.setItem\("relayTheme", toDark \? "dark" : "light"\)/);
});

test("dark mode uses its subtle edge token instead of a hard-coded white cap", () => {
  assert.match(html, /\.card \{[\s\S]*?box-shadow:var\(--shadow-card\)/);
  assert.match(html, /\.card\.collapsed \{[\s\S]*?box-shadow:var\(--shadow-pill\)/);
  assert.match(html, /:root\[data-theme="dark"\][\s\S]*?--paper-edge:rgba\(255,255,255,\.06\)/);
  assert.doesNotMatch(html, /inset 0 1px 0 rgba\(255,255,255,\.9\)/);
});

// The pill is a click-through window with one interactive rectangle carved out
// of it, clamped to CARD_MAX and anchored from the RIGHT. Under-sizing it does
// not clip anything visually — it silently kills input over the uncovered
// strip. Widening the notification to 400 without moving CARD_MAX left the
// leftmost 56px of the card dead, which is exactly where the Relays tab sits,
// so clicking Relays did nothing while Contacts (further right) still worked.
test("the hit region covers the widest card state, not just the expanded one", () => {
  const sizeOf = (name) => {
    const m = html.match(new RegExp(`const ${name} = \\{ w: (\\d+), h: (\\d+) \\}`));
    assert.ok(m, `${name} is declared in inbox.html`);
    return { w: Number(m[1]), h: Number(m[2]) };
  };
  const expanded = sizeOf("EXPANDED");
  const peek = sizeOf("PEEK");
  const max = main.match(/const CARD_MAX = \{ w: (\d+), h: (\d+) \}/);
  assert.ok(max, "CARD_MAX is declared in main.cjs");

  assert.ok(
    Number(max[1]) >= Math.max(expanded.w, peek.w),
    `CARD_MAX.w (${max[1]}) must cover the widest state (expanded ${expanded.w}, peek ${peek.w})`,
  );
  assert.ok(
    Number(max[2]) >= Math.max(expanded.h, peek.h),
    `CARD_MAX.h (${max[2]}) must cover the tallest state`,
  );
});

test("folding publishes the pill hit region before an animation frame can stall", () => {
  const spring = html.slice(html.indexOf("function springTo("), html.indexOf("// ---------- collapse / expand / peek"));
  assert.match(spring, /W\.t = w; H\.t = h;\s*[\s\S]*?publishCardSize\(w, h\);/);
  assert.ok(
    spring.indexOf("publishCardSize(w, h);") < spring.indexOf("requestAnimationFrame(frame)"),
    "the safe destination hit region is sent before the animated frame is scheduled",
  );
});

test("a hidden-to-shown pill cannot leave native click-through state out of step", () => {
  // Reproduction: hide and re-show while the pointer remains over the card.
  // If show writes setIgnoreMouseEvents(true) directly while hitIgnoring is
  // still false, the next applyIgnore(false) is suppressed and every click
  // keeps falling through until the pointer leaves and re-enters.
  const show = sliceFunction(main, "function showOverlayWindow(");
  assert.match(show, /applyIgnore\(true, \{ force: true \}\)/);
  assert.doesNotMatch(show, /win\.setIgnoreMouseEvents/);

  const apply = sliceFunction(main, "function applyIgnore(");
  assert.match(apply, /\{ force = false \} = \{\}/);
  assert.match(apply, /if \(!force && next === hitIgnoring\) return;/);
  assert.ok(
    apply.indexOf("hitIgnoring = next;") < apply.indexOf("win.setIgnoreMouseEvents(next"),
    "the mirror must update before the native click-through write",
  );
  assert.equal(
    [...main.matchAll(/\.setIgnoreMouseEvents\(/g)].length,
    1,
    "applyIgnore must remain the only writer of Electron's native click-through flag",
  );

  const create = sliceFunction(main, "function createWindow(");
  assert.match(create, /applyIgnore\(true, \{ force: true \}\);\s*startHitTest\(\);/);
  assert.doesNotMatch(create, /win\.setIgnoreMouseEvents/);
});

test("reader refreshes cannot steal focus from or block the app underneath", () => {
  const renderReader = html.slice(html.indexOf("function renderReader("), html.indexOf("// ---------- the requests board"));
  assert.doesNotMatch(renderReader, /setFocusable\(true\)/);
  const dressComposer = html.slice(html.indexOf("function dressComposer("), html.indexOf("function requestState("));
  assert.match(dressComposer, /addEventListener\("focus", \(\) => window\.relay\.setFocusable\?\.\(true\)\)/);
  assert.match(dressComposer, /addEventListener\("blur", \(\) => window\.relay\.setFocusable\?\.\(false\)\)/);
  assert.match(html, /window\.addEventListener\("blur", \(\) => window\.relay\.setFocusable\?\.\(false\)\)/);
  const focusHandler = main.slice(main.indexOf('ipcMain.on("relay:setFocusable"'), main.indexOf("// The renderer no longer drives interactivity"));
  assert.match(focusHandler, /event\.sender !== win\.webContents/);
  assert.match(main, /fittedOverlayBounds\(wa, CARD_MAX,/, "the native canvas is allocated once at its maximum size");
  assert.doesNotMatch(main, /function fitOverlayWindowToCard/, "card morphs never resize the native window");
  assert.match(main, /subscribeActiveApplicationChanges/);
  assert.match(main, /observeFrontmostBundle/);
  assert.match(main, /setAlwaysOnTop\(elevated, "floating"\)/);
  assert.match(main, /RELAY_OVERLAY_TEST_TOPMOST/);
  assert.match(main, /RELAY_OVERLAY_TEST_RECORDING/);
  assert.match(main, /isHarness && !isRecordingHarness \? \{ opacity: 0\.55 \} : \{\}/);
  assert.match(main, /ipcMain\.on\("relay:engage"/);
  assert.match(html, /window\.relay\.engage\?\.\(\)/, "a deliberate click raises Relay again after it yielded");
});

test("a background render pass cannot take the keyboard from a composer on Windows", () => {
  // applyView re-runs on every payload push. Its non-contacts branch revokes
  // window focusability; on Windows that deactivates the window, so a 2.5s
  // state poll used to hand the keyboard back to the app under the pill while
  // the user was typing a reply. macOS ignores the revoke, so it stays as-is.
  const applyView = sliceFunction(html, "function applyView(");
  assert.match(
    applyView,
    /else if \(activeView !== "contacts"\) \{[\s\S]*?if \(window\.relay\.setFocusable && !typingInOverlayField\(\)\) window\.relay\.setFocusable\(false\);/,
    "the per-pass revoke must skip a field that is being typed in",
  );
  const guard = sliceFunction(html, "function typingInOverlayField(");
  assert.match(guard, /window\.relay\.platform !== "win32"\) return false/, "the guard is Windows-only");
  assert.match(guard, /document\.hasFocus\(\)/, "once another app has the keyboard the revoke goes through");
  assert.match(guard, /OVERLAY_TEXT_FIELD/);
  assert.match(html, /const OVERLAY_TEXT_FIELD = "textarea, input, \[contenteditable='true'\]";/);
  assert.match(preload, /platform: process\.platform,/, "the renderer learns the platform from preload");
  // The render pass itself never grants: it only defers a revoke.
  assert.doesNotMatch(applyView, /setFocusable\((true|\!)/);
});

test("on Windows and macOS a press on a text field asks for the keyboard", () => {
  // A focusable:false accessory window can receive the press without making
  // the field first responder. Requesting the keyboard on the press avoids a
  // circular dependency on the DOM `focus` event that activation would create.
  const start = html.indexOf('if (window.relay.platform === "win32" || window.relay.platform === "darwin") {');
  assert.notEqual(start, -1, "the press-to-focus grant covers both desktop platforms");
  const block = html.slice(start, html.indexOf("}, { capture: true });", start));
  assert.match(block, /addEventListener\("mousedown"/);
  assert.match(block, /el\.matches\(OVERLAY_TEXT_FIELD\)\) window\.relay\.setFocusable\?\.\(true\)/);
  // A press anywhere else on the card must NOT grant: buttons, rows and tabs
  // stay keyboard-neutral so the pill never steals focus from a mere click.
  assert.doesNotMatch(block, /engage|initAudio/);
  // The revokes that hand the keyboard back are untouched.
  assert.match(html, /window\.addEventListener\("blur", \(\) => window\.relay\.setFocusable\?\.\(false\)\)/);

  const focusHandler = main.slice(main.indexOf('ipcMain.on("relay:setFocusable"'), main.indexOf('ipcMain.on("relay:engage"'));
  assert.match(focusHandler, /process\.platform === "darwin" && !app\.isActive\(\)/);
  assert.match(focusHandler, /app\.focus\(\{ steal: true \}\)/, "macOS activates Relay under the user's text-field press");
  assert.match(focusHandler, /process\.platform === "win32"\) win\.setSkipTaskbar\(true\)/,
    "Windows focus transitions must not expose Electron in the taskbar");
  assert.ok(
    focusHandler.indexOf('app.focus({ steal: true })') < focusHandler.indexOf("win.focus()"),
    "the macOS app activates before its text field is focused",
  );
});

test("selecting pill text grants the keyboard so Ctrl or Command+C copies it", () => {
  const start = html.indexOf('if (window.relay.platform === "win32" || window.relay.platform === "darwin") {');
  assert.notEqual(start, -1);
  const block = html.slice(start, html.indexOf("// Text inputs temporarily make", start));
  assert.match(block, /addEventListener\("mouseup"/);
  assert.match(block, /window\.getSelection\?\.\(\)/);
  assert.match(block, /!selection\.isCollapsed/);
  assert.match(block, /String\(selection\)/);
  assert.match(block, /window\.relay\.setFocusable\?\.\(true\)/);
  assert.ok(
    block.indexOf('addEventListener("mouseup"') < block.lastIndexOf("setFocusable?.(true)"),
    "focus is granted after the selection gesture, not for an ordinary press",
  );
});

// The card is the app; only the notification needed the extra width. Widening
// the app itself makes the pill more intrusive for no benefit.
test("the expanded card stays at its designed width; only the banner is wider", () => {
  assert.match(html, /const EXPANDED = \{ w: 344, h: 524 \};/);
  assert.match(html, /const PEEK = \{ w: 400, h: 118 \};/);
  // The CSS width must track EXPANDED, or the card is letterboxed or clipped.
  assert.match(html, /width:344px; height:524px;/);
});

test("the native hit region starts at the visible expanded size and synchronizes before readiness", () => {
  const expanded = html.match(/const EXPANDED = \{ w: (\d+), h: (\d+) \};/);
  const initial = main.match(/const CARD_INITIAL = \{ w: (\d+), h: (\d+) \}/);
  assert.ok(expanded, "the renderer declares its expanded dimensions");
  assert.ok(initial, "main declares the initial visible card dimensions");
  assert.deepEqual(initial.slice(1), expanded.slice(1), "main cannot boot with a larger invisible hit rect");
  assert.match(main, /let cardSize = \{ w: CARD_INITIAL\.w, h: CARD_INITIAL\.h \}/);

  const publish = html.lastIndexOf("publishCardSize(W.t, H.t);");
  const ready = html.lastIndexOf("if (window.relay.rendererReady) window.relay.rendererReady();");
  assert.notEqual(publish, -1, "the renderer publishes its initial live size");
  assert.ok(publish < ready, "the initial native hit rect is synchronized before main releases queued work");
});

test("card-size IPC updates hit testing without resizing the native compositor surface", () => {
  const sizeHandler = main.slice(main.indexOf('ipcMain.on("relay:cardSize"'), main.indexOf('ipcMain.on("relay:setPos"'));
  assert.match(sizeHandler, /cardSize = \{ w, h \}/);
  assert.doesNotMatch(sizeHandler, /setBounds|fitOverlayWindowToCard/);
  const anchor = main.slice(main.indexOf("function anchorTopRight"), main.indexOf("function showOverlayWindow"));
  assert.match(anchor, /fittedOverlayBounds\(wa, CARD_MAX,/);
  const show = main.slice(main.indexOf("function showOverlayWindow"), main.indexOf("function maybeShow"));
  assert.match(show, /target\.x !== current\.x \|\| target\.y !== current\.y/,
    "forced shows skip an identical AppKit bounds transaction");
});

// The action menu flickered for the first few seconds after opening a relay,
// then settled. Cause: renderRelays rewrites the list wholesale, and
// notifyArrival calls renderAll() OUTSIDE the payload-signature guard — that
// guard lives in onPayload, bound to the `inbox` channel, while arrivals come
// through the separate `newRelay` channel. While the attention stack drained a
// backlog of unread one batch at a time, the list was destroyed and recreated
// once per batch, taking any open menu with it and replaying its 160ms reveal.
// It stopped on its own because backlogs are finite.
test("both relay-list renders skip the DOM write when the markup is unchanged", () => {
  const render = sliceFunction(html, "function renderRelays()");
  // Notification (unread-only) list.
  assert.match(render, /if \(relaysListEl\.innerHTML === nextNotifHtml\) return;/);
  // Conversation list.
  assert.match(render, /if \(relaysListEl\.innerHTML === nextListHtml\) return;/); // topic list keeps main no-op guard
  // The guard has to come BEFORE the write, or it guards nothing.
  const guard = render.indexOf("=== nextListHtml) return;");
  const write = render.indexOf("relaysListEl.innerHTML = nextListHtml;");
  assert.ok(guard > 0 && write > guard, "the guard must precede the write");
  // And nothing may assign the list innerHTML unguarded.
  const assignments = render.match(/relaysListEl\.innerHTML = /g) || [];
  // Three now: the banner, the list, and the empty-banner bail-out — a banner
  // with nothing in it is a glitch, so it clears rather than paints a void.
  assert.equal(assignments.length, 3, "banner, list, and the empty-banner clear");
  assert.match(render, /if \(!nextNotifHtml\) \{/);
});

test("an arrival over an already-open card does not re-render the world", () => {
  // The on-stage branch exists so a batch landing while the card is open lands
  // in the list instead of yanking the chrome. It must not undo that by
  // rebuilding the list underneath the reader.
  const notify = sliceFunction(html, "function notifyArrival(");
  assert.match(notify, /if \(onStageFull\) \{/);
});

test("one completed visible dwell retires a notification — it never re-pops for lack of a click", () => {
  const start = main.indexOf('ipcMain.on("relay:attentionDone"');
  const end = main.indexOf('ipcMain.handle("relay:soundBytes"', start);
  assert.ok(start >= 0 && end > start);
  const handler = main.slice(start, end);
  assert.match(handler, /const confirm = dwelled && visibleNow && !userIsAway\(\)/);
  assert.doesNotMatch(handler, /humanEvidence/);
  assert.doesNotMatch(handler, /currentShow\.inputSeen/);
});
