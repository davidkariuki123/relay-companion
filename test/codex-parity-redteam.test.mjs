import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const redteamPackageRoot = path.join(dirname, "..");
const redteamRepoRoot = path.join(redteamPackageRoot, "../..");
const sourceRepoRoot = path.resolve(process.env.RELAY_PARITY_SOURCE_ROOT || redteamRepoRoot);
// The test ships in both the monorepo (packages/companion) and the standalone
// public package. Resolve whichever layout actually contains the source.
const packageRoot = fs.existsSync(path.join(redteamPackageRoot, "src/codex-app-server-activity.js"))
  ? redteamPackageRoot
  : path.join(sourceRepoRoot, "packages/companion");
const { codexAppServerActivity } = await import(pathToFileURL(path.join(packageRoot, "src/codex-app-server-activity.js")));
const workConversationPath = path.join(packageRoot, "src/work-conversation.js");
const workConversation = fs.existsSync(workConversationPath)
  ? await import(pathToFileURL(workConversationPath))
  : null;
const inbox = fs.readFileSync(path.join(packageRoot, "overlay/inbox.html"), "utf8");
const previewRenderer = fs.readFileSync(path.join(packageRoot, "overlay/preview-renderer.js"), "utf8");
const previewHtml = fs.readFileSync(path.join(packageRoot, "overlay/preview.html"), "utf8");
const previewPreload = fs.readFileSync(path.join(packageRoot, "overlay/preview-preload.cjs"), "utf8");
const workUi = fs.readFileSync(path.join(packageRoot, "overlay/work-ui.js"), "utf8");
const nativeParser = fs.readFileSync(path.join(packageRoot, "src/codex-app-server-activity.js"), "utf8");
const workConversationSource = fs.readFileSync(path.join(packageRoot, "src/work-conversation.js"), "utf8");
const workPushBridgeSource = fs.readFileSync(path.join(packageRoot, "src/work-push-bridge.js"), "utf8");
const manifest = JSON.parse(fs.readFileSync(path.join(dirname, "fixtures/codex-parity/codex-app-26.803.61601.json"), "utf8"));
const lifecycle = JSON.parse(fs.readFileSync(path.join(dirname, "fixtures/codex-parity/turn-lifecycle.json"), "utf8"));
const requirements = JSON.parse(fs.readFileSync(path.join(dirname, "fixtures/codex-parity/requirements.json"), "utf8"));

