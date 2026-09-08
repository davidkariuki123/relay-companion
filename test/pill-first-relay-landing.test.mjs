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

// FIRST RUN (Sven, 2026-09-08, the Minimal design): the first relay is the
// landing. David's chapter ended in two more screens — "Your first Relay is
// sent. Nicely done… Open Relay" and "Copy invitation" — after the send had
// already happened in Claude Code or Codex. Now the send ends the chapter and
// the pill opens the room of the relay you just wrote. Your link lives on the
// You page and in People. Before the send the pill has nothing else to show,
// so the "Follow the instructions in Claude Code or Codex" screen stays.

test("the chapter has one screen before the send and none after it", () => {
  const stage = slice('if (signupStage === "first-relay") {', 'if (signupStage === "restart-required") {');
  assert.match(stage, /if \(status === "sent"\) \{ landOnFirstRelay\(\); return; \}/);
  assert.match(stage, /Follow the instructions in/);
  assert.match(stage, /Your agent will help you send your first Relay\./);
  assert.match(stage, /This screen will update when your Relay is sent\./);
  assert.doesNotMatch(stage, /id="suChatSkip"/);
  assert.doesNotMatch(stage, /Nicely done\.|Your first Relay is sent\.|>Open Relay<|su-relay-moment/);
  assert.doesNotMatch(html, /signupStage === "invite"|signupInviteAccount|suInviteCopy|Copy invitation|\.su-invite|su-first-send/);
  assert.match(html, /signupStage = "first-relay";/);
});

function landingHarness({ completes = true, switchAccount = false, room = null }) {
  const src = slice("  let firstRelayLanding = null;", "  function pendingOpenSignupCard() {");
  const calls = { complete: 0, open: [], commit: 0 };
  let account = "user_a";
  const payload = { ui: { onboardingRequired: true, firstRelayId: "r_old" }, sent: [
    { relayId: "r_old", createdAt: "2026-09-08T09:00:00Z", recipient: { email: "old@example.test" } },
    { relayId: "r_new", createdAt: "2026-09-08T10:00:00Z", recipient: { email: "David@Example.test" } },
  ] };
  const ctx = {
    payload, calls,
    signupAccountKey: () => account,
    completeSignupTutorial: async () => { calls.complete += 1; if (switchAccount) account = "user_b"; if (completes) payload.ui.onboardingRequired = false; },
    chatSections: () => ({ people: room ? [room] : [] }),
    openThreadDetail: (...args) => calls.open.push(args),
    commitNavigation: () => { calls.commit += 1; },
  };
  const api = new Function("ctx", `"use strict"; let activeView = "relays";
    const { payload, signupAccountKey, completeSignupTutorial, chatSections, openThreadDetail, commitNavigation } = ctx;
    ${src}
    return { landOnFirstRelay, view: () => activeView };`)(ctx);
  return { api, calls, payload };
}

test("the send opens the exact first Relay even when a newer message exists", async () => {
  const room = { threadId: "direct-chat:c1", name: "David Kariuki", partyKey: "email:david@example.test", msgs: [{ id: "r_old" }] };
  const h = landingHarness({ room });
  await h.api.landOnFirstRelay();
  assert.equal(h.calls.complete, 1);
  assert.deepEqual(h.calls.open, [["direct-chat:c1", "David Kariuki", "relays", { expanded: true }]]);
  await h.api.landOnFirstRelay();
  assert.equal(h.calls.complete, 1, "once per account: the next poll does not complete or open again");
});

test("with no room yet, the pill goes to Relays instead of a dead screen", async () => {
  const h = landingHarness({});
  await h.api.landOnFirstRelay();
  assert.equal(h.calls.open.length, 0);
  assert.equal(h.calls.commit, 1);
  assert.equal(h.api.view(), "relays");
});

test("a completion that did not take is tried again on the next poll; an account switch opens nothing", async () => {
  const failed = landingHarness({ completes: false, room: { threadId: "t", name: "D", partyKey: "email:david@example.test" } });
  await failed.api.landOnFirstRelay();
  assert.equal(failed.calls.open.length, 0);
  await failed.api.landOnFirstRelay();
  assert.equal(failed.calls.complete, 2, "the guard resets when onboarding is still required");
  const switched = landingHarness({ switchAccount: true, room: { threadId: "t", name: "D", partyKey: "email:david@example.test" } });
  await switched.api.landOnFirstRelay();
  assert.equal(switched.calls.open.length + switched.calls.commit, 0);
});
