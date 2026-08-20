// "Open in current chat" tier orchestration for the Codex (ChatGPT desktop)
// host. Pure logic with injected seams (like host-select.cjs / visibility.cjs)
// so the fallback ORDER is unit-testable without Electron:
//
//   (a) bridge tier — resume the user's current thread in the primary ChatGPT
//       window and start a real turn in it (codex-desktop.js
//       submitTurnToCodexDesktopThread). If the thread has an OPEN turn, queue
//       behind idle by polling the rollout tail (never interrupt/steer the
//       user's running work: thread-follower-interrupt-turn requires the
//       thread-follower-owner assertion and would kill their turn). A submit
//       only counts once the rollout visibly grows (drive-and-verify).
//   (b) automation tier — write a near-now COUNT=1 heartbeat automation
//       (~/.codex/automations/relay-open-<id>/automation.toml) targeting the
//       thread; the app's own scheduler injects the prompt natively. Stale
//       relay-open automations (>1h) are removed on every pass.
//   (c) fresh tier — the existing fresh-open flow (openPacket --fresh).
//
// Every tier decision is logged with a timestamp. The instruction text is the
// SHARED claude-inject builder: the relay body is never inlined; the model
// fetches it through the Relay MCP tools.

"use strict";

const DEFAULT_IDLE_WAIT_MS = 30000; // poll the rollout tail for task_complete up to 30s
const DEFAULT_VERIFY_GROWTH_MS = 8000;

// Live-fire status (this machine, scratch thread): the bridge ACKS every step
// — resume, start-turn, navigate — but sendMessageFromView acks are
// fire-and-forget, and the started turn never materialized (rollout unchanged,
// no DB update, no reply). The growth gate below caught it exactly as
// designed. Until a bridge submit VERIFIES end-to-end, the automation tier is
// the default path and the bridge tier is opt-in: RELAY_CODEX_BRIDGE_SUBMIT=1
// enables it (its failures still degrade to the automation tier), =0 pins it
// off.
const BRIDGE_SUBMIT_DEFAULT = false;

function bridgeSubmitEnabled(env = process.env) {
  const raw = String((env && env.RELAY_CODEX_BRIDGE_SUBMIT) || "").trim();
  if (raw === "0") return false;
  if (raw === "1") return true;
  return BRIDGE_SUBMIT_DEFAULT;
}

function defaultLog(...args) {
  console.error(`[overlay][codex-current] ${new Date().toISOString()}`, ...args);
}

// Returns { tier: "bridge" | "automation" | "fresh", ... } and NEVER throws:
// any unexpected failure degrades to the fresh tier so a click is never a
// silent dead end. `finish` (ack + spinner stop) fires exactly once for the
// bridge/automation tiers; the fresh tier's openPacket owns its own lifecycle.
async function openCodexInCurrent(
  { packetId, senderName = "", title = "", threadId = null, threadCount = 0 } = {},
  {
    inject, // src/codex-inject.js
    desktop, // src/codex-desktop.js
    codexRunning = false,
    activateHost = () => {},
    finish = () => {},
    fallbackFresh = () => {},
    env = process.env,
    log = defaultLog,
    idleWaitMs = DEFAULT_IDLE_WAIT_MS,
    verifyGrowthMs = DEFAULT_VERIFY_GROWTH_MS,
  } = {},
) {
  const fresh = (why) => {
    log(`fresh tier for ${packetId}: ${why}`);
    // Forward the reason: the overlay surfaces it as a row note so a click that
    // said "current chat" never silently turns into a new chat.
    fallbackFresh("No live Codex thread to hand this to");
    return { tier: "fresh", reason: why };
  };

  try {
    // Self-cleaning pass: every codex open removes relay-open automations
    // older than 1h, whichever tier this click ends up taking.
    try {
      const removed = inject.cleanupStaleOpenAutomations();
      if (removed.length) log(`cleaned ${removed.length} stale relay-open automation(s): ${removed.join(", ")}`);
    } catch {}

    let target = null;
    try {
      target = inject.resolveCurrentCodexThread();
    } catch (error) {
      return fresh(`thread resolution failed: ${error && error.message}`);
    }
    if (!target) return fresh("no current codex thread within the activity window");
    log(
      `resolved current thread ${target.threadId} (${target.busy ? `busy, turn ${target.openTurnId}` : "idle"}, ` +
        `last active ${new Date(target.lastActiveAt).toISOString()})`,
    );

    const instruction = inject.buildInjectionInstruction({ relayId: packetId, senderName, title, threadId, threadCount });

    // ---- (a) bridge tier ----------------------------------------------------
    if (!bridgeSubmitEnabled(env)) {
      log("bridge tier disabled (RELAY_CODEX_BRIDGE_SUBMIT); using the automation tier");
    } else {
      let readyToSubmit = true;
      if (target.busy) {
        log(`thread ${target.threadId} has an open turn; queueing behind idle for up to ${idleWaitMs}ms`);
        const wait = await inject.waitForCodexIdle(target.sessionPath, { timeoutMs: idleWaitMs });
        if (wait.idle) {
          log(`thread went idle after ${wait.waitedMs}ms`);
        } else {
          log(`thread still busy after ${wait.waitedMs}ms; falling back to the automation tier`);
          readyToSubmit = false;
        }
      }
      if (readyToSubmit) {
        try {
          const baseline = inject.rolloutSize(target.sessionPath);
          const submit = await desktop.submitTurnToCodexDesktopThread({ threadId: target.threadId, text: instruction });
          if (submit && submit.submitted) {
            const growth = await inject.waitForRolloutGrowth(target.sessionPath, baseline, { timeoutMs: verifyGrowthMs });
            if (growth.grew) {
              log(`bridge tier delivered into ${target.threadId} (rollout grew after ${growth.waitedMs}ms)`);
              activateHost();
              finish();
              return { tier: "bridge", threadId: target.threadId };
            }
            log(`bridge submit reported ok but the rollout did not grow within ${verifyGrowthMs}ms; falling back`);
          } else {
            log(`bridge submit unavailable/failed (${(submit && submit.reason) || "unknown"}); falling back`);
          }
        } catch (error) {
          log(`bridge tier error: ${error && error.message}; falling back`);
        }
      }
    }

    // ---- (b) automation tier ------------------------------------------------
    if (!codexRunning) {
      // Heartbeat automations fire inside the running app; with no app the
      // fresh path is the only open that actually shows the user something.
      return fresh("codex is not running, so a staged automation would not fire");
    }
    try {
      const automation = inject.writeOpenAutomation({
        relayId: packetId,
        threadId: target.threadId,
        instruction,
      });
      log(
        `automation tier staged ${automation.id} -> thread ${target.threadId}, ` +
          `fires at ${new Date(automation.fireAtMs).toISOString()} (${automation.path})`,
      );
      activateHost();
      finish();
      return { tier: "automation", threadId: target.threadId, automationId: automation.id, fireAtMs: automation.fireAtMs };
    } catch (error) {
      return fresh(`automation staging failed: ${error && error.message}`);
    }
  } catch (error) {
    return fresh(`unexpected error: ${error && error.message}`);
  }
}

module.exports = {
  BRIDGE_SUBMIT_DEFAULT,
  DEFAULT_IDLE_WAIT_MS,
  bridgeSubmitEnabled,
  openCodexInCurrent,
};
