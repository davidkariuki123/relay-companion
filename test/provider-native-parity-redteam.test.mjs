import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const redteamPackageRoot = path.join(dirname, "..");
const redteamRepoRoot = path.join(redteamPackageRoot, "../..");
const sourceRepoRoot = path.resolve(process.env.RELAY_PARITY_SOURCE_ROOT || redteamRepoRoot);
const packageRoot = path.join(sourceRepoRoot, "packages/companion");
const fixtureRoot = path.join(dirname, "fixtures/codex-parity");
const claudeFixture = JSON.parse(fs.readFileSync(path.join(fixtureRoot, "claude-native-work.json"), "utf8"));
const claudeAttachmentFixture = JSON.parse(fs.readFileSync(path.join(fixtureRoot, "claude-native-attachments.json"), "utf8"));
const coworkFixture = JSON.parse(fs.readFileSync(path.join(fixtureRoot, "cowork-native-work.json"), "utf8"));

const providerPath = path.join(packageRoot, "src/provider-work-feed.js");
const provider = fs.existsSync(providerPath) ? await import(pathToFileURL(providerPath)) : {};
const conversation = await import(pathToFileURL(path.join(packageRoot, "src/work-conversation.js")));
const pushBridge = await import(pathToFileURL(path.join(packageRoot, "src/work-push-bridge.js")));
const attachmentPath = path.join(packageRoot, "src/safe-attachment-preview.js");
const attachmentPreview = fs.existsSync(attachmentPath) ? await import(pathToFileURL(attachmentPath)) : {};

function requiredAdapter(name) {
  assert.equal(
    typeof provider[name],
    "function",
    `${name} must consume raw provider-native artifacts in main; legacy records and Codex-shaped inference are forbidden`,
  );
  return provider[name];
}

function presentationFrom(events, providerName, sessionId) {
  const state = conversation.replayWorkEvents(
    Array.isArray(events) ? events : [],
    conversation.createWorkConversation({ provider: providerName, sessionId }),
  );
  return conversation.workPresentationSnapshot(state, Date.parse("2026-08-15T13:00:00.000Z"));
}

function allUnits(presentation) {
  const flatten = (units) => (units || []).flatMap((unit) => [unit, ...flatten(unit?.items)]);
  return (presentation.turns || []).flatMap((turn) => flatten(turn.units));
}

function visibleUsers(presentation) {
  return allUnits(presentation)
    .filter((unit) => unit.type === "message" && unit.placement === "user")
    .map((unit) => String(unit.text || ""));
}

function finals(presentation) {
  return allUnits(presentation)
    .filter((unit) => unit.type === "message" && unit.placement === "final")
    .map((unit) => String(unit.text || ""));
}

