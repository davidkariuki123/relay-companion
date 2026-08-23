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

const RISK_MARKER = /<!--\s*relay-output-risk\s+([\s\S]*?)\s*-->/i;

function compact(value, maximum) {
  return clean(value).replace(/\s+/g, " ").slice(0, maximum);
}

/**
 * Split the provider's human result from its private release assessment. The
 * assessment is authored by the same local agent that did the work; Relay's
 * service never sees either document until this device chooses to send the
 * result. Missing or malformed assessments fail closed into human review.
 */
export function parseProviderCompletionDocument(value) {
  const source = clean(value);
  const match = source.match(RISK_MARKER);
  const body = clean(source.replace(RISK_MARKER, ""));
  if (!match) {
    return {
      body,
      assessment: {
        level: "review",
        summary: "The agent did not include a release assessment, so Relay is asking you to check the result before it leaves this device.",
        effects: [],
      },
    };
  }
  try {
    const parsed = JSON.parse(match[1]);
    const level = parsed?.level === "none" ? "none" : "review";
    const summary = compact(parsed?.summary, 500);
    const effects = Array.isArray(parsed?.effects)
      ? parsed.effects.map((item) => compact(item, 240)).filter(Boolean).slice(0, 6)
      : [];
    if (!summary) throw new Error("missing summary");
    return { body, assessment: { level, summary, effects } };
  } catch {
    return {
      body,
      assessment: {
        level: "review",
        summary: "The agent's release assessment could not be read, so Relay is asking you to check the result before it leaves this device.",
        effects: [],
      },
    };
  }
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
    const document = parseProviderCompletionDocument(assistant.text);
    return {
      body: document.body,
      assessment: document.assessment,
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
  const document = parseProviderCompletionDocument(body);
  if (!document.body) return null;
  return {
    body: document.body,
    assessment: document.assessment,
    outcome: "completed",
    completedAt,
    turnId: clean(turn.key),
  };
}

export function providerCompletionIdempotencyKey({ relayId, provider, sessionId } = {}) {
  return ["provider-completion", clean(relayId), clean(provider) || "unknown", clean(sessionId) || "session"]
    .map((part) => part.replace(/[^0-9A-Za-z._-]+/g, "-"))
    .join("-");
}
