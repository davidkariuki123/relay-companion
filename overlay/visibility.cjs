// Pure overlay-visibility logic, extracted from main.cjs so the state machine that
// decides when the pill window is on screen is unit-testable without Electron.
//
// Relay is an independently installed desktop surface, not a child of Claude/Codex.
// Keep it available whenever its background process runs; only an explicit dismissal
// hides it. Host-running remains an input for click routing and backwards-compatible
// callers, but closing an agent terminal/app must never make Relay disappear.

function overlayWanted({
  persistent = true,
  hostRunning = false,
  trayForcedVisible = false,
  trayAvailable = false,
  dismissed = false,
  ghostActive = false,
  attentionLatched = false,
  permanentlyHidden = false,
  explicitlyOpened = false,
} = {}) {
  // `permanentlyHidden` is the Settings choice ("Keep Relay hidden"), and it is a
  // PREFERENCE, not a snooze: unlike `dismissed`, nothing in the product may revoke
  // it — not a running host, not a new relay's attention latch, not a ghost banner.
  // Only the user can, and `explicitlyOpened` is how they say so: it is set solely
  // by a deliberate open (tray click, Relay.lnk / Relay.app, `relay pill`), which is
  // also the only route back to the Settings toggle that turns this off.
  //
  // NOT `trayForcedVisible`: that flag is a host-visibility handoff, cleared by both
  // host pollers whenever Claude/Codex is running, so gating on it would hide the
  // pill again within one poll of the user opening it.
  //
  // Gated on trayAvailable for exactly the reason dismissal is (see below): with no
  // status-area icon there is no way back, so hiding has to be inert.
  const hiddenEffective = trayAvailable && permanentlyHidden;
  if (hiddenEffective && !explicitlyOpened) return false;
  const dismissedEffective = trayAvailable && dismissed;
  return (persistent || hostRunning || trayForcedVisible || attentionLatched) && (!dismissedEffective || ghostActive);
}

// Debounced "a host is running" tracker. The OFF transition requires `missThreshold`
// consecutive polls with neither host present: a host relaunching during its own
// auto-update (or one truncated process-list read) must not blink the pill off.
function createHostRunningTracker({ missThreshold = 3 } = {}) {
  let running = false;
  let missStreak = 0;
  return {
    update(claudeRunning, codexRunning) {
      if (claudeRunning || codexRunning) {
        missStreak = 0;
        running = true;
      } else {
        missStreak += 1;
        if (missStreak >= missThreshold) running = false;
      }
      return running;
    },
    get running() {
      return running;
    },
  };
}

// A dismiss whose IPC was ALREADY in flight when a tray "Show Relay" landed would hide
// the pill the user just reopened. The renderer's cancelBye() prevents the exit timer
// from firing after a reopen, so this guard only needs to cover the narrow window where
// the dismiss IPC had already been SENT (~IPC latency). Keep it short — a wide window
// would swallow a GENUINE ✕ click made shortly after Show Relay. lastTrayShowAt must be
// reset once a dismiss is honored so the guard never lingers across interactions.
function shouldIgnoreDismiss({ now, lastTrayShowAt, windowMs = 250 } = {}) {
  if (!lastTrayShowAt) return false;
  const delta = Number(now) - Number(lastTrayShowAt);
  return delta >= 0 && delta < windowMs;
}

// Keep presentation history bounded without ever evicting a relay that is still
// unread. Evicting an unread id would make the next safety poll treat it as new and
// could create an endless re-notification loop on a large inbox.
function boundedPresentedRelayIds(currentIds, newlyPresentedIds, retainedUnreadIds, cap = 500) {
  const ids = new Set(Array.isArray(currentIds) ? currentIds.map(String) : []);
  for (const value of newlyPresentedIds || []) {
    const id = String(value || "");
    if (!id) continue;
    ids.delete(id);
    ids.add(id);
  }
  const retained = new Set(Array.from(retainedUnreadIds || [], String));
  while (ids.size > cap) {
    const evictable = [...ids].find((id) => !retained.has(id));
    if (!evictable) break;
    ids.delete(evictable);
  }
  return [...ids];
}