function canonicalJson(presentation) {
  return JSON.stringify(presentation);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

test("[N00] Claude and Cowork have raw native adapters, not a legacy-record funnel", () => {
  requiredAdapter("claudeNativeEventsToWorkEvents");
  requiredAdapter("coworkNativeEventsToWorkEvents");
  const source = fs.readFileSync(providerPath, "utf8");
  assert.doesNotMatch(source, /inspectAiSession|coworkEventsToRecords/);
  assert.doesNotMatch(source, /providerRecordsToWorkEvents\([^)]*(?:claude|cowork)/i);
});

test("[N01] Claude raw UUID/DAG semantics preserve humans, commentary, tools, retry, compaction, subagent and strict final", () => {
  const adapt = requiredAdapter("claudeNativeEventsToWorkEvents");
  const events = adapt(claudeFixture.rows, {
    sessionId: claudeFixture.sessionId,
    ownerAlive: false,
    expectedActive: false,
  });
  const view = presentationFrom(events, "claude", claudeFixture.sessionId);
  const units = allUnits(view);
  const serialized = canonicalJson(view);

  assert.deepEqual(visibleUsers(view), ["Please also verify the output."]);
  assert.deepEqual(finals(view), ["Verified."]);
  assert.ok(units.some((unit) => unit.type === "message" && unit.phase === "commentary" && /checking the native result/i.test(unit.text)));
  assert.ok(units.some((unit) => unit.type === "retry"), "api_error retry state must survive");
  assert.equal(units.filter((unit) => unit.type === "compaction").length, 1);
  assert.ok(units.some((unit) => unit.type === "activity" && unit.activity?.kind === "read" && unit.activity?.status === "completed"));
  const read = units.find((unit) => unit.type === "activity" && unit.activity?.kind === "read");
  assert.match(String(read?.activity?.fullObject || read?.activity?.object || ""), /README\.md/,
    "Claude native Read detail must survive into the safe disclosure model");
  assert.ok(units.some((unit) => unit.type === "activity" && unit.activity?.kind === "subagent" && unit.activity?.status === "completed"));
  for (const forbidden of [
    "relay-documents", "relay-runtime-contract", "Private execution detail", "private chain of thought",
    "private-signature", "Private compacted transcript summary", "STALE SIDECHAIN", "must-not-cross",
    "<task-notification>",
  ]) assert.equal(serialized.includes(forbidden), false, `${forbidden} crossed the canonical boundary`);
  assert.equal(units.filter((unit) => unit.type === "message" && unit.placement === "final" && unit.text === "Verified.").length, 1,
    "partial deltas and persisted final must reconcile once");
});

test("[N02] Claude retry exhaustion/tool failure beats prior prose and never fabricates completion", () => {
  const adapt = requiredAdapter("claudeNativeEventsToWorkEvents");
  const view = presentationFrom(adapt(claudeFixture.failedRows, {
    sessionId: "claude-failed",
    ownerAlive: false,
    expectedActive: false,
  }), "claude", "claude-failed");
  const units = allUnits(view);
  assert.deepEqual(finals(view), [], "stop_reason=tool_use commentary is not a final answer");
  assert.ok(units.some((unit) => unit.type === "error"), "exhausted retry/tool rejection must stay persistent");
  assert.notEqual(view.turns.at(-1)?.status, "completed");
  assert.equal(visibleUsers(view).includes("[Request interrupted by user for tool use]"), false);
});

test("[N03] Claude AskUserQuestion and prevented stop hook are one pending blocker, not generic activity", () => {
  const adapt = requiredAdapter("claudeNativeEventsToWorkEvents");
  const view = presentationFrom(adapt(claudeFixture.blockingRows, {
    sessionId: "claude-blocked",
    ownerAlive: true,
    expectedActive: true,
  }), "claude", "claude-blocked");
  const blockers = allUnits(view).filter((unit) => unit.type === "request");
  assert.equal(blockers.length, 1);
  assert.match(blockers[0].text, /Which target|Deploy|Target/i);
  assert.equal(allUnits(view).some((unit) => unit.type === "activity" && /AskUserQuestion/i.test(unit.activity?.object || "")), false);
  assert.equal(view.turns.at(-1)?.active, true);
});

test("[N04] Claude bounded hydration retains the initiating user across a 252-record turn and dedupes overlap", () => {
  const adapt = requiredAdapter("claudeNativeEventsToWorkEvents");
  const rows = [{
    type: "user", uuid: "large-user", origin: { kind: "human" }, timestamp: "2026-08-15T09:00:00.000Z",
    message: { role: "user", content: "Keep the initiating boundary." },
  }];
  let parentUuid = "large-user";
  for (let index = 0; index < 125; index += 1) {
    const toolUse = `large-tool-row-${index}`;
    const toolResult = `large-result-row-${index}`;
    rows.push({
      type: "assistant", uuid: toolUse, parentUuid, timestamp: new Date(Date.parse("2026-08-15T09:00:01.000Z") + index * 2_000).toISOString(),
      message: { role: "assistant", stop_reason: "tool_use", content: [{ type: "tool_use", id: `large-tool-${index}`, name: "Read", input: { file_path: `/repo/${index}.txt` } }] },
    });
    rows.push({
      type: "user", uuid: toolResult, parentUuid: toolUse, sourceToolAssistantUUID: toolUse,
      timestamp: new Date(Date.parse("2026-08-15T09:00:02.000Z") + index * 2_000).toISOString(),
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: `large-tool-${index}`, content: "ok", is_error: false }] },
    });
    parentUuid = toolResult;
  }
  rows.push({
    type: "assistant", uuid: "large-final", parentUuid, timestamp: "2026-08-15T09:10:00.000Z",
    message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "Large turn completed." }] },
  });
  rows.push({ type: "result", uuid: "large-result", timestamp: "2026-08-15T09:10:01.000Z", subtype: "success", is_error: false, stop_reason: "end_turn" });
  const events = adapt([...rows, ...rows.slice(-40)], { sessionId: "claude-large", ownerAlive: false, expectedActive: false });
  const view = presentationFrom(events, "claude", "claude-large");
  assert.deepEqual(visibleUsers(view), ["Keep the initiating boundary."]);
  assert.deepEqual(finals(view), ["Large turn completed."]);
  assert.equal(allUnits(view).filter((unit) => unit.type === "activity").length, 125);
});

