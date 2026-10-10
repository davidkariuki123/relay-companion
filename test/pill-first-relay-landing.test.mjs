import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const html = fs.readFileSync(new URL("../overlay/inbox.html", import.meta.url), "utf8");
const slice = (start, end) => {
  const i = html.indexOf(start);
  assert.ok(i >= 0, `found: ${start}`);
  const j = html.indexOf(end, i);
  assert.ok(j > i, `found after: ${end}`);
  return html.slice(i, j);
};

// THE CHAPTER AFTER THE FIRST SEND (David, 2026-09-13; trimmed 2026-10-10).
// A hello to an inviter is celebrated (ten seconds, or Continue); a first
// Relay that was a link lands on It's ready to send instead. Slack follows
// when offered, and then the chapter ends by itself, opening the room of the
// relay you wrote: no second link lesson and no Grow your network screen.

test("before the send, the handoff screen stays; after it, the chapter renders", () => {
  const stage = slice('if (signupStage === "first-relay") {', 'if (signupStage === "restart-required") {');
  assert.match(stage, /if \(status === "sent"\) \{ stopOnboardingAgentPoll\(\); renderFirstRelayChapter\(\); return; \}/);
  assert.match(stage, /Follow the instructions in/);
  assert.match(stage, /Your agent will help you send your first Relay\./);
  assert.match(stage, /This screen will update when your Relay is sent\./);
  assert.doesNotMatch(stage, /id="suChatSkip"/);
  assert.match(html, /signupStage = "first-relay";/);
});