// An attention stack is recorded as presented before its seven-second animation
// starts. If the process dies during that interval, the renderer never gets to send
// `attentionDone`, so those ids must be put back into the unpresented pool on the next
// launch. Clear the in-flight marker at the same time: if the new process also dies
// before it can present the recovered stack, the ids are already absent from history
// and remain eligible on the following launch.
function recoverInterruptedAttentionPrefs(input = {}) {
  const prefs = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const activeAttentionIds = [...new Set(
    (Array.isArray(prefs.activeAttentionIds) ? prefs.activeAttentionIds : [])
      .map((value) => String(value || ""))
      .filter(Boolean),
  )];
  const active = new Set(activeAttentionIds);
  const presentedRelayIds = [...new Set(
    (Array.isArray(prefs.presentedRelayIds) ? prefs.presentedRelayIds : [])
      .map((value) => String(value || ""))
      .filter(Boolean),
  )].filter((id) => !active.has(id));

  return {
    prefs: { ...prefs, presentedRelayIds, activeAttentionIds: [] },
    interruptedAttentionIds: activeAttentionIds,
  };
}

// ---- adaptive poll cadences (the anti-spawn-storm rules) -------------------
// Host detection spawns real processes (lsappinfo/ps on macOS, tasklist on
// Windows — expensive there and AV-scanned). Poll fast only while the user is
// plausibly about to click the pill; idle machines get a slow heartbeat, and a
// HIDDEN pill (dismissed or not on screen) backs off further still — host
// freshness only matters again at the show edge, which takes its own reading.
// Windows idles slower still because its per-spawn cost dwarfs macOS's.
function hostPollDelayMs({ testMode = false, engaged = false, visible = true, platform = process.platform } = {}) {
  if (testMode) return 1500;
  if (engaged) return platform === "win32" ? 3000 : 1500;
  if (!visible) return platform === "win32" ? 45000 : 30000;
  return platform === "win32" ? 20000 : 10000;
}

// The Sent list re-fetch pulls full bodies for up to 200 relays; at the old
// fixed 5s that is ~17k requests/day per idle machine. Fast only while the
// user is engaged with the pill or a notification is on stage.
function sentRefreshDelayMs({ testMode = false, engaged = false, showActive = false } = {}) {
  if (testMode) return 5000;
  return engaged || showActive ? 5000 : 30000;
}

// The tray's "Quit Relay": one detached shell that stops BOTH background
// services. Order matters — the daemon first, the pill's own service LAST,
// because the second bootout kills the process that spawned the shell.
// launchctl bootout (not kickstart/stop) is the verb that beats KeepAlive;
// the jobs return at next login (RunAtLoad) or when the person opens the
// installed Relay app, whose launcher restores both services before showing the
// pill. `relay pill` alone is intentionally only a UI command.
function quitRelayCommand({ platform = process.platform, uid = 501 } = {}) {
  if (platform === "win32") {
    return [
      "cmd",
      ["/c", 'schtasks /End /TN "Relay Companion Daemon" & schtasks /End /TN "Relay Companion Pill"'],
    ];
  }
  return [
    "/bin/sh",
    [
      "-c",
      `/bin/launchctl bootout gui/${uid}/work.relay.companion 2>/dev/null; ` +
        `/bin/launchctl bootout gui/${uid}/work.relay.companion.pill 2>/dev/null`,
    ],
  ];
}

// Quitting a dockless menu-bar app removes the only persistent affordance the
// person can click. Confirm both the consequence and the ordinary recovery path
// before doing that. The platform-specific wording names the launcher people can
// actually find; it does not imply that hiding/closing the pill stops Relay.
function quitRelayConfirmationOptions({ platform = process.platform } = {}) {
  const reopen = platform === "darwin"
    ? "Open Relay from Spotlight, Launchpad, or Applications to start it again."
    : platform === "win32"
      ? "Open Relay from the Start menu to start it again."
      : "Open Relay again to start it again.";
  return {
    type: "warning",
    buttons: ["Cancel", "Quit Relay"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    message: "Quit Relay?",
    detail: `Relay will stop receiving messages on this computer. ${reopen}`,
  };
}

module.exports = {
  quitRelayCommand,
  quitRelayConfirmationOptions,
  hostPollDelayMs,
  sentRefreshDelayMs,
  overlayWanted,
  createHostRunningTracker,
  shouldIgnoreDismiss,
  boundedPresentedRelayIds,
  recoverInterruptedAttentionPrefs,
};