test("[N04b] overlapping Claude stream pages reconcile partial deltas by native identity before persistence", () => {
  const adapt = requiredAdapter("claudeNativeEventsToWorkEvents");
  const user = {
    type: "user", uuid: "stream-user", origin: { kind: "human" }, timestamp: "2026-08-15T09:20:00.000Z",
    message: { role: "user", content: "Stream once." },
  };
  const start = {
    type: "stream_event", requestId: "stream-request", timestamp: "2026-08-15T09:20:01.000Z",
    event: { type: "content_block_start", index: 0, message: { id: "stream-message" }, content_block: { type: "text", text: "Hel" } },
  };
  const delta = {
    type: "stream_event", requestId: "stream-request", timestamp: "2026-08-15T09:20:02.000Z",
    event: { type: "content_block_delta", index: 0, message: { id: "stream-message" }, delta: { type: "text_delta", text: "lo" } },
  };
  const view = presentationFrom(adapt([user, start, delta, start, delta], {
    sessionId: "claude-stream-overlap", ownerAlive: true, expectedActive: true,
  }), "claude", "claude-stream-overlap");
  const commentary = allUnits(view)
    .filter((unit) => unit.type === "message" && unit.phase === "commentary")
    .map((unit) => unit.text);
  assert.deepEqual(commentary, ["Hello"]);
  assert.equal(view.turns.at(-1)?.active, true);
});

test("[N05] detached Claude active state fails honestly; a resumable live owner remains active", () => {
  const adapt = requiredAdapter("claudeNativeEventsToWorkEvents");
  const activeRows = claudeFixture.rows.filter((row) => row.type !== "result" && row.uuid !== "assistant-final" && row.uuid !== "stale-sidechain");
  const detached = presentationFrom(adapt(activeRows, {
    sessionId: "claude-detached", ownerAlive: false, expectedActive: true,
  }), "claude", "claude-detached");
  assert.ok(allUnits(detached).some((unit) => unit.type === "error" && /no longer|closed|detached|restart/i.test(unit.text || "")));
  assert.equal(detached.turns.at(-1)?.active, false);

  const live = presentationFrom(adapt(activeRows, {
    sessionId: "claude-live", ownerAlive: true, expectedActive: true,
  }), "claude", "claude-live");
  assert.equal(live.turns.at(-1)?.active, true);
  assert.equal(allUnits(live).some((unit) => unit.type === "error" && /no longer|closed|detached/i.test(unit.text || "")), false);
});