function between(source, start, end) {
  const from = source.indexOf(start);
  assert.ok(from >= 0, `missing start marker: ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert.ok(to > from, `missing end marker: ${end}`);
  return source.slice(from, to);
}

function cssRule(source, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `missing CSS rule ${selector}`);
  return match[1];
}

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function nativeMessage(event) {
  if (event.method === "turn/started") {
    return { method: event.method, emittedAtMs: event.atMs, params: { turn: { id: event.turnId } } };
  }
  if (event.method === "turn/completed") {
    return { method: event.method, emittedAtMs: event.atMs, params: { turn: { id: event.turnId, status: event.status } } };
  }
  const timeKey = event.method === "item/started" ? "startedAtMs" : "completedAtMs";
  return { method: event.method, emittedAtMs: event.atMs, params: { turnId: event.turnId, item: event.item, [timeKey]: event.atMs } };
}

const runStream = between(inbox, "function paintRunStream", "function paintRunKicker");
const runFeed = between(inbox, "function startRunFeed", "// Every render rebuilds the stream element");
const optimistic = between(inbox, "function appendOptimisticUserTurn", "function runFeedIsTerminal");
const previewSession = between(previewRenderer, "function sessionEntries", "async function pollSession");
const previewFeed = between(previewRenderer, "async function pollSession", "async function submitSteer");
const runnerImplementation = `${runStream}\n${workUi}\n${workConversationSource}`;
const previewImplementation = `${previewSession}\n${previewRenderer}\n${workUi}\n${workConversationSource}`;

const pinnedBundlePresent = fs.existsSync(path.join(manifest.application.path, "Contents/Resources/app.asar"))
  && fs.existsSync(path.join(manifest.application.path, "Contents/MacOS/ChatGPT"));
const installedBundleMatchesFixture = pinnedBundlePresent
  && sha256(path.join(manifest.application.path, "Contents/Resources/app.asar")) === manifest.application.asarSha256
  && sha256(path.join(manifest.application.path, "Contents/MacOS/ChatGPT")) === manifest.application.executableSha256;

test("[P00] golden evidence is pinned to this exact installed Codex bundle", { skip: !installedBundleMatchesFixture }, () => {
  assert.equal(sha256(path.join(manifest.application.path, "Contents/Resources/app.asar")), manifest.application.asarSha256);
  assert.equal(sha256(path.join(manifest.application.path, "Contents/MacOS/ChatGPT")), manifest.application.executableSha256);
});

function canonicalUnit(turnId, unit) {
  if (unit.type === "exploration") {
    return {
      turnId,
      kind: "exploration",
      summary: unit.summary,
      items: (unit.items || []).map((entry) => entry.type === "reasoning"
        ? { kind: "reasoning_summary", text: entry.text }
        : {
            kind: "activity",
            activityKind: entry.activity?.kind,
            semanticName: `${entry.activity?.doneVerb || ""} ${entry.activity?.object || ""}`.trim(),
          }),
    };
  }
  if (unit.type === "message" && unit.role === "user") return { turnId, kind: "user", text: unit.text };
  if (unit.type === "message" && unit.phase === "commentary") return { turnId, kind: "commentary", text: unit.text };
  if (unit.type === "message" && unit.phase === "final_answer") return { turnId, kind: "final_answer", text: unit.text };
  if (unit.type === "request") return { turnId, kind: "blocking_question", placement: unit.placement, text: unit.text };
  return { turnId, kind: unit.type };
}

test("[P01] canonical conversation projection retains every ordered native semantic unit", () => {
  assert.ok(workConversation, "canonical conversation reducer is required in addition to legacy activity records");
  const state = workConversation.replayWorkEvents(lifecycle.events.map(nativeMessage));
  const view = workConversation.conversationView(state, 9_999);
  const projection = view.flatMap((turn) => turn.units.map((unit) => canonicalUnit(turn.id, unit)));
  assert.deepEqual(projection, lifecycle.expectedProjection);

  // Compatibility boundary: old callers still receive their tool-only record
  // projection. Conversation semantics must live in the canonical multi-turn
  // presentation above, never be squeezed into this legacy singleton array.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-parity-"));
  const logPath = path.join(root, "app-server.log");
  try {
    fs.writeFileSync(logPath, `${lifecycle.events.map((event) => JSON.stringify(nativeMessage(event))).join("\n")}\n`);
    const legacy = codexAppServerActivity(logPath, { turnId: "turn-1" });
    assert.equal(legacy.records.length, 2);
    assert.ok(legacy.records.every((record) => ["tool_call", "tool_result"].includes(record.type)));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("[P02] renderer preserves chronology instead of hoisting all user turns", () => {
  assert.doesNotMatch(runStream, /const userParts = \[\]/);
  assert.doesNotMatch(runStream, /parts = \[\.\.\.userParts(?:, \.\.\.parts)?\]/);
  assert.match(runStream, /turnId|turn_id/, "render units must remain attached to a native turn");
});

test("[P03] generated headings lead and every raw command is not a default-visible row", () => {
  assert.match(workConversationSource, /function reasoningSummary/);
  assert.match(workConversationSource, /type === "reasoning"/);
  assert.doesNotMatch(runStream, /parts\.push\(\{[\s\S]{0,220}html: actHtml\(act, active\)/);
  assert.match(workConversationSource, /summary: "Explored"/);
});

test("[P04] commentary and final_answer are phase-addressed, never inferred from newest prose", () => {
  assert.match(workConversationSource, /commentary/);
  assert.match(workConversationSource, /final_answer/);
  assert.match(workConversationSource, /phase\s*===?\s*["']final_answer["']/);
  assert.doesNotMatch(runStream, /const newest = prose\.length/);
});

test("[P05] Worked-for and divider are truthful native units, never generic substitutes", () => {
  assert.doesNotMatch(runStream, /: "Activity"/);
  assert.match(runnerImplementation, /timing|durationMs|turnDurationMs/);
  assert.match(runnerImplementation, /worked-for-divider|data-worked-for-divider/);
  assert.doesNotMatch(runStream, /class="rd-seam"/);
});

test("[P06] disclosure measures height and makes collapsed content inert and hidden to accessibility", () => {
  assert.match(workUi, /ResizeObserver/);
  assert.match(runnerImplementation, /\binert\b/);
  assert.match(runnerImplementation, /aria-hidden/);
  assert.match(cssRule(inbox, ".work-conversation .rd-activity-body"), /height:/);
  assert.doesNotMatch(cssRule(inbox, ".rd-activity-body.hidden"), /display\s*:\s*none/);
  assert.match(cssRule(inbox, ".work-conversation .rd-activity-toggle:focus-visible"), /box-shadow|outline:\s*2px/);
});

test("[P07] runner has Codex bottom-distance follow controller and measured footer coverage", () => {
  assert.match(workUi, /distanceFromBottom|distance-from-bottom/);
  assert.match(workUi, /FOLLOW_THRESHOLD_PX\s*=\s*24|bottomTolerance:\s*24/);
  assert.match(inbox, /scroll-padding-bottom/);
  assert.match(workUi, /ResizeObserver/);
  assert.match(`${inbox}\n${workUi}`, /tabIndex\s*=\s*0|tabindex="0"/i);
  assert.match(workUi, /captureAnchor/);
  assert.match(workUi, /restoreAnchor/);
});

test("[P08] optimistic Steer is a stable chronological turn and polling reconciles rather than pauses", () => {
  assert.match(workConversationSource, /addOptimisticUser/);
  assert.match(workConversationSource, /acceptOptimisticUser/);
  assert.match(workConversationSource, /optimisticMode/);
  assert.match(runFeed, /acceptRunFeedUpdate/);
  assert.match(inbox, /runFeedPending\.delete\(key\)/);
  assert.doesNotMatch(runStream, /parts = \[\.\.\.userParts, \.\.\.parts\]/);
});

test("[P09] reconnect, error, approval and blocking input are typed persistent components", () => {
  for (const semantic of ["reconnecting", "interrupted", "approval", "blocking", "error"]) {
    assert.match(`${nativeParser}\n${runnerImplementation}`, new RegExp(semantic, "i"), `missing ${semantic} unit`);
  }
  assert.match(inbox, /role="status"/);
  assert.match(inbox, /aria-live="polite"/);
});

test("[P10] resumed sessions retain independent per-turn disclosures and finals", () => {
  assert.match(runnerImplementation, /turns\.map|groupByTurn|turnUnits/);
  assert.match(runnerImplementation, /disclosures|turn.*key|turnKey/);
  assert.doesNotMatch(runStream, /runActivityOpen\.has\(String\(id\)\)/);
  assert.match(workUi, /Previous messages/);
});

test("[P11] reduced motion zeros node entrances but preserves native disclosure motion", () => {
  assert.equal(manifest.sourceChunks["tool-activity-disclosure-DkkLM_qM.js"], "caccc174f3f14a245f7e7ec060971ab1f350fa23b5435886d6df8230a1b5c7d6");
  assert.equal(manifest.sourceChunks["app-initial-BYOVlUBL.js"], "81278205ff341f551a8d1817380141d21b77c45a736dc6cab6a79460814c9885");
  assert.equal(manifest.nativeContract.disclosureDurationMs, 300);
  assert.deepEqual(manifest.nativeContract.disclosureEase, [0.19, 1, 0.22, 1]);
  assert.match(manifest.nativeContract.disclosureEvidence.componentExcerpt, /height:S\?_\:0,opacity:\+!!S/);
  assert.match(manifest.nativeContract.disclosureEvidence.transitionExcerpt, /duration:300\/1e3.*\.19,1,\.22,1/);

  const reduced = inbox.match(/@media \(prefers-reduced-motion:reduce\)\s*\{([^}]|\}(?!\s*\}))*\}/g)?.join("\n") || "";
  assert.match(reduced, /\.rd-activity-body \.rd-act[^}]*animation-duration\s*:\s*0(?:s|ms)?/);
  assert.match(reduced, /\.rd-activity-body \.rd-act[^}]*transform\s*:\s*none/);
  assert.doesNotMatch(reduced, /\.rd-activity-body \.rd-act[^}]*animation-duration\s*:\s*\.12s/);

  const disclosure = cssRule(inbox, ".work-conversation .rd-activity-body");
  assert.match(disclosure, /transition\s*:\s*height \.3s cubic-bezier\(\.19,1,\.22,1\),\s*opacity \.3s cubic-bezier\(\.19,1,\.22,1\)/);
});

test("[P12] exact native chat typography and Markdown rhythm are preserved", () => {
  assert.match(cssRule(inbox, ".rd-said p"), /font-size:14px;\s*line-height:21px/);
  assert.match(cssRule(inbox, ".rd-final"), /font-size:14px;\s*line-height:21px/);
  assert.match(cssRule(inbox, ".rd-user"), /font-size:14px;\s*line-height:21px/);
  assert.match(cssRule(inbox, ".rd-said p"), /margin:0 0 11px/);
  assert.match(cssRule(inbox, ".work-markdown .md-code"), /padding:1px 6px/);
  assert.match(cssRule(inbox, ".work-markdown .md-code"), /border-radius:6px/);
});

test("[P13] runner user bubbles are keyboard-focusable messages with native actions", () => {
  assert.match(runStream, /className = "rd-user-wrap"/);
  assert.match(runStream, /class="rd-user work-markdown" tabindex="0"/);
  assert.match(runStream, /Copy message/);
  assert.match(runStream, /Edit message/);
  assert.match(runStream, /dblclick/);
  assert.match(runStream, /role="group"/);
  assert.match(cssRule(previewHtml, ".session-user-wrap"), /max-width:77%/);
  assert.match(cssRule(previewHtml, ".user-msg"), /max-width:100%/);
  assert.match(cssRule(previewHtml, ".user-msg"), /padding:8px 12px/);
});

test("[P14] streaming motion is applied to Markdown nodes and images, not whole records", () => {
  assert.match(inbox, /data-markdown-animated/);
  assert.match(inbox, /data-markdown-animated="true"/);
  assert.match(inbox, /\.rd-fade[^}]*\.15s cubic-bezier\(\.37,\.55,\.86,\.88\)/);
  assert.doesNotMatch(runStream, /fadedRunSegment/);
  assert.doesNotMatch(runStream, /Math\.min\(6, newIndex\+\+\) \* 55/);
});

test("[P15a] attached live runs are push-driven on both Work surfaces", () => {
  assert.doesNotMatch(`${runFeed}\n${previewFeed}`, /setInterval\s*\(/);
  assert.match(`${runFeed}\n${previewFeed}\n${previewPreload}`, /subscribe|eventSource|onNativeEvent|onSessionEvent/);
});

test("[P15b] every native push subscription has an explicit unsubscribe path", () => {
  assert.match(`${runFeed}\n${previewFeed}\n${previewPreload}`, /onNativeEvent|onSessionEvent|subscribeNativeRun/);
  assert.match(`${runFeed}\n${previewFeed}\n${previewPreload}`, /unsubscribeNativeRun|removeNativeEventListener|disposeNativeRun/);
  assert.match(`${runFeed}\n${previewFeed}`, /stop|detach|cleanup|abort/i);
});

test("[P15c] live event payload growth is explicitly bounded", () => {
  assert.match(`${runFeed}\n${previewFeed}\n${workPushBridgeSource}\n${workConversationSource}`, /MAX_(?:RUN|NATIVE|SESSION|EVENT|RECORD|PAYLOAD|FEEDS|PENDING|ENVELOPE)|(?:records|events)\.slice\s*\(\s*-\s*\w+/);
});

test("[P16] rendering reconciles stable virtualized turn nodes instead of replacing all HTML", () => {
  assert.doesNotMatch(runStream, /host\.innerHTML\s*=/);
  assert.match(inbox, /content-visibility\s*:\s*auto/);
  assert.match(inbox, /contain-intrinsic-size\s*:\s*auto 240px/);
  assert.match(runStream, /keyedChildren\(host, turns/);
  assert.match(runStream, /dataset\.workTurn/);
});

test("[P17] both runner surfaces share one typed turn-state model", () => {
  assert.doesNotMatch(previewSession, /const finalIndex = entries\.findLastIndex/);
  assert.doesNotMatch(previewSession, /replaceChildren\(fragment\)/);
  assert.match(previewSession, /phase\s*===?\s*["']final_answer["']/);
  assert.match(previewSession, /reasoning_summary|reasoningSummary/);
  assert.match(previewHtml, /scroll-padding-bottom/);
});

test("[P18] AI preview preserves chronological native turns instead of hoisting user entries", () => {
  assert.doesNotMatch(previewSession, /entries\.filter\(\(entry\) => entry\.kind === "user"\)/);
  assert.match(previewSession, /groupByTurn|turnUnits|turnId/);
  assert.match(previewSession, /sessionActivityOpen[^\n]*turn/);
});

test("[P19] AI preview leads with generated headings and hides low-level evidence by default", () => {
  assert.match(previewSession, /reasoning_summary|reasoningSummary/);
  assert.match(previewSession, /commentary/);
  assert.doesNotMatch(previewSession, /sum\.textContent = `› \$\{entry\.text\}`/);
  assert.match(previewSession, /updateSessionSemanticGroup|activityGroup/);
});

test("[P20] AI preview uses final_answer phase rather than last prose", () => {
  assert.match(previewSession, /phase\s*===?\s*["']final_answer["']/);
  assert.doesNotMatch(previewSession, /findLastIndex\(\(entry\) => entry\.kind === "prose"\)/);
});

test("[P21] AI preview disclosure is measured, inert and accessible", () => {
  assert.match(workUi, /ResizeObserver/);
  assert.match(previewImplementation, /\binert\b/);
  assert.match(previewImplementation, /aria-hidden/);
  assert.doesNotMatch(previewSession, /className = `session-activity-body\$\{open \? "" : " gone"\}`/);
  assert.match(cssRule(previewHtml, ".session-activity-toggle:focus-visible"), /box-shadow|outline:\s*2px/);
});

test("[P22] AI preview uses native bottom-distance following and footer compensation", () => {
  assert.match(workUi, /FOLLOW_THRESHOLD_PX\s*=\s*24|bottomTolerance:\s*24/);
  assert.doesNotMatch(previewSession, /< 90/);
  assert.doesNotMatch(previewSession, /replaceChildren\(fragment\)/);
  assert.match(previewHtml, /scroll-padding-bottom/);
  assert.match(workUi, /ResizeObserver/);
});

test("[P23] AI preview shares native geometry and split reduced-motion behavior", () => {
  assert.match(cssRule(previewHtml, ".agent-prose"), /font-size:14px;\s*line-height:21px/);
  assert.match(cssRule(previewHtml, ".session-final"), /font-size:14px;\s*line-height:21px/);
  assert.match(`${previewHtml}\n${previewRenderer}`, /data-markdown-animated/);
  const reduced = previewHtml.match(/@media \(prefers-reduced-motion:reduce\)\s*\{([^}]|\}(?!\s*\}))*\}/g)?.join("\n") || "";
  assert.match(reduced, /\.session-fade\s*\{[^}]*animation\s*:\s*none/);
  const disclosure = cssRule(previewHtml, ".session-activity-body");
  assert.match(disclosure, /transition\s*:\s*height \.3s cubic-bezier\(\.19,1,\.22,1\),\s*opacity \.3s cubic-bezier\(\.19,1,\.22,1\)/);
});

test("[META] ledger and executable Electron parity probe remain present", () => {
  const ledger = [
    path.join(redteamRepoRoot, "docs/CODEX_DESKTOP_PARITY_LEDGER.md"),
    path.join(dirname, "fixtures/codex-parity/PROVIDER_NATIVE_LEDGER.md"),
  ].find((candidate) => fs.existsSync(candidate));
  assert.ok(ledger, "the monorepo or standalone parity ledger must be packaged");
  assert.ok(fs.existsSync(path.join(dirname, "codex-parity-redteam.e2e.mjs")));
  assert.ok(fs.existsSync(path.join(dirname, "codex-parity-preview-redteam.e2e.mjs")));
  assert.ok(fs.existsSync(path.join(dirname, "fixtures/codex-parity/requirements.json")));
  assert.deepEqual(requirements.requirements.map(({ id }) => id), Array.from({ length: 24 }, (_, index) => `P${String(index).padStart(2, "0")}`));
  assert.ok(requirements.requirements.every(({ category, surfaces, tests }) =>
    requirements.categories.includes(category) && surfaces.length > 0 && tests.length > 0));
});
