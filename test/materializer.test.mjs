import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stageSentRelayItem } from "../src/notifications.js";

test("Open in Cowork is rejected before reading or materializing a Relay", async () => {
  const previous = {
    RELAY_HOME: process.env.RELAY_HOME,
    CLAUDE_HOME: process.env.CLAUDE_HOME,
    CLAUDE_DESKTOP_SESSIONS_DIR: process.env.CLAUDE_DESKTOP_SESSIONS_DIR,
    RELAY_OPEN_CWD: process.env.RELAY_OPEN_CWD,
    RELAY_IMPORT_CLAUDE_DESKTOP: process.env.RELAY_IMPORT_CLAUDE_DESKTOP,
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-cowork-open-"));
  const relayHome = path.join(dir, "relay-home");
  const claudeHome = path.join(dir, "claude-home");
  const desktopSessions = path.join(dir, "desktop-sessions");
  fs.mkdirSync(relayHome, { recursive: true });
  fs.mkdirSync(desktopSessions, { recursive: true });
  try {
    process.env.RELAY_HOME = relayHome;
    process.env.CLAUDE_HOME = claudeHome;
    process.env.CLAUDE_DESKTOP_SESSIONS_DIR = desktopSessions;
    process.env.RELAY_OPEN_CWD = dir;
    process.env.RELAY_IMPORT_CLAUDE_DESKTOP = "0";
    const { openRelay } = await import(`../src/materializer.js?cowork-open-${Date.now()}`);
    await assert.rejects(
      openRelay({ id: "relay_cowork", host: "claude", cowork: true, cwd: dir }),
      /Cowork is temporarily unavailable/,
    );
    assert.equal(fs.existsSync(path.join(relayHome, "state.json")), false);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("openRelay downloads ordinary attachments and seeds Claude with clickable attachment links", async () => {
  const prevEnv = {
    RELAY_HOME: process.env.RELAY_HOME,
    CLAUDE_HOME: process.env.CLAUDE_HOME,
    CLAUDE_DESKTOP_SESSIONS_DIR: process.env.CLAUDE_DESKTOP_SESSIONS_DIR,
    RELAY_IMPORT_CLAUDE_DESKTOP: process.env.RELAY_IMPORT_CLAUDE_DESKTOP,
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-materializer-"));
  const relayHome = path.join(dir, "relay-home");
  const claudeHome = path.join(dir, "claude-home");
  const desktopSessions = path.join(dir, "claude-desktop-sessions");
  fs.mkdirSync(relayHome, { recursive: true });
  fs.mkdirSync(desktopSessions, { recursive: true });
  const body = Buffer.from("# Brain quality plan\n\nReal attachment bytes.");
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/markdown", "Content-Length": body.length });
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/brain-quality-plan.md`;
  try {
    process.env.RELAY_HOME = relayHome;
    process.env.CLAUDE_HOME = claudeHome;
    process.env.CLAUDE_DESKTOP_SESSIONS_DIR = desktopSessions;
    process.env.RELAY_IMPORT_CLAUDE_DESKTOP = "0";
    fs.writeFileSync(path.join(relayHome, "state.json"), JSON.stringify({
      packets: {
        relay_1: {
          id: "relay_1",
          direction: "inbound",
          state: "unread",
          kind: "message",
          relayNotificationKind: "plain_relay",
          senderName: "David",
          title: "Brain quality plan",
          displayTitle: "From David: Brain quality plan",
          forHuman: "The plan is attached.",
          createdAt: "2026-07-09T09:30:00.000Z",
          attachments: [{ id: "att_1", name: "brain-quality-plan.md", contentType: "text/markdown", bytes: body.length }],
          attachmentUrls: { att_1: url },
          materializedSurfaces: { codex: false, claudeCode: false, claudeCowork: false },
        },
      },
    }));

    const { openRelay } = await import(`../src/materializer.js?materializer-test-${Date.now()}`);
    const opened = await openRelay({ id: "relay_1", host: "claude", cwd: dir });
    const state = JSON.parse(fs.readFileSync(path.join(relayHome, "state.json"), "utf8"));
    const row = state.packets.relay_1;
    const localPath = row.attachments[0].localPath;
    assert.equal(fs.readFileSync(localPath, "utf8"), body.toString());
    assert.equal(opened.host, "claude");
    assert.ok(row.attachmentMaterializationSignature);
    assert.ok(row.claudeAttachmentMaterializationSignature);
    const transcript = fs.readFileSync(row.claudeNativeSession.sessionPath, "utf8");
    assert.match(transcript, /## Attachments/);
    assert.match(transcript, /brain-quality-plan\.md/);
    const visibleText = transcript
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .flatMap((entry) => entry?.message?.content || [])
      .filter((part) => part?.type === "text")
      .map((part) => part.text)
      .join("\n");
    const renderedLocalPath = localPath.replace(/\\/g, "%5C");
    assert.match(visibleText, new RegExp(`\\[brain-quality-plan\\.md\\]\\(${renderedLocalPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)`));
    assert.doesNotMatch(transcript, /Local copy:/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    for (const [key, value] of Object.entries(prevEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("Claude Open materializes two Relay documents, never request/completion history as chat", async () => {
  const previous = {
    RELAY_HOME: process.env.RELAY_HOME,
    CLAUDE_HOME: process.env.CLAUDE_HOME,
    CLAUDE_DESKTOP_SESSIONS_DIR: process.env.CLAUDE_DESKTOP_SESSIONS_DIR,
    RELAY_IMPORT_CLAUDE_DESKTOP: process.env.RELAY_IMPORT_CLAUDE_DESKTOP,
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-open-ontology-"));
  const relayHome = path.join(dir, "relay-home");
  const desktopSessions = path.join(dir, "desktop-sessions");
  fs.mkdirSync(path.join(relayHome, "task-notes"), { recursive: true });
  fs.mkdirSync(desktopSessions, { recursive: true });
  try {
    process.env.RELAY_HOME = relayHome;
    process.env.CLAUDE_HOME = path.join(dir, "claude-home");
    process.env.CLAUDE_DESKTOP_SESSIONS_DIR = desktopSessions;
    process.env.RELAY_IMPORT_CLAUDE_DESKTOP = "0";
    fs.writeFileSync(path.join(relayHome, "task-notes", "relay_ontology.md"), "Local unsent draft.");
    fs.writeFileSync(path.join(relayHome, "state.json"), JSON.stringify({
      packets: {
        relay_ontology: {
          id: "relay_ontology",
          direction: "inbound",
          state: "unread",
          kind: "task",
          relayNotificationKind: "task",
          senderName: "Shane",
          title: "Canonical request",
          forHuman: "Only the current For Human document.",
          forAgent: "Only the current For Agent document.",
          briefingMarkdown: "# Task from Shane: LEAKED UI PROJECTION",
          thread: {
            threadId: "thread_history",
            messages: [
              { id: "old_request", direction: "inbound", from: "Shane", body: "OLD REQUEST HISTORY" },
              { id: "old_completion", direction: "outbound", from: "You", body: "OLD COMPLETION HISTORY" },
            ],
          },
          createdAt: "2026-08-13T19:30:00.000Z",
          materializedSurfaces: { codex: false, claudeCode: false, claudeCowork: false },
        },
      },
    }));

    const { openRelay } = await import(`../src/materializer.js?open-ontology-${Date.now()}`);
    await openRelay({ id: "relay_ontology", host: "claude", cwd: dir, forceFresh: true });
    const state = JSON.parse(fs.readFileSync(path.join(relayHome, "state.json"), "utf8"));
    const transcript = fs.readFileSync(state.packets.relay_ontology.claudeNativeSession.sessionPath, "utf8");
    const transcriptRows = transcript.trim().split("\n").map((line) => JSON.parse(line));
    const visibleAssistant = transcriptRows.find((entry) => entry.type === "assistant");
    const visibleText = visibleAssistant?.message?.content?.[0]?.text || "";
    assert.match(visibleText, /## Relay from Shane/);
    assert.match(visibleText, /> Only the current For Human document\./);
    assert.doesNotMatch(visibleText, /For-Human\.md|contains two documents|Claude has both/);
    assert.match(visibleText, /\[For Agent\]\([^)]*For-Agent\.md\)/);
    assert.match(transcript, /For-Human\.md/);
    assert.match(transcript, /For-Agent\.md/);
    assert.match(transcript, /Only the current For Human document\./);
    assert.match(transcript, /<relay_for_agent path=[\s\S]*Only the current For Agent document\.[\s\S]*<\/relay_for_agent>/);
    assert.match(transcript, /## Draft \(not sent\)[\s\S]*Local unsent draft\./);
    assert.doesNotMatch(transcript, /Conversation thread|Task from Shane|OLD REQUEST HISTORY|OLD COMPLETION HISTORY|LEAKED UI PROJECTION/);
    assert.equal(state.packets.relay_ontology.claudeMarkdownPaths.length, 2);
    const [forHumanPath, forAgentPath] = state.packets.relay_ontology.claudeMarkdownPaths;
    assert.equal(path.basename(forHumanPath), "For-Human.md");
    assert.equal(path.basename(forAgentPath), "For-Agent.md");
    assert.match(fs.readFileSync(forHumanPath, "utf8"), /Only the current For Human document\./);
    assert.match(fs.readFileSync(forAgentPath, "utf8"), /Only the current For Agent document\./);
    for (const documentPath of [forHumanPath, forAgentPath]) {
      assert.doesNotMatch(fs.readFileSync(documentPath, "utf8"), /Claude Code \/ Cowork|fallback\/debug|Conversation thread|OLD REQUEST HISTORY|OLD COMPLETION HISTORY/);
    }
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Open never promotes a derived briefing projection into a missing For Human document", async () => {
  const previous = {
    RELAY_HOME: process.env.RELAY_HOME,
    CLAUDE_HOME: process.env.CLAUDE_HOME,
    CLAUDE_DESKTOP_SESSIONS_DIR: process.env.CLAUDE_DESKTOP_SESSIONS_DIR,
    RELAY_IMPORT_CLAUDE_DESKTOP: process.env.RELAY_IMPORT_CLAUDE_DESKTOP,
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-open-no-projection-"));
  const relayHome = path.join(dir, "relay-home");
  fs.mkdirSync(relayHome, { recursive: true });
  try {
    process.env.RELAY_HOME = relayHome;
    process.env.CLAUDE_HOME = path.join(dir, "claude-home");
    process.env.CLAUDE_DESKTOP_SESSIONS_DIR = path.join(dir, "desktop-sessions");
    process.env.RELAY_IMPORT_CLAUDE_DESKTOP = "0";
    fs.writeFileSync(path.join(relayHome, "state.json"), JSON.stringify({
      packets: {
        relay_projection_only: {
          id: "relay_projection_only",
          direction: "inbound",
          kind: "task",
          relayNotificationKind: "task",
          senderName: "Shane",
          title: "Projection must stay out",
          briefingMarkdown: "# Task from Shane\n\n## Conversation thread\n\nOLD COMPLETION HISTORY",
          forAgent: "Canonical agent document.",
        },
      },
    }));
    const { openRelay } = await import(`../src/materializer.js?open-no-projection-${Date.now()}`);
    await openRelay({ id: "relay_projection_only", host: "claude", cwd: dir, forceFresh: true });
    const state = JSON.parse(fs.readFileSync(path.join(relayHome, "state.json"), "utf8"));
    const transcript = fs.readFileSync(state.packets.relay_projection_only.claudeNativeSession.sessionPath, "utf8");
    assert.doesNotMatch(transcript, /Task from Shane|Conversation thread|OLD COMPLETION HISTORY/);
    assert.match(transcript, /Canonical agent document\./);
    assert.match(fs.readFileSync(state.packets.relay_projection_only.claudeMarkdownPaths[0], "utf8"), /^# For Human\s*$/m);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Codex Open stages the Relay as its own assistant letter after Codex has created and released the thread", async () => {
  // Codex 0.151+: thread/start no longer creates the rollout (turn/start does),
  // every rollout record carries an ordinal, and a thread has one writer at a
  // time. The product is unchanged — the Relay is Relay's assistant letter, no
  // user text, no model turn — but the file must exist before the letter can
  // be appended, and no Relay process may hold the thread when Desktop opens it
  // (2026-09-02: "This is open in another app", empty thread stuck "working").
  const source = fs.readFileSync(new URL("../src/materializer.js", import.meta.url), "utf8");
  assert.match(source, /materializeRelayOpenDocumentFiles\(rowWithAttachments, \{ provider: "codex-inbox" \}\)/);
  assert.match(source, /model: codexModel,[\s\S]*effort: codexEffort/);
  const createThread = source.slice(source.indexOf("async function createCodexThread"), source.indexOf("function ensureRelayCodexIndexMarker"));
  assert.match(createThread, /thread\/start[\s\S]*runtimeWorkspaceRoots: workspaceRoots[\s\S]*model,[\s\S]*reasoningEffort: effort/);
  assert.match(createThread, /thread\/name\/set[\s\S]*turn\/start", \{ threadId, input: \[\] \}/, "the first turn is empty: the Relay is never user input");
  assert.doesNotMatch(createThread, /input: \[\{ type: "text", text: briefing/, "the letter never enters the thread as a user message");
  const interruptAt = createThread.indexOf('client.request("turn/interrupt"');
  const stopAt = createThread.indexOf("await client.stop();");
  const letterAt = createThread.indexOf("appendVisibleAssistantTurn({ sessionPath, text: briefing");
  assert.ok(interruptAt > 0, "the empty turn is interrupted as soon as the rollout exists");
  assert.match(createThread, /while \(!finished && Date\.now\(\) < interruptDeadline\) \{[\s\S]*turn\/interrupt/, "the interrupt is retried while Codex still says there is no active turn");
  assert.ok(stopAt > interruptAt, "the private app-server is stopped (writer lock released) after the interrupt");
  assert.ok(letterAt > stopAt, "the assistant letter is appended only once no process holds the thread");
  assert.doesNotMatch(createThread, /12 \* 60 \* 60 \* 1000/, "no app-server is kept alive for a model turn Relay does not own");
  assert.match(createThread, /if \(!shared\) \{[\s\S]*turn\/interrupt/, "the shared terminal owner keeps its live turn; only the private desktop server interrupts");
  const { CODEX_OPEN_METADATA_VERSION } = await import(`../src/materializer.js?metadata-version-${Date.now()}`);
  assert.equal(CODEX_OPEN_METADATA_VERSION, 3, "old Codex tasks must be re-forged with file workspace roots");
});

test("Codex Open authorizes only the project and per-Relay file directories", async () => {
  const previousRelayHome = process.env.RELAY_HOME;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-open-roots-"));
  const cwd = path.join(dir, "workspace");
  const relayHome = path.join(dir, "relay-home");
  const attachmentRoot = path.join(relayHome, "attachments", "relay_1");
  const unrelatedRoot = path.join(relayHome, "attachments", "relay_2");
  const arbitraryRoot = path.join(dir, "arbitrary", "attachments", "relay_1");
  try {
    process.env.RELAY_HOME = relayHome;
    fs.mkdirSync(cwd, { recursive: true });
    fs.mkdirSync(attachmentRoot, { recursive: true });
    fs.mkdirSync(unrelatedRoot, { recursive: true });
    fs.mkdirSync(arbitraryRoot, { recursive: true });
    const attachmentPath = path.join(attachmentRoot, "att_1-evidence.txt");
    const unrelatedPath = path.join(unrelatedRoot, "other.txt");
    const arbitraryPath = path.join(arbitraryRoot, "secret.txt");
    fs.writeFileSync(attachmentPath, "evidence");
    fs.writeFileSync(unrelatedPath, "unrelated");
    fs.writeFileSync(arbitraryPath, "shaped like a Relay cache, but outside Relay-owned storage");

    const { materializeRelayOpenDocumentFiles } = await import(`../src/claude-materializer.js?roots-docs-${Date.now()}`);
    const { codexOpenWorkspaceRoots } = await import(`../src/materializer.js?roots-helper-${Date.now()}`);
    const documents = materializeRelayOpenDocumentFiles(
      { id: "relay_1", forHuman: "Human note", forAgent: "Agent note" },
      { provider: "codex-inbox" },
    );
    const roots = codexOpenWorkspaceRoots({
      cwd,
      openRow: {
        id: "relay_1",
        relayOpenDocumentPaths: documents,
        attachments: [
          { localPath: attachmentPath },
          { localPath: unrelatedPath },
          { localPath: arbitraryPath },
        ],
      },
    });

    assert.deepEqual(roots, [path.resolve(cwd), path.dirname(documents.forAgent), attachmentRoot]);
    assert.equal(roots.includes(relayHome), false, "the Relay store itself must remain private");
    assert.equal(roots.includes(path.join(relayHome, "attachments")), false, "the shared attachment store must remain private");
    assert.equal(roots.includes(unrelatedRoot), false, "another Relay's attachment directory must remain private");
    assert.equal(roots.includes(arbitraryRoot), false, "arbitrary localPath parents must not become workspace roots");
    for (const linkedFile of [documents.forAgent, attachmentPath]) {
      assert.ok(roots.some((root) => {
        const relative = path.relative(root, linkedFile);
        return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
      }), `${linkedFile} must be inside an authorized workspace root`);
    }
  } finally {
    if (previousRelayHome === undefined) delete process.env.RELAY_HOME;
    else process.env.RELAY_HOME = previousRelayHome;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("canonical Relay documents invalidate zero-attachment Codex and Claude materializations", async () => {
  const { relayMaterializationIsStale, relayMaterializationSignature } = await import(
    `../src/materializer.js?signature-test-${Date.now()}`
  );
  const broken = relayMaterializationSignature({
    forHuman: "Please review the launch note before Friday.",
    forAgent: "",
    attachments: [],
  });
  const repaired = relayMaterializationSignature({
    forHuman: "Please review the launch note before Friday.",
    forAgent: "Inspect the release gates before making changes.",
    attachments: [],
  });
  assert.notEqual(repaired, broken);
  assert.match(repaired, /"renderer":"relay-open-documents-v5"/, "existing provider tasks must be re-forged with safe Windows links");

  for (const signatureKey of [
    "codexAttachmentMaterializationSignature",
    "claudeAttachmentMaterializationSignature",
  ]) {
    assert.equal(
      relayMaterializationIsStale({ rowState: { [signatureKey]: broken }, signatureKey, signature: repaired }),
      true,
      `${signatureKey} must invalidate when For Agent is restored`,
    );
    assert.equal(
      relayMaterializationIsStale({ rowState: { [signatureKey]: repaired }, signatureKey, signature: repaired }),
      false,
      `${signatureKey} must reuse a matching zero-attachment materialization`,
    );
  }
});

test("a staged sent relay materializes into a reusable native session", async () => {
  const prevEnv = {
    RELAY_HOME: process.env.RELAY_HOME,
    CLAUDE_HOME: process.env.CLAUDE_HOME,
    CLAUDE_DESKTOP_SESSIONS_DIR: process.env.CLAUDE_DESKTOP_SESSIONS_DIR,
    RELAY_IMPORT_CLAUDE_DESKTOP: process.env.RELAY_IMPORT_CLAUDE_DESKTOP,
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-sent-materializer-"));
  const relayHome = path.join(dir, "relay-home");
  const claudeHome = path.join(dir, "claude-home");
  const desktopSessions = path.join(dir, "claude-desktop-sessions");
  fs.mkdirSync(relayHome, { recursive: true });
  fs.mkdirSync(desktopSessions, { recursive: true });
  try {
    process.env.RELAY_HOME = relayHome;
    process.env.CLAUDE_HOME = claudeHome;
    process.env.CLAUDE_DESKTOP_SESSIONS_DIR = desktopSessions;
    process.env.RELAY_IMPORT_CLAUDE_DESKTOP = "0";
    stageSentRelayItem(
      {
        sender: { name: "David", email: "david@example.com" },
        item: {
          relayId: "relay_sent_materialized",
          createdAt: "2026-07-09T12:00:00.000Z",
          updatedAt: "2026-07-09T12:01:00.000Z",
          kind: "message",
          title: "Launch note",
          recipient: { name: "Sven", email: "sven@example.com", onRelay: true },
          preview: "Please review the launch note.",
          forHuman: "Please review the launch note before Friday.",
          attachments: [],
        },
      },
      { statePath: path.join(relayHome, "state.json") },
    );

    const { openRelay } = await import(`../src/materializer.js?sent-materializer-test-${Date.now()}`);
    const first = await openRelay({ id: "sent_relay_sent_materialized", host: "claude", cwd: dir });
    const firstState = JSON.parse(fs.readFileSync(path.join(relayHome, "state.json"), "utf8"));
    const firstRow = firstState.packets.sent_relay_sent_materialized;
    const firstSessionId = firstRow.claudeNativeSession.sessionId;
    const transcript = fs.readFileSync(firstRow.claudeNativeSession.sessionPath, "utf8");
    assert.equal(firstRow.direction, "outbound");
    assert.equal(first.host, "claude");
    assert.match(transcript, /🔁 To Sven: Launch note/);
    assert.match(transcript, /Please review the launch note before Friday\./);
    assert.doesNotMatch(transcript, /\[For Agent\]\([^)]*For-Agent\.md\)/);

    await openRelay({ id: "sent_relay_sent_materialized", host: "claude", cwd: dir });
    const reopenedState = JSON.parse(fs.readFileSync(path.join(relayHome, "state.json"), "utf8"));
    assert.equal(reopenedState.packets.sent_relay_sent_materialized.claudeNativeSession.sessionId, firstSessionId);

    // Re-stage the same sent Relay as it arrives from `/v1/sent` after the
    // historical stager bug has been fixed. The old native session contains an
    // empty For Agent document and has no ordinary attachments. Canonical-doc
    // signatures must still invalidate it and forge a corrected session.
    stageSentRelayItem(
      {
        sender: { name: "David", email: "david@example.com" },
        item: {
          relayId: "relay_sent_materialized",
          createdAt: "2026-07-09T12:00:00.000Z",
          updatedAt: "2026-07-09T12:02:00.000Z",
          kind: "message",
          title: "Launch note",
          recipient: { name: "Sven", email: "sven@example.com", onRelay: true },
          preview: "Please review the launch note.",
          forHuman: "Please review the launch note before Friday.",
          forAgent: "Inspect the release gates before making changes.",
          attachments: [],
        },
      },
      { statePath: path.join(relayHome, "state.json") },
    );
    await openRelay({ id: "sent_relay_sent_materialized", host: "claude", cwd: dir });
    const repairedState = JSON.parse(fs.readFileSync(path.join(relayHome, "state.json"), "utf8"));
    const repairedRow = repairedState.packets.sent_relay_sent_materialized;
    const repairedSessionId = repairedRow.claudeNativeSession.sessionId;
    const repairedTranscript = fs.readFileSync(repairedRow.claudeNativeSession.sessionPath, "utf8");
    assert.notEqual(repairedSessionId, firstSessionId, "a newly restored For Agent document must re-forge Claude");
    assert.match(repairedTranscript, /\[For Agent\]\([^)]*For-Agent\.md\)/);
    assert.match(repairedTranscript, /Inspect the release gates before making changes\./);
    assert.match(
      fs.readFileSync(repairedRow.claudeMarkdownPaths.find((filePath) => path.basename(filePath) === "For-Agent.md"), "utf8"),
      /Inspect the release gates before making changes\./,
    );

    // --fresh ("Open in new chat"): the remembered session is deliberately
    // ignored and a NEW native session is forged and remembered.
    const fresh = await openRelay({ id: "sent_relay_sent_materialized", host: "claude", cwd: dir, forceFresh: true });
    const freshState = JSON.parse(fs.readFileSync(path.join(relayHome, "state.json"), "utf8"));
    const freshSession = freshState.packets.sent_relay_sent_materialized.claudeNativeSession;
    assert.notEqual(freshSession.sessionId, repairedSessionId, "forceFresh must not reuse the remembered session");
    assert.equal(fresh.claudeFreshlyForged, true);
    assert.ok(fs.existsSync(freshSession.sessionPath));
  } finally {
    for (const [key, value] of Object.entries(prevEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("openRelay without a workspace passport materializes in the receiver's default project", async () => {
  const prevEnv = {
    RELAY_HOME: process.env.RELAY_HOME,
    CLAUDE_HOME: process.env.CLAUDE_HOME,
    CLAUDE_DESKTOP_SESSIONS_DIR: process.env.CLAUDE_DESKTOP_SESSIONS_DIR,
    RELAY_IMPORT_CLAUDE_DESKTOP: process.env.RELAY_IMPORT_CLAUDE_DESKTOP,
    RELAY_OPEN_CWD: process.env.RELAY_OPEN_CWD,
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-no-passport-"));
  const relayHome = path.join(dir, "relay-home");
  const claudeHome = path.join(dir, "claude-home");
  const desktopSessions = path.join(dir, "claude-desktop-sessions");
  fs.mkdirSync(relayHome, { recursive: true });
  fs.mkdirSync(desktopSessions, { recursive: true });
  try {
    process.env.RELAY_HOME = relayHome;
    process.env.CLAUDE_HOME = claudeHome;
    process.env.CLAUDE_DESKTOP_SESSIONS_DIR = desktopSessions;
    process.env.RELAY_IMPORT_CLAUDE_DESKTOP = "0";
    process.env.RELAY_OPEN_CWD = dir;
    fs.writeFileSync(path.join(relayHome, "state.json"), JSON.stringify({
      packets: {
        relay_missing_passport: {
          id: "relay_missing_passport",
          direction: "inbound",
          state: "unread",
          kind: "message",
          relayNotificationKind: "plain_relay",
          senderName: "Shane",
          title: "No passport",
          displayTitle: "From Shane: No passport",
          forHuman: "This old packet has no source.workspace.",
          createdAt: "2026-07-09T09:30:00.000Z",
          source: { host: "relay-mcp" },
          materializedSurfaces: { codex: false, claudeCode: false, claudeCowork: false },
        },
      },
    }));

    const { openRelay } = await import(`../src/materializer.js?missing-passport-test-${Date.now()}`);
    const opened = await openRelay({ id: "relay_missing_passport", host: "claude" });
    const state = JSON.parse(fs.readFileSync(path.join(relayHome, "state.json"), "utf8"));
    const row = state.packets.relay_missing_passport;
    assert.match(opened.url, /^claude:\/\/resume\?session=/);
    assert.equal(opened.openedInHost, false);
    assert.equal(opened.cwd, dir);
    assert.equal(opened.cwdReason, "env");
    assert.equal(row.openCwd, dir);
    assert.equal(row.openCwdReason, "env");
    assert.ok(row.claudeNativeSession.sessionPath);
  } finally {
    for (const [key, value] of Object.entries(prevEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("materialization heals legacy Codex threadId clobber back to the Relay thread id", async () => {
  const prevEnv = {
    RELAY_HOME: process.env.RELAY_HOME,
    CLAUDE_HOME: process.env.CLAUDE_HOME,
    CLAUDE_DESKTOP_SESSIONS_DIR: process.env.CLAUDE_DESKTOP_SESSIONS_DIR,
    RELAY_IMPORT_CLAUDE_DESKTOP: process.env.RELAY_IMPORT_CLAUDE_DESKTOP,
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-thread-heal-"));
  const relayHome = path.join(dir, "relay-home");
  const claudeHome = path.join(dir, "claude-home");
  const desktopSessions = path.join(dir, "claude-desktop-sessions");
  const contentDir = path.join(relayHome, "packets");
  fs.mkdirSync(contentDir, { recursive: true });
  fs.mkdirSync(desktopSessions, { recursive: true });
  const contentPath = path.join(contentDir, "relay_heal.json");
  fs.writeFileSync(contentPath, JSON.stringify({
    id: "relay_heal",
    kind: "message",
    title: "Thread heal",
    displayTitle: "From Shane: Thread heal",
    forHuman: "Preserve the Relay conversation id.",
    createdAt: "2026-07-09T09:30:00.000Z",
    sender: { name: "Shane" },
    recipient: { name: "David" },
    threadId: "relay_original_thread",
    source: { host: "relay-mcp" },
  }));
  try {
    process.env.RELAY_HOME = relayHome;
    process.env.CLAUDE_HOME = claudeHome;
    process.env.CLAUDE_DESKTOP_SESSIONS_DIR = desktopSessions;
    process.env.RELAY_IMPORT_CLAUDE_DESKTOP = "0";
    fs.writeFileSync(path.join(relayHome, "state.json"), JSON.stringify({
      packets: {
        relay_heal: {
          id: "relay_heal",
          direction: "inbound",
          state: "unread",
          threadId: "019fe125-2d93-7cd1-a8db-d03f5e4c3b7c",
          sessionPath: "/tmp/old-codex-rollout.jsonl",
          contentPath,
          filePath: contentPath,
          materializedSurfaces: { codex: true, claudeCode: false, claudeCowork: false },
        },
      },
    }));

    const { openRelay } = await import(`../src/materializer.js?thread-heal-test-${Date.now()}`);
    await openRelay({ id: "relay_heal", host: "claude", cwd: dir });
    const state = JSON.parse(fs.readFileSync(path.join(relayHome, "state.json"), "utf8"));
    const row = state.packets.relay_heal;
    assert.equal(row.threadId, "relay_original_thread");
    assert.equal(row.relayThreadId, "relay_original_thread");
    assert.equal(row.sessionPath, "/tmp/old-codex-rollout.jsonl");
    assert.ok(row.claudeNativeSession?.sessionPath);
  } finally {
    for (const [key, value] of Object.entries(prevEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("a relay whose passport repo is absent still downloads its attachments and opens in the Relay folder", async () => {
  const prevEnv = { RELAY_HOME: process.env.RELAY_HOME };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-materializer-gate-"));
  const relayHome = path.join(dir, "relay-home");
  fs.mkdirSync(relayHome, { recursive: true });
  const body = Buffer.from("<!doctype html><title>proto board</title>");
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": body.length });
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/proto-board.html`;
  try {
    process.env.RELAY_HOME = relayHome;
    fs.writeFileSync(path.join(relayHome, "state.json"), JSON.stringify({
      packets: {
        relay_gate: {
          id: "relay_gate",
          direction: "inbound",
          state: "unread",
          kind: "message",
          relayNotificationKind: "plain_relay",
          senderName: "Sven",
          title: "Pill prototype board",
          forHuman: "Board attached.",
          createdAt: "2026-08-12T09:00:00.000Z",
          // A passport naming a repo this machine does not have: the open lands
          // in the dedicated Relay folder (never home, never a guessed path) with
          // the unmatched passport recorded, and delivery of the attachment must
          // have happened regardless (2026-09-02: Schalk's rerelay Relays were
          // unopenable on David's Mac).
          source: { workspace: { kind: "git", key: "github.com/nobody/does-not-exist" } },
          attachments: [{ id: "att_1", name: "proto-board.html", contentType: "text/html", bytes: body.length }],
          attachmentUrls: { att_1: url },
          materializedSurfaces: { codex: false, claudeCode: false, claudeCowork: false },
        },
      },
    }));

    const { openRelay } = await import(`../src/materializer.js?materializer-gate-test-${Date.now()}`);
    const opened = await openRelay({ id: "relay_gate", host: "claude" });
    assert.equal(opened.cwdReason, "workspace-unmapped-fallback");
    assert.equal(path.basename(opened.cwd), "Relay", "an unmatched passport opens in the Relay folder");

    const state = JSON.parse(fs.readFileSync(path.join(relayHome, "state.json"), "utf8"));
    const row = state.packets.relay_gate;
    const localPath = row.attachments && row.attachments[0] && row.attachments[0].localPath;
    assert.ok(localPath, "the open must persist a downloaded local copy");
    assert.equal(fs.readFileSync(localPath, "utf8"), body.toString());
    assert.equal(row.openCwdReason, "workspace-unmapped-fallback");
    assert.equal(row.openWorkspaceKey, "git:github.com/nobody/does-not-exist", "the unmatched passport stays on record");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    for (const [key, value] of Object.entries(prevEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("materializeAttachmentFiles refreshes stale signed URLs once and retries the misses", async () => {
  const prevEnv = { RELAY_HOME: process.env.RELAY_HOME };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-materializer-refresh-"));
  const relayHome = path.join(dir, "relay-home");
  fs.mkdirSync(relayHome, { recursive: true });
  const body = Buffer.from("fresh bytes");
  const server = http.createServer((req, res) => {
    if (req.url.includes("stale")) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "expired" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": body.length });
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    process.env.RELAY_HOME = relayHome;
    const { materializeAttachmentFiles } = await import(`../src/materializer.js?materializer-refresh-test-${Date.now()}`);
    const refreshCalls = [];
    const row = await materializeAttachmentFiles(
      {
        id: "relay_refresh",
        attachments: [{ id: "att_1", name: "notes.md", bytes: body.length }],
        attachmentUrls: { att_1: `${base}/stale` },
      },
      {
        refreshUrls: async (r) => {
          refreshCalls.push(r.id);
          return { att_1: `${base}/fresh` };
        },
      },
    );
    assert.deepEqual(refreshCalls, ["relay_refresh"]);
    assert.ok(row.attachments[0].localPath, "the retry with a fresh URL must land the file");
    assert.equal(fs.readFileSync(row.attachments[0].localPath, "utf8"), body.toString());
  } finally {
    await new Promise((resolve) => server.close(resolve));
    for (const [key, value] of Object.entries(prevEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("sweepStaleAttachmentFiles removes only dirs older than the retention window", async () => {
  const prevEnv = { RELAY_HOME: process.env.RELAY_HOME };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-materializer-sweep-"));
  const relayHome = path.join(dir, "relay-home");
  const attachmentsRoot = path.join(relayHome, "attachments");
  fs.mkdirSync(path.join(attachmentsRoot, "relay_old"), { recursive: true });
  fs.mkdirSync(path.join(attachmentsRoot, "relay_new"), { recursive: true });
  const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
  fs.utimesSync(path.join(attachmentsRoot, "relay_old"), old, old);
  try {
    process.env.RELAY_HOME = relayHome;
    const { sweepStaleAttachmentFiles } = await import(`../src/materializer.js?materializer-sweep-test-${Date.now()}`);
    const removed = sweepStaleAttachmentFiles();
    assert.deepEqual(removed, ["relay_old"]);
    assert.ok(!fs.existsSync(path.join(attachmentsRoot, "relay_old")));
    assert.ok(fs.existsSync(path.join(attachmentsRoot, "relay_new")));
  } finally {
    for (const [key, value] of Object.entries(prevEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