test("[N05b] Claude bridge retains provider identity and live push never rereads the full transcript per native row", async () => {
  const adapt = requiredAdapter("claudeNativeEventsToWorkEvents");
  const events = adapt(claudeFixture.rows, {
    sessionId: claudeFixture.sessionId, ownerAlive: false, expectedActive: false,
  });
  const bridge = pushBridge.createCanonicalWorkPushBridge({
    hydrate: async () => ({ provider: "claude", events }),
    subscribeNative: () => () => {},
  });
  let envelope = null;
  await bridge.subscribe({
    relayId: "relay-claude-native", sessionId: claudeFixture.sessionId, subscriberId: "redteam",
    send: (value) => { envelope = value; }, isAlive: () => true,
  });
  assert.equal(envelope?.presentation?.provider, "claude");
  bridge.close();

  const mainSource = fs.readFileSync(path.join(packageRoot, "overlay/main.cjs"), "utf8");
  assert.doesNotMatch(mainSource, /subscribeClaudeDesktopCodeWorker[\s\S]{0,600}claudeEvents\s*\(/,
    "a pushed Claude row must be reduced incrementally; rereading and replaying the entire transcript per token is forbidden");
});

test("[N05c] real-shape Claude image prompts remain human turns with byte-free attachment metadata", () => {
  const adapt = requiredAdapter("claudeNativeEventsToWorkEvents");
  const events = adapt(claudeAttachmentFixture.rows, {
    sessionId: claudeAttachmentFixture.sessionId,
    ownerAlive: false,
    expectedActive: false,
  });
  const view = presentationFrom(events, "claude", claudeAttachmentFixture.sessionId);
  const users = allUnits(view).filter((unit) => unit.type === "message" && unit.placement === "user");

  assert.equal(view.turns.length, 2, "an image-only native human prompt must start its own turn");
  assert.equal(users.length, 2);
  assert.equal(users[0].text, "");
  assert.equal(users[0].attachments.length, 1);
  assert.equal(users[0].attachments[0].kind, "image");
  assert.equal(users[0].attachments[0].mimeType, "image/webp");
  assert.equal(users[1].text, "Compare this one.");
  assert.equal(users[1].attachments.length, 1);
  assert.equal(users[1].attachments[0].mimeType, "image/png");
  assert.equal(canonicalJson(view).includes("c2FuaXRpemVkLXJlYWwtc2hhcGU"), false,
    "native base64 bytes must never enter canonical Work state or presentation");
});

test("[N05d] incremental Claude reconciliation resets on a real image-only human boundary", () => {
  const createReconciler = requiredAdapter("createClaudeNativeWorkEventReconciler");
  const reconciler = createReconciler(claudeAttachmentFixture.rows.slice(0, 2), {
    sessionId: claudeAttachmentFixture.sessionId,
    ownerAlive: true,
    expectedActive: true,
  });
  const events = reconciler.snapshotEvents();
  events.push(...reconciler.push(claudeAttachmentFixture.rows[2]));
  events.push(...reconciler.push(claudeAttachmentFixture.rows[3], { ownerAlive: false, expectedActive: false }));
  const view = presentationFrom(events, "claude", claudeAttachmentFixture.sessionId);
  const users = allUnits(view).filter((unit) => unit.type === "message" && unit.placement === "user");

  assert.equal(view.turns.length, 2);
  assert.equal(users[1].text, "Compare this one.");
  assert.equal(users[1].attachments[0].mimeType, "image/png");
  assert.deepEqual(finals(view), ["I can see it.", "Compared."]);
});

test("[N06] Cowork sequence/event identity and native roles produce two real turns with startup/protocol privacy", () => {
  const adapt = requiredAdapter("coworkNativeEventsToWorkEvents");
  const events = adapt(coworkFixture.events, { sessionId: coworkFixture.sessionId, session: coworkFixture.session });
  const view = presentationFrom(events, "cowork", coworkFixture.sessionId);
  const units = allUnits(view);
  const serialized = canonicalJson(view);

  assert.equal(view.turns.length, 2);
  assert.deepEqual(visibleUsers(view), ["Please deploy it now."]);
  assert.deepEqual(finals(view), ["Cowork verification passed."]);
  assert.ok(units.some((unit) => unit.type === "message" && unit.phase === "commentary" && /Cowork environment/i.test(unit.text || "")));
  assert.ok(units.some((unit) => unit.type === "activity" && unit.activity?.kind === "command" && unit.activity?.status === "completed"));
  const command = units.find((unit) => unit.type === "activity" && unit.activity?.kind === "command");
  assert.match(String(command?.activity?.fullObject || command?.activity?.object || ""), /run-check/,
    "Cowork must preserve the safe native command for Codex-parity disclosure instead of flattening every command to 'command'");
  assert.equal(units.filter((unit) => unit.type === "activity" && unit.activity?.kind === "command").length, 1, "duplicate event_id must replay once");
  assert.ok(units.some((unit) => unit.type === "request" && /Deploy to production|Approve or decline/i.test(unit.text || "")));
  assert.ok(units.some((unit) => unit.type === "plan" && /Deploy safely/i.test(unit.text || unit.title || "")),
    "active_goal must remain a semantic plan rather than disappearing into provider metadata");
  assert.equal(view.turns[0].status, "completed");
  assert.equal(view.turns[1].active, true, "an older result must not settle the later human turn");
  for (const forbidden of [
    "Allocating sandbox", "relay-documents", "Private execution detail", "private Cowork reasoning",
    "secret.invalid", "X-Session-UUID", "must-not-cross", "mcp_set_servers", "WORKER SYNTHETIC USER",
  ]) assert.equal(serialized.includes(forbidden), false, `${forbidden} crossed the canonical boundary`);
});

test("[N07] Cowork permission response resolves in place; summaries select finals; result is not duplicated", () => {
  const adapt = requiredAdapter("coworkNativeEventsToWorkEvents");
  const session = { ...coworkFixture.session, status_bucket: "review_ready", worker_status: "idle", requires_action_details_list: [] };
  const events = adapt([...coworkFixture.events, ...coworkFixture.resolvedEvents], {
    sessionId: coworkFixture.sessionId, session,
  });
  const view = presentationFrom(events, "cowork", coworkFixture.sessionId);
  assert.deepEqual(finals(view), ["Cowork verification passed.", "Deployment completed."]);
  assert.equal(allUnits(view).filter((unit) => unit.type === "message" && unit.placement === "final" && unit.text === "Deployment completed.").length, 1);
  const resolved = allUnits(view).filter((unit) => unit.type === "request" && /Deploy to production/i.test(unit.text || ""));
  assert.equal(resolved.length, 1, "the resolved blocker remains once in its chronological position");
  assert.equal(resolved[0].status, "resolved");
  assert.equal(resolved[0].blocking, false);
  assert.equal(view.turns.at(-1)?.status, "completed");
});

test("[N08] Cowork blocked summary and auth remain actionable despite active/result/review contradictions", () => {
  const adapt = requiredAdapter("coworkNativeEventsToWorkEvents");
  const firstTurn = coworkFixture.events
    .filter((event) => Number(event.sequence_num) <= 13)
    .map((event) => event.event_id === "cowork-post-summary"
      ? { ...event, payload: { ...event.payload, status_category: "blocked", status_detail: "job done but delivery needs action", needs_action: "Reconnect Relay" } }
      : event);
  const view = presentationFrom(adapt(firstTurn, {
    sessionId: "cowork-contradiction",
    session: { status: "active", status_bucket: "blocked", connection_status: "disconnected", worker_status: "requires_action" },
  }), "cowork", "cowork-contradiction");
  assert.notEqual(view.turns.at(-1)?.status, "completed", "result success cannot erase a native blocked summary");
  assert.ok(allUnits(view).some((unit) => ["request", "error"].includes(unit.type) && /Reconnect Relay|delivery needs action/i.test(unit.text || "")));

  const main = presentationFrom(adapt(coworkFixture.events, {
    sessionId: coworkFixture.sessionId, session: coworkFixture.session,
  }), "cowork", coworkFixture.sessionId);
  assert.ok(allUnits(main).some((unit) => ["request", "error", "retry"].includes(unit.type) && /Calendar|authenticate|connect/i.test(unit.text || "")), "mcp_auth_required must be actionable");
  assert.equal(allUnits(main).some((unit) => unit.type === "error" && /disconnected/i.test(unit.text || "")), false, "historical Cowork disconnected is not a crash");
  assert.equal(view.turns.at(-1)?.status === "failed" && /rate/i.test(canonicalJson(view)), false, "overage-allowed rate event is not fatal");
});

test("[N09] Cowork error result overrides optimistic prose and active/review-ready session metadata", () => {
  const adapt = requiredAdapter("coworkNativeEventsToWorkEvents");
  const failedEvents = coworkFixture.events
    .filter((event) => Number(event.sequence_num) <= 13)
    .map((event) => event.event_id === "cowork-result"
      ? { ...event, payload: { ...event.payload, subtype: "error", is_error: true, terminal_reason: "provider_error", result: "Deployment API rejected the request." } }
      : event);
  const view = presentationFrom(adapt(failedEvents, {
    sessionId: "cowork-failed",
    session: { status: "active", status_bucket: "review_ready", connection_status: "disconnected", worker_status: "idle" },
  }), "cowork", "cowork-failed");
  assert.notEqual(view.turns.at(-1)?.status, "completed");
  assert.ok(allUnits(view).some((unit) => unit.type === "error" && /rejected|provider/i.test(unit.text || "")));
});

test("[N09b] Cowork control_cancel_request resolves its matching blocker in place", () => {
  const adapt = requiredAdapter("coworkNativeEventsToWorkEvents");
  const beforeSummary = coworkFixture.events.filter((event) => Number(event.sequence_num) <= 16);
  const pending = presentationFrom(adapt(beforeSummary, {
    sessionId: "cowork-pending-request",
    session: { status: "active", status_bucket: "blocked", connection_status: "disconnected", worker_status: "requires_action" },
  }), "cowork", "cowork-pending-request");
  assert.equal(allUnits(pending).filter((unit) => unit.type === "request" && /Deploy to production/i.test(unit.text || "")).length, 1,
    "can_use_tool must be visible before a later post-turn summary exists");
  const cancel = {
    sequence_num: "17",
    event_id: "cowork-permission-cancel",
    event_type: "control_cancel_request",
    payload: { type: "control_cancel_request", uuid: "cowork-permission-cancel", request_id: "permission-1" },
  };
  const view = presentationFrom(adapt([...beforeSummary, cancel], {
    sessionId: "cowork-cancelled-request",
    session: { status: "active", status_bucket: "working", connection_status: "disconnected", worker_status: "idle" },
  }), "cowork", "cowork-cancelled-request");
  const cancelled = allUnits(view).filter((unit) => unit.type === "request" && /Deploy to production/i.test(unit.text || ""));
  assert.equal(cancelled.length, 1, "cancel resolves the original unit in place rather than erasing history");
  assert.equal(cancelled[0].status, "cancelled");
  assert.equal(cancelled[0].blocking, false);
});
test("[N10] attachment preview resists post-check symlink swap and growth without reading beyond max+1", async () => {
  assert.equal(typeof attachmentPreview.resolveSafeAttachmentPreview, "function");
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "relay-native-attachment-root-"));
  const outside = await fsp.mkdtemp(path.join(os.tmpdir(), "relay-native-attachment-outside-"));
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
  const allowed = path.join(root, "allowed.png");
  const secret = path.join(outside, "secret.png");
  await fsp.writeFile(allowed, png);
  await fsp.writeFile(secret, png);
  let swapped = false;
  await assert.rejects(
    () => attachmentPreview.resolveSafeAttachmentPreview({ path: allowed, name: "allowed.png", size: png.length, sha256: sha256(png) }, {
      allowedRoots: [root],
      stat: async (target) => {
        const info = await fsp.stat(target);
        if (!swapped) {
          swapped = true;
          await fsp.unlink(target);
          await fsp.symlink(secret, target);
        }
        return info;
      },
    }),
    /outside|changed|symlink|regular|safe/i,
  );

  await fsp.rm(allowed, { force: true });
  await fsp.writeFile(allowed, png);
  let bytesRead = 0;
  const maxBytes = 64;
  await assert.rejects(
    () => attachmentPreview.resolveSafeAttachmentPreview({ path: allowed, name: "allowed.png", size: png.length, sha256: sha256(png) }, {
      allowedRoots: [root],
      maxBytes,
      stat: async (target) => {
        const info = await fsp.stat(target);
        await fsp.writeFile(target, Buffer.concat([png, Buffer.alloc(1024 * 1024)]));
        return info;
      },
      readFile: async (target) => {
        const bytes = await fsp.readFile(target);
        bytesRead = bytes.length;
        return bytes;
      },
    }),
    /size|changed|safe/i,
  );
  assert.ok(bytesRead <= maxBytes + 1, `preview read ${bytesRead} bytes before enforcing a ${maxBytes}-byte limit`);
  await fsp.rm(root, { recursive: true, force: true });
  await fsp.rm(outside, { recursive: true, force: true });
});

