"use strict";

/**
 * Which face the preview window opens on: the single message it was opened
 * from, or the conversation that message belongs to.
 *
 * A Relay is the two-document species: a human message plus a non-empty agent
 * document. Human-only correspondence is a text message — and a typed text
 * carries no title at all on the wire; titlelessness is the signal. Nothing
 * here may manufacture a subject for one or turn a long text into a Relay.
 * Tasks and system rows keep their dedicated reading faces.
 */

/** Staged kinds that are agent or system output, never someone talking. */
const NON_CHAT_KINDS = new Set([
  // Retired question flow: kept only so a row staged by an old build still
  // opens as a reading surface, never as someone talking.
  "human_question",
  // Tasks-as-relays: a task carries a job brief — always a reading surface.
  "task",
  "task_request",
  "task_open",
  "task_completed",
  "result",
  "share_approval",
  "connector_reauth",
]);

/** The first line that says something, with its Markdown marker stripped. */
function firstLineOf(body) {
  return (
    String(body || "")
      .split("\n")
      .map((line) => line.replace(/^\s*[>#*\-\d.]+\s*/, "").trim())
      .find(Boolean) || ""
  );
}

/** Is this row one line of a conversation rather than a two-document Relay? */
function isChatMessage(row = {}) {
  const kind = String((row && row.relayNotificationKind) || "")
    .trim()
    .toLowerCase();
  if (NON_CHAT_KINDS.has(kind)) return false;
  // A task owns its own reading surface regardless of which document happens
  // to be populated.
  if (row && row.taskId) return false;
  // This is the product discriminator. `type=completion` is transport/control
  // metadata, not permission to render one human document twice as a Relay.
  if (row && (row.hasAgentDocument === true || String(row.forAgent || "").trim())) return false;
  return Boolean(String((row && row.forHuman) || "").trim());
}

/**
 * "chat" opens in the conversation; "message" opens on the reading face;
 * "task" is the reading face wearing the Start composer. A message with no
 * conversation to open into always gets the reading face.
 */
function openingFaceFor(row = {}) {
  const kind = String((row && row.relayNotificationKind) || "").trim().toLowerCase();
  if (kind === "task") return "task";
  if (!String((row && row.threadId) || "").trim()) return "message";
  return isChatMessage(row) ? "chat" : "message";
}

module.exports = {
  NON_CHAT_KINDS,
  firstLineOf,
  isChatMessage,
  openingFaceFor,
};
