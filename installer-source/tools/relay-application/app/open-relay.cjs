"use strict";
// One launch owns the CLI result. A ready status left by an older launch is not
// completion, and duplicate OS open events share the same in-flight command.
//
// A pill that is running but held up (a busy computer stalled one for 87
// seconds, Shane 2026-10-16) confirms after the CLI has stopped waiting for
// it. So a CLI that fails, hangs or exits without a confirmation is not the end:
// the pill still counts if it reports itself on screen for this launch within
// confirmMs of the launch starting.
function createRelayOpener({ launch, isVisible, now = Date.now, timeoutMs = 20_000, confirmMs = 60_000, pollMs = 250 }) {
  let pending;
  return function open() {
    if (pending) return pending;
    const since = now();
    pending = Promise.resolve().then(() => new Promise((resolve, reject) => {
      let child;
      let settled = false;
      let watching = false;
      let timer;
      let deadline;
      let poll;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(deadline);
        clearInterval(poll);
        if (error) reject(error);
        else resolve({ opened: true });
      };
      const visible = () => {
        try { if (isVisible(since)) { finish(); return true; } } catch (error) { finish(error); return true; }
        return false;
      };
      const keepWatching = (failure) => {
        if (watching || settled) return;
        watching = true;
        clearTimeout(timer);
        if (visible()) return;
        const remaining = since + confirmMs - now();
        if (remaining <= 0) return finish(failure);
        poll = setInterval(visible, pollMs);
        deadline = setTimeout(() => { if (!visible()) finish(failure); }, remaining);
      };
      try { child = launch(); } catch (error) { finish(error); return; }
      child.once("error", finish);
      child.once("exit", (code) => keepWatching(new Error(code === 0
        ? "Relay did not confirm a visible pill for this launch."
        : `Relay could not open its pill (exit ${code}).`)));
      timer = setTimeout(() => {
        keepWatching(new Error("Relay timed out opening its pill."));
        // Only the short-lived CLI, never the daemon or the existing pill.
        try { child.kill(); } catch {}
      }, timeoutMs);
    })).finally(() => { pending = null; });
    return pending;
  };
}
module.exports = { createRelayOpener };