test("[N11] attachment authorization survives an ancestor-directory symlink swap", async (t) => {
  assert.equal(typeof attachmentPreview.resolveSafeAttachmentPreview, "function");
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "relay-native-ancestor-root-"));
  const outside = await fsp.mkdtemp(path.join(os.tmpdir(), "relay-native-ancestor-outside-"));
  t.after(async () => {
    await fsp.rm(root, { recursive: true, force: true });
    await fsp.rm(outside, { recursive: true, force: true });
  });
  const insideDirectory = path.join(root, "inside");
  const movedDirectory = path.join(root, "inside-original");
  const name = "image.png";
  const insideBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
  await fsp.mkdir(insideDirectory);
  await fsp.writeFile(path.join(insideDirectory, name), insideBytes);
  await fsp.writeFile(path.join(outside, name), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 99]));
  let swapped = false;
  await assert.rejects(
    () => attachmentPreview.resolveSafeAttachmentPreview({ path: path.join(insideDirectory, name), name, size: insideBytes.length, sha256: sha256(insideBytes) }, {
      allowedRoots: [root],
      stat: async (target) => {
        if (!swapped) {
          swapped = true;
          await fsp.rename(insideDirectory, movedDirectory);
          await fsp.symlink(outside, insideDirectory);
        }
        return fsp.stat(target);
      },
    }),
    /outside|changed|symlink|safe/i,
    "root authorization and file reading must be anchored to the same directory hierarchy",
  );
});