// GET STARTED (2026-09-13): an account with no inviter has nobody to say
// hello to, so the handoff asks the agent for a link instead. The title and
// the eyebrow are the invite path's; only the ask and the progress line change.
test("with no inviter, the handoff asks for a link and waits for it", () => {
  const stage = slice('if (signupStage === "first-relay") {', 'if (signupStage === "restart-required") {');
  assert.match(stage, /const linkFirst = payload\.ui\?\.firstRelayKind === "link";/);
  assert.match(stage, /\$\{agentName \? esc\(agentName\) : "Your agent"\} will help you make your first Relay link\. The other person needs nothing installed\./);
  assert.match(stage, /linkFirst \? "This screen updates when your link is ready\."/);
  assert.match(stage, /JSON\.stringify\(\[status, signupBusy, signupError, linkFirst, agentChosen\?\.host/, "the kind is part of the render signature");
  assert.match(stage, /"Your first Relay"/);
});

test("the celebration auto-advances after twelve seconds and Continue skips the wait", () => {
  const chapter = slice("  function renderFirstRelayChapter() {", "  // OPEN RELAY (2026-09-13)");
  assert.match(html, /function firstRelayCelebrationMs\(\) \{ return Number\(window\.__relayCelebrationMs\) > 0 \? Number\(window\.__relayCelebrationMs\) : 12000; \}/);
  // The aha from both sides: the message the reader reads, and the count of what their AI got.
  assert.match(chapter, /firstRelayPreviewHtml\(\)/);
  assert.match(chapter, /setTimeout\(\(\) => \{[\s\S]*?chapter\.stage = stageAfterFirstLink\(\); renderSignup\(\);[\s\S]*?\}, firstRelayCelebrationMs\(\)\)/);
  assert.match(chapter, /Your first Relay is sent\./);
  assert.match(chapter, /su-relay-moment/);
  assert.match(chapter, /su-countdown/);
  assert.match(chapter, /id="suCelebrationContinue" type="button">Continue</);
  assert.match(chapter, /suCelebrationContinue"\)\?\.addEventListener\("click", \(\) => advanceFirstRelayChapter\(stageAfterFirstLink\(\)\)\)/);
  // A first send that was itself a link has no hello to celebrate.
  assert.match(chapter, /if \(chapter\.stage === "celebrate" && firstRelayWasLink\) chapter\.stage = "link";/);
  // The countdown keeps moving: the squares hop until the bar fills.
  assert.match(html, /@keyframes su-relay-hop/);
  assert.match(html, /\.su-countdown > span \{[^}]*animation:su-countdown var\(--su-countdown-ms, 10s\) linear forwards;/);
  assert.match(html, /prefers-reduced-motion:reduce\) \{\s*\.su-first-relay-sent \.su-relay-moment i/);
});

test("after the first Relay there is no second link lesson and no Grow your network: the chapter ends by opening Relay", () => {
  const chapter = slice("  function renderFirstRelayChapter() {", "  // OPEN RELAY (2026-09-13)");
  assert.doesNotMatch(chapter, /Now relay someone who isn’t on Relay|id="suLinkSkip"|renderNetworkScreen\(/);
  assert.match(chapter, /It’s ready to send\./);
  assert.match(chapter, /id="suLinkContinue"[^>]*>Continue</);
  assert.match(chapter, /suLinkContinue"\)\?\.addEventListener\("click", \(\) => advanceFirstRelayChapter\(stageAfterFirstLink\(\)\)\)/);
  assert.match(chapter, /if \(chapter\.stage === "slack"\) \{ renderSlackOnboarding\(chapter\); return; \}\s*renderFirstRelayFinish\(chapter\);\s*\}/, "the chapter ends after Slack");
  // The end saves both chapters by itself, once, and offers Try again on a failure.
  assert.match(chapter, /if \(!chapter\.finishStarted\) \{ chapter\.finishStarted = true; setTimeout\(\(\) => \{ void finishNetworkInvitation\(\); \}, 0\); \}/);
  assert.match(chapter, /id="suFinishRetry" type="button"[^>]*>Try again</);
});

test("Grow your network has no agent tutorial block and ends with Open Relay", () => {
  const screen = slice("  function renderNetworkScreen(step) {", "  function renderFirstRelayChapter() {");
  assert.match(screen, /Grow your network\./);
  assert.match(screen, /id="suNetworkCopy"[^>]*>\$\{state\.copied \? "Copy link again" : "Copy invite link"\}/);
  assert.match(screen, /id="suNetworkContinue"[^>]*>Open Relay</);
  assert.doesNotMatch(html, /Learn Relay with your agent|suTutorialCopy|copyReturningTutorial|Continue to Relay|Copy invitation|Maybe later|landOnFirstRelay/);
  assert.match(html, /if \(signupStage === "network"\) \{ renderNetworkScreen\("Welcome to Relay"\); return; \}/);
  // Stage selection: the invitation chapter stands alone only once this
  // computer's first-send chapter is complete.
  assert.match(html, /if \(payload\.ui\?\.networkOnboarding\?\.required === true && localChapterDone\) signupStage = "network";/);
});

function finishHarness({ pending = false, completes = true, switchAccount = false, room = null, firstRelayId = "r_old" }) {
  const src = slice("  let firstRelayLanding = null;", "  function pendingOpenSignupCard() {");
  const calls = { completeNetwork: 0, completeLocal: 0, open: [], commit: 0, renderAll: 0 };
  let account = "user_a";
  const payload = {
    account: { userId: "user_a" },
    ui: { onboardingRequired: true, onboardingVersion: 2, firstRelayId, networkOnboarding: { required: pending } },
    sent: [
      { relayId: "r_old", createdAt: "2026-09-08T09:00:00Z", recipient: { email: "old@example.test" } },
      { relayId: "r_new", createdAt: "2026-09-08T10:00:00Z", recipient: { email: "David@Example.test" } },
    ],
  };
  const state = { account: "user_a", busy: false, copied: false, error: "" };
  const relay = {
    completeNetworkOnboarding: async (userId) => { calls.completeNetwork += 1; if (switchAccount) account = "user_b"; return completes ? { ok: true, userId, version: 2 } : { ok: false }; },
    completeSetupTutorial: async () => { calls.completeLocal += 1; if (switchAccount) account = "user_b"; return completes ? { ok: true, version: 2 } : { ok: false }; },
  };
  const ctx = {
    payload, calls, state, relay,
    signupAccountKey: () => account,
    networkInviteForAccount: () => state,
    renderSignup: () => {},
    renderAll: () => { calls.renderAll += 1; },
    chatSections: () => ({ people: room ? [room] : [] }),
    openThreadDetail: (...args) => calls.open.push(args),
    commitNavigation: () => { calls.commit += 1; },
  };
  const api = new Function("ctx", `"use strict"; let activeView = "relays"; let signupStage = "first-relay";
    const window = { relay: ctx.relay };
    const { payload, state, signupAccountKey, networkInviteForAccount, renderSignup, renderAll, chatSections, openThreadDetail, commitNavigation } = ctx;
    ${src}
    return { finishNetworkInvitation, view: () => activeView, stage: () => signupStage };`)(ctx);
  return { api, calls, payload, state };
}

test("Open Relay completes the local chapter, then opens the exact first Relay even when a newer message exists", async () => {
  const room = { threadId: "direct-chat:c1", name: "David Kariuki", partyKey: "email:david@example.test", msgs: [{ id: "r_old" }] };
  const h = finishHarness({ room });
  await h.api.finishNetworkInvitation();
  assert.equal(h.calls.completeLocal, 1);
  assert.equal(h.calls.completeNetwork, 0, "no pending invitation chapter: nothing goes to the server");
  assert.equal(h.payload.ui.onboardingRequired, false);
  assert.equal(h.api.stage(), "installed");
  assert.deepEqual(h.calls.open, [["direct-chat:c1", "David Kariuki", "relays", { expanded: true }]]);
  await h.api.finishNetworkInvitation();
  assert.equal(h.calls.open.length, 1, "once per account: a second click does not open again");
});

test("a pending invitation chapter completes on the server, which covers the local chapter too", async () => {
  const h = finishHarness({ pending: true });
  await h.api.finishNetworkInvitation();
  assert.equal(h.calls.completeNetwork, 1);
  assert.equal(h.calls.completeLocal, 0);
  assert.equal(h.payload.ui.networkOnboarding.required, false);
  assert.equal(h.payload.ui.onboardingRequired, false);
  assert.equal(h.calls.commit, 1, "with no room yet, the pill goes to Relays instead of a dead screen");
  assert.equal(h.api.view(), "relays");
});

test("a completion that did not take shows on the card and can be retried; an account switch opens nothing", async () => {
  const failed = finishHarness({ completes: false, room: { threadId: "t", name: "D", partyKey: "email:david@example.test" } });
  await failed.api.finishNetworkInvitation();
  assert.match(failed.state.error, /couldn’t save your progress/);
  assert.equal(failed.state.busy, false);
  assert.equal(failed.payload.ui.onboardingRequired, true);
  assert.equal(failed.calls.open.length, 0);
  await failed.api.finishNetworkInvitation();
  assert.equal(failed.calls.completeLocal, 2, "the button is live again after a failure");
  const switched = finishHarness({ switchAccount: true, room: { threadId: "t", name: "D", partyKey: "email:david@example.test" } });
  await switched.api.finishNetworkInvitation();
  assert.equal(switched.calls.open.length + switched.calls.commit, 0);
  assert.equal(switched.payload.ui.onboardingRequired, true, "a late result never completes another account");
});
