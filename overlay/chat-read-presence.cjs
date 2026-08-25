"use strict";

const DEFAULT_IDLE_THRESHOLD_SECONDS = 5 * 60;

function windowCanShowChat(window) {
  if (!window || window.isDestroyed?.()) return false;
  if (!window.isVisible?.()) return false;
  if (window.isMinimized?.()) return false;
  return true;
}

function chatReadPresenceAvailable({
  window,
  systemSuspended,
  screenLocked,
  loginSessionActive,
  resumeNeedsActivity,
  idleSeconds,
  idleThresholdSeconds = DEFAULT_IDLE_THRESHOLD_SECONDS,
}) {
  if (!windowCanShowChat(window)) return false;
  if (systemSuspended || screenLocked || !loginSessionActive || resumeNeedsActivity) return false;
  return Number.isFinite(idleSeconds) && idleSeconds < idleThresholdSeconds;
}

function observedFreshSystemInput(previousIdleSeconds, idleSeconds) {
  if (!Number.isFinite(previousIdleSeconds) || !Number.isFinite(idleSeconds)) return false;
  // Idle time normally rises once per second. A meaningful drop is the OS-wide
  // evidence that mouse or keyboard input occurred, even when it happened in
  // another application rather than Relay.
  return idleSeconds < previousIdleSeconds - 0.5;
}

module.exports = {
  DEFAULT_IDLE_THRESHOLD_SECONDS,
  chatReadPresenceAvailable,
  observedFreshSystemInput,
  windowCanShowChat,
};