test("[N12] attachment authorization cannot be bypassed by restoring an ancestor after opening outside", async (t) => {
  assert.equal(typeof attachmentPreview.resolveSafeAttachmentPreview, "function");
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "relay-native-ancestor-restore-root-"));
  const outside = await fsp.mkdtemp(path.join(os.tmpdir(), "relay-native-ancestor-restore-outside-"));
  t.after(async () => {
    await fsp.rm(root, { recursive: true, force: true });
    await fsp.rm(outside, { recursive: true, force: true });
  });
  const insideDirectory = path.join(root, "inside");
  const movedDirectory = path.join(root, "inside-original");
  const name = "image.png";
  const target = path.join(insideDirectory, name);
  const insideBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
  await fsp.mkdir(insideDirectory);
  await fsp.writeFile(target, insideBytes);
  await fsp.writeFile(path.join(outside, name), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 99]));
  let swapped = false;
  await assert.rejects(
    () => attachmentPreview.resolveSafeAttachmentPreview({ path: target, name, size: insideBytes.length, sha256: sha256(insideBytes) }, {
      allowedRoots: [root],
      stat: async (filename) => {
        if (!swapped) {
          swapped = true;
          await fsp.rename(insideDirectory, movedDirectory);
          await fsp.symlink(outside, insideDirectory);
        }
        return fsp.stat(filename);
      },
      open: async (filename, flags) => {
        const outsideHandle = await fsp.open(filename, flags);
        await fsp.unlink(insideDirectory);
        await fsp.rename(movedDirectory, insideDirectory);
        return outsideHandle;
      },
    }),
    /outside|changed|digest|symlink|safe/i,
    "restoring the authorized pathname must not legitimize an already-opened outside descriptor",
  );
});
