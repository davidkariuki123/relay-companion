"use strict";

// Old host registrations can outlive an upgrade. Drain their input without
// parsing it or loading account/session state, and never return agent context.
function drainRetiredHookInput(input = process.stdin, { timeoutMs = 250 } = {}) {
  return new Promise((resolve) => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try {
        input.removeListener("end", finish);
        input.removeListener("close", finish);
        input.removeListener("error", finish);
        input.pause();
        input.destroy();
      } catch {}
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    try {
      input.once("end", finish);
      input.once("close", finish);
      input.once("error", finish);
      input.resume();
    } catch { finish(); }
  });
}

module.exports = { drainRetiredHookInput };
