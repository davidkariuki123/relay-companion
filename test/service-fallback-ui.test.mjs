// The pill with no background service behind it.
//
// Field case, Shane 2026-09-19: an OS reinstall kept ~/.relay and dropped the
// logon tasks. The pill ran, fetched its own Sent messages and read receipts
// live, and painted a Granular chat with Sven's three replies missing, because
// inbound Relay rows only ever arrived through the daemon's local store. Every
// self-heal lived inside the daemon or inside a task that was wiped with it.
//
// main.cjs and inbox.html need Electron to run, so these pin their source the
// way the other pill UI suites do; the decision rule and the repair itself are
// unit-tested in pill-liveness.test.mjs and daemon-repair.test.mjs.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

function read(relativePath) {
  return fs.readFileSync(new URL(relativePath, import.meta.url), "utf8");
}
function between(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

const main = read("../overlay/main.cjs");
const inbox = read("../overlay/inbox.html");

test("the pill judges the daemon's heartbeat on its own tick and repairs it through the shared module", () => {
  const watch = between(main, "const daemonWatchEnabled", "if (relaunchRequested || !transport) return;");
  assert.match(watch, /pillLiveness\.daemonRepairDecision\(\{/, "the rule is the shared one, not a second definition");
  assert.match(watch, /updating: updateInFlight \|\| updateTransactionOpen\(\)/, "an update transaction owns the services");
  assert.match(watch, /if \(decision\.action === "repair"\) void repairCompanionDaemon\(decision\)/);
  assert.match(watch, /decision\.reason === "fresh" && serviceHealth\.daemon !== "ok"\) setServiceHealth\("ok"\)/,
    "a service that came back on its own clears every other state");
  assert.match(watch, /decision\.reason === "pill-just-started" && serviceHealth\.daemon === "ok"\) setServiceHealth\("checking", "pill-just-started"\)/,
    "a missing heartbeat at start already reads rooms from the server, before any verdict");
  const repair = between(main, "function repairCompanionDaemon(decision)", "const startedAt = Date.now();");
  assert.match(repair, /src", "daemon-repair\.js"/, "registration and restart live in src/daemon-repair.js");
  assert.match(repair, /if \(result\.ok\) setServiceHealth\("ok"\);\s*else if \(result\.pending\) setServiceHealth\("repairing", result\.reason, result\.detail\);\s*else setServiceHealth\("stopped", result\.reason, result\.detail\)/);
  assert.match(main, /RELAY_OVERLAY_TEST !== "1" && process\.env\.RELAY_OVERLAY_PERF !== "1";\s*setInterval/,
    "the overlay test and perf harnesses never repair a real machine");
  assert.match(between(main, "function buildPayload()", "// Pushes are serialized"), /service: serviceHealth,/,
    "the renderer is told which state the service is in");
});

test("a Relay room reads the server's page of the conversation while the service is not ok, and only then", () => {
  const helper = between(inbox, "function serviceDegraded()", "function slackVisibilityKey");
  assert.match(helper, /daemon === "checking" \|\| daemon === "repairing" \|\| daemon === "stopped"/);
  assert.match(helper, /function serverTranscriptRoom\(room\)/);
  assert.match(helper, /if \(!chatId \|\| isSlackIntegratedRoom\(room\)\) return false;/, "Slack rooms keep their own path");
  // A room from the local store has no chat id of its own; the page is asked
  // for by one. Groups use their group id, direct rooms the server's list,
  // joined on shared wire thread ids and never on a name (the contact is
  // saved as "Sven Ozwellmann", the sender's profile says "Sven Wellmann").
  assert.match(helper, /if \(room\.isGroup\) return String\(room\.groupId \|\| ""\);/);
  assert.match(helper, /\(payload\.service\?\.chats \|\| \[\]\)\.find\(\(chat\) =>\s*chat\.kind !== "group" && \(chat\.threadIds \|\| \[\]\)\.some/);
  assert.doesNotMatch(helper, /participants|\.name\b/, "no name matching");
  assert.match(helper, /if \(!serviceDegraded\(\) && !serviceFallbackChatIds\.size\) return rooms;/, "healthy rooms are untouched");
  assert.match(inbox, /const rooms = sortConversationRooms\(\[\.\.\.groups, \.\.\.people\]\);[\s\S]{0,240}assignFallbackChatIds\(rooms\);\s*return \{ convos, groups, people, rooms \}/,
    "the ids are assigned where every room view is built, so reconciliation finds the same room again");
  assert.match(inbox, /if \(m\.direction !== "in" \|\| !m\.unread\) continue;[\s\S]{0,200}if \(m\.serverTranscript\) continue;/,
    "a server-read row is never queued for a local ack it cannot have");
  assert.match(inbox, /if \(!m\.unread \|\| m\.serverTranscript\) continue;/);
  const fallback = between(main, "async function refreshServiceFallbackChats", "setInterval(() => { void refreshServiceFallbackChats(); }");
  assert.match(fallback, /if \(serviceHealth\.daemon === "ok" \|\| !deviceToken\(\)\) return;/, "the list is fetched only during the fallback");
  assert.match(fallback, /client\.chats\(\{ surface: "relay" \}\)/);
  assert.match(fallback, /threadIds: Array\.isArray\(chat\.threadIds\)/);
  assert.doesNotMatch(fallback, /participants|lastMessage|preview/, "ids and thread ids only");
  // Every place a Slack or direct room fetches the canonical page now admits a
  // Relay room that is reading from the server.
  assert.match(inbox, /\(!isSlackIntegratedRoom\(room\) && !resolvedDirect && !serverTranscriptRoom\(room\)\) \|\| !room\.chatId/, "the 1 s live refresh");
  assert.match(inbox, /\(isSlackIntegratedRoom\(room\) \|\| serverTranscriptRoom\(room\)\) && room\.chatId && !options\.hydrated/, "the open-room hydration");
  assert.match(inbox, /\(isSlackIntegratedRoom\(room\) \|\| directContactAnchorForChatId\(room\?\.chatId\) \|\| serverTranscriptRoom\(room\)\) && room\?\.chatId/, "the payload-driven refresh");
  assert.match(inbox, /\(isSlackIntegratedRoom\(visibleRoom\) \|\| resolvedDirectAnchor \|\| serverTranscriptRoom\(visibleRoom\)\) && visibleRoom\.chatId/,
    "reading the room still tells the server, so the other side gets its receipt");
});

test("only the other side's rows are projected from the server page, shaped like a staged relay and keyed to the same room", () => {
  const projection = between(inbox, "for (const chat of canonicalChatDetails.values()) {\n      if (!chat?.chatId || !serviceFallbackChatIds.has", "for (const anchor of contactChatAnchors.values())");
  assert.match(projection, /item\.direction !== "inbound"/, "own messages come from the live Sent page; a server copy would double them");
  assert.match(projection, /if \(msgs\.some\(\(message\) => String\(message\.id \|\| ""\) === id\)\) continue;/, "the local store wins by id once it catches up");
  assert.match(projection, /partyKey: groupName\s*\? `group:\$\{groupName\.trim\(\)\.toLowerCase\(\)\}`/, "a group row lands in the same room as its staged twin");
  assert.match(projection, /serverTranscript: true,/);
  assert.match(projection, /if \(integration\?\.provider === "slack"\) continue;/);
});

test("the only thing ever said out loud is a repair that failed, and it is a sentence, not a button", () => {
  assert.match(inbox, /id="serviceStoppedNote" role="status">Relay’s background service stopped and could not be restarted\./);
  assert.match(inbox, /serviceStoppedNoteEl\?\.classList\.toggle\("gone", payload\.service\?\.daemon !== "stopped"\)/);
  const note = between(inbox, '<div class="service-note gone" id="serviceStoppedNote"', "</div>");
  assert.doesNotMatch(note, /<button/i, "no Repair button: the pill already tried, and a person cannot do more from here");
  assert.doesNotMatch(inbox, /payload\.service\?\.daemon === "repairing"[^\n]*textContent/, "a repair in progress is nobody's business");
});
