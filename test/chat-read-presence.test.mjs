import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  DEFAULT_IDLE_THRESHOLD_SECONDS,
  chatReadPresenceAvailable,
  observedFreshSystemInput,
} = require("../overlay/chat-read-presence.cjs");

function visibleWindow({ visible = true, minimized = false, destroyed = false } = {}) {
  return {
    isDestroyed: () => destroyed,
    isVisible: () => visible,
    isMinimized: () => minimized,
  };
}

function available(overrides = {}) {
  return chatReadPresenceAvailable({
    window: visibleWindow(),
    systemSuspended: false,
    screenLocked: false,
    loginSessionActive: true,
    resumeNeedsActivity: false,
    idleSeconds: 0,
    ...overrides,
  });
}

test("chat read presence allows a visible chat during five minutes of system-wide activity", () => {
  assert.equal(DEFAULT_IDLE_THRESHOLD_SECONDS, 300);
  assert.equal(available({ idleSeconds: 299 }), true);
  assert.equal(available({ idleSeconds: 300 }), false);
});

test("chat read presence does not require Relay to have focus", () => {
  const window = { ...visibleWindow(), isFocused: () => false };
  assert.equal(available({ window, idleSeconds: 12 }), true);
});

test("chat read presence fails closed for hidden, minimized, locked, suspended, and post-wake surfaces", () => {
  assert.equal(available({ window: visibleWindow({ visible: false }) }), false);
  assert.equal(available({ window: visibleWindow({ minimized: true }) }), false);
  assert.equal(available({ screenLocked: true }), false);
  assert.equal(available({ systemSuspended: true }), false);
  assert.equal(available({ loginSessionActive: false }), false);
  assert.equal(available({ resumeNeedsActivity: true }), false);
  assert.equal(available({ idleSeconds: Infinity }), false);
});

test("only a real idle-counter drop proves fresh system input after wake", () => {
  assert.equal(observedFreshSystemInput(8, 9), false);
  assert.equal(observedFreshSystemInput(8, 8), false);
  assert.equal(observedFreshSystemInput(8, 0), true);
});
