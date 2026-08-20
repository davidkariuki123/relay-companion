import { nativeTurn } from "./native-turn.js";

function clean(value) {
  return String(value || "").trim();
}

function providerLabel(provider) {
  if (provider === "cowork") return "Claude Cowork";
  if (provider === "claude") return "Claude Code";
  if (provider === "codex") return "Codex";
  return "The provider";
}

/**
 * Convert a provider-owned terminal turn into the one completion document
 * Relay attaches to the Request. Records are newest-first.
 *
 * This deliberately returns null while liveness is ambiguous: a truthful
 * failure is useful only after the native worker has actually settled.
 */
export function providerCompletionCandidate({
  provider,
  records,
  liveState,
  runActive = false,
  terminal = false,
  endedAt = null,
  error = "",
} = {}) {
  if (runActive) return null;
  const state = clean(liveState).toLowerCase();
  const settled = terminal || ["idle", "offline", "completed", "failed", "error", "aborted"].includes(state);
  if (!settled) return null;

  const turn = nativeTurn(records, { terminalAt: endedAt });
  const assistant = turn.records.find(
    (row) => row?.type === "message" && row?.role === "assistant" && clean(row.text),
  );
  if (assistant) {
    return {
      body: clean(assistant.text),
      outcome: "completed",
      completedAt: endedAt || assistant.at || turn.completedAt || new Date().toISOString(),
    };
  }

  const failedRecord = turn.records.find((row) => {
    if (row?.isError) return true;
    const kind = clean(row?.type).toLowerCase();
    return kind === "error" || kind === "turn_aborted" || kind === "aborted";
  });
  const detail = clean(error || failedRecord?.output || failedRecord?.text || failedRecord?.reason);
  const suffix = detail ? `: ${detail.slice(0, 1200)}` : ".";
  return {
    body: `${providerLabel(provider)} ended without a final answer${suffix}`,
    outcome: "failed",
    completedAt: endedAt || failedRecord?.at || turn.completedAt || new Date().toISOString(),
  };
}

/**
 * Convert a canonical Work envelope into local terminal truth. Unlike the
 * legacy transcript reader, this requires the exact provider-authored native
 * start and can be scoped to the Relay-owned turn/cutoff. Materialized session
 * history therefore cannot finish (or even start) a Request.
 */
export function canonicalProviderCompletionCandidate({
  provider,
  presentation,
  expectedTurnId = "",
  startedAfter = "",
} = {}) {
  const turns = Array.isArray(presentation?.turns) ? presentation.turns : [];
  const expected = clean(expectedTurnId);
  const cutoff = Date.parse(clean(startedAfter));
  const turn = [...turns].reverse().find((candidate) => {
    if (!candidate?.nativeStarted || !candidate?.settled) return false;
    if (expected && clean(candidate.key) !== expected) return false;
    const startedAt = Number(candidate.startedAtMs);
    const completedAt = Number(candidate.completedAtMs);
    if (!Number.isFinite(cutoff)) return true;
    if (!Number.isFinite(completedAt) || completedAt < cutoff) return false;
    // Codex supplies the exact Relay-owned turn id. Claude/Cowork return the
    // run timestamp only after native launch, so allow a small start-handshake
    // skew while still rejecting materialized history that settled pre-Start.
    return expected || (Number.isFinite(startedAt) && startedAt >= cutoff - 60_000);
  });
  if (!turn) return null;
  const completedAtMs = Number(turn.completedAtMs);
  const completedAt = Number.isFinite(completedAtMs)
    ? new Date(completedAtMs).toISOString()
    : new Date().toISOString();
  const body = clean(turn.final?.text);
  if (clean(turn.status).toLowerCase() !== "completed" || !turn.finalEligible || !body) return null;
  return { body, outcome: "completed", completedAt, turnId: clean(turn.key) };
}

export function providerCompletionIdempotencyKey({ relayId, provider, sessionId } = {}) {
  return ["provider-completion", clean(relayId), clean(provider) || "unknown", clean(sessionId) || "session"]
    .map((part) => part.replace(/[^0-9A-Za-z._-]+/g, "-"))
    .join("-");
}
