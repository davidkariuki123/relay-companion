import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";

// GET STARTED (David, 2026-09-13). The sendrelays.com path has no inviter, so
// its first Relay is a share link for someone who is not on Relay. The pill
// that "npx relay-companion setup" opened signs in on its own, then shows the
// same first-send chapter as the invite path: a handoff that asks for a link,
// then the ready screen carrying the celebration (no Grow your network since
// 2026-10-10; the chapter ends by opening Relay).
// The invite path's strings and screens are pinned elsewhere and unchanged.

const html = fs.readFileSync(new URL("../overlay/inbox.html", import.meta.url), "utf8");
const slice = (start, end) => {
  const i = html.indexOf(start);
  assert.ok(i >= 0, `found: ${start}`);
  const j = html.indexOf(end, i);
  assert.ok(j > i, `found after: ${end}`);
  return html.slice(i, j);
};

function signInHarness({ agentInstalled = true, status = "idle", account = undefined, signInFails = false } = {}) {
  const source = slice("  function signupFailureMessage(reason, fallback) {", "  function cancelSetupButton() {")
    + slice("  function expiredSignupStage(", "  function applyInstallationState(")
    + slice("  async function initializeInstallationAuthorization(", "  let networkInvite = ");
  const calls = [];
  const context = vm.createContext({
    window: { relay: {
      installationAuthState: async () => { calls.push("state"); return account ? { status, account } : { status }; },
      installationAuthSignIn: async (options) => {
        // The options object crosses the vm realm; keep its text instead.
        calls.push(["signIn", JSON.stringify(options)]);
        if (signInFails) throw new Error("Relay could not open the secure sign-in page.");
        return { status: "pending_identity" };
      },
    } },
    payload: { account: { paired: false }, ui: { agentInstalled } },
    signupStateLoaded: false, signupBusy: false, signupError: "", signupStage: "", signupAccount: null,
    signupForceGoogleSelection: false, signupAutoSignInStarted: false,
    pendingOpenSignupCard: () => "", rendererSurfaceActive: () => true,
    renderSignup: () => calls.push("render"), applyInstallationState: (state) => {
      if (state?.status === "pending_approval") context.signupStage = "approval";
    }, pollInstallationState: () => calls.push("poll"),
  });
  vm.runInContext(source, context);
  return { context, calls, signIns: () => calls.filter((call) => Array.isArray(call) && call[0] === "signIn") };
}

test("a pill opened by setup starts the browser sign-in itself, once", async () => {
  const h = signInHarness();
  await h.context.initializeInstallationAuthorization();
  assert.deepEqual(h.signIns(), [["signIn", '{"forceAccountSelection":false}']]);
  assert.equal(h.context.signupStage, "google");
  assert.equal(h.context.signupBusy, false);
  assert.equal(h.context.signupError, "");
  assert.equal(h.context.signupAutoSignInStarted, true);
  assert.ok(h.calls.includes("poll"), "the pill polls for the browser's result");
  // Cancel setup reloads the state; the auto-start does not fire again.
  await h.context.initializeInstallationAuthorization({ force: true });
  assert.equal(h.signIns().length, 1);
  assert.equal(h.context.signupStage, "method");
});

test("without the setup marker the method stage waits for a click", async () => {
  const h = signInHarness({ agentInstalled: false });
  await h.context.initializeInstallationAuthorization();
  assert.deepEqual(h.signIns(), []);
  assert.equal(h.context.signupStage, "method");
  assert.equal(h.context.signupAutoSignInStarted, false);
});

// A lapsed link nobody signed in through goes back to the first screen (its
// buttons make a fresh link); one someone already signed in through asks them
// to sign in again. Neither opens a browser on its own.
test("an unfinished or expired approval keeps its recovery screen instead of a new sign-in", async () => {
  for (const [status, account, stage] of [["pending_identity", undefined, "resume"], ["expired", undefined, "method"], ["expired", { email: "sam@example.com" }, "expired"]]) {
    const h = signInHarness({ status, account });
    await h.context.initializeInstallationAuthorization();
    assert.deepEqual(h.signIns(), [], status);
    assert.equal(h.context.signupStage, stage);
    assert.equal(h.context.signupAutoSignInStarted, false);
  }
});

test("a sign-in that could not open falls back to the method stage with the error", async () => {
  const h = signInHarness({ signInFails: true });
  await h.context.initializeInstallationAuthorization();
  assert.equal(h.signIns().length, 1);
  assert.equal(h.context.signupStage, "method");
  assert.equal(h.context.signupBusy, false);
  assert.equal(h.context.signupError, "Relay could not open sign-in. Try again.");
  assert.equal(h.context.signupAutoSignInStarted, true, "no retry loop: the person clicks Sign in");
});

test("the auto-start opens the browser sign-in, and a paired account resets the flag", () => {
  // "Use email instead" no longer shares this path: it stays in the app.
  assert.match(html, /document\.getElementById\("suSignIn"\)\?\.addEventListener\("click", \(\) => \{ signupStage = "email";/);
  const shared = slice("  async function startInstallationSignIn() {", "  let networkInvite = ");
  assert.match(shared, /installationAuthSignIn\(\{ forceAccountSelection: signupForceGoogleSelection \}\)/);
  assert.match(shared, /signupStage = "google"/);
  assert.match(shared, /signupFailure\(reason, "Relay could not open sign-in\. Try again\."\)/);
  const init = slice("  async function initializeInstallationAuthorization(", "  async function startInstallationSignIn() {");
  assert.match(init, /if \(state\.status === "idle" && payload\.ui\?\.agentInstalled === true && !signupAutoSignInStarted\) \{\s*signupAutoSignInStarted = true;\s*await startInstallationSignIn\(\);\s*return;/);
  const signedIn = slice("    stopSignupPolling();\n    signupStage = \"method\";\n    signupBusy = false;", "    syncTabs();");
  assert.match(signedIn, /signupAutoSignInStarted = false;/);
});

test("the handoff asks for a link when the first Relay is one, and the hello copy stays for the invite path", () => {
  const stage = slice('if (signupStage === "first-relay") {', 'if (signupStage === "restart-required") {');
  assert.match(stage, /const linkFirst = payload\.ui\?\.firstRelayKind === "link";/);
  assert.match(stage, /JSON\.stringify\(\[status, signupBusy, signupError, linkFirst, agentChosen\?\.host/);
  assert.match(stage, /linkFirst\s*\? `\$\{agentName \? esc\(agentName\) : "Your agent"\} will help you make your first Relay link\. The other person needs nothing installed\.`\s*: agentName \? `\$\{esc\(agentName\)\} will help you send your first Relay\$\{destination\}\.` : "Your agent will help you send your first Relay\."/);
  assert.match(stage, /linkFirst \? "This screen updates when your link is ready\."\s*: "This screen will update when your Relay is sent\."/);
  // Both kinds share the handoff title and the eyebrow.
  assert.match(stage, /Follow the instructions in/);
  assert.match(stage, /\$\{\(checking \|\| unavailable\) && !agentChosen \? "Connected to Relay" : "Your first Relay"\}/);
  // With no inviter there is no agent conversation known to be driving, and
  // the signup card hides the You page, so the link handoff has an exit: the
  // same Skip as Your first link, completing the local chapter. The hello
  // handoff keeps none.
  assert.match(stage, /const skip = linkFirst && !checking\s*\? `<div class="su-form su-agent-quiet"><button class="su-link" id="suHandoffSkip" type="button"\$\{busy\}>Skip for now<\/button>/);
  assert.match(stage, /document\.getElementById\("suHandoffSkip"\)\?\.addEventListener\("click", completeSignupTutorial\);/);
});

test("the ready screen carries the celebration when the link was the first Relay", () => {
  const chapter = slice("  function renderFirstRelayChapter() {", "  // OPEN RELAY (2026-09-13)");
  // IT'S READY TO SEND (2026-10-10): a link that was the first Relay lands on
  // the ready screen with the moment; there is no second link lesson.
  assert.match(chapter, /const firstRelayWasLink = Boolean\(link && link\.relayId === payload\.ui\?\.firstRelayId\);/);
  assert.match(chapter, /if \(chapter\.stage === "link" && !firstRelayWasLink\) chapter\.stage = stageAfterFirstLink\(\);/);
  assert.match(chapter, /class="su-first-relay su-first-link su-first-relay-sent"/);
  assert.match(chapter, /<h1 class="su-title">It’s ready to send\.<\/h1>/);
  assert.match(chapter, /Send the link to whoever should review it\. They read and reply in their browser, with nothing to install\./);
  assert.match(chapter, />\$\{chapter\.linkCopied \? "Copied" : "Copy link"\}</);
  assert.match(chapter, />Open it yourself</);
  assert.doesNotMatch(chapter, /Now relay someone who isn’t on Relay|Copy message|renderNetworkScreen\(/);
  // The identity of the first Relay is part of what the screen renders from;
  // the state of its controls is not, since a rebuild would replay the marks'
  // entrance on every Copy link (the controls are patched in place).
  assert.match(chapter, /JSON\.stringify\(\["link", link\.relayId, link\.url, payload\.ui\?\.firstRelayId \|\| ""\]\)/);
  assert.match(chapter, /if \(rendered && syncFirstLinkControls\(chapter\)\) return;/);
  const controls = slice("  function syncFirstLinkControls(chapter) {", "  function renderNetworkScreen(step) {");
  assert.match(controls, /copy\.disabled = signupBusy; next\.disabled = signupBusy;/);
  assert.match(controls, /copy\.textContent = chapter\.linkCopied \? "Copied" : "Copy link";/);
  assert.match(controls, /errorEl\.textContent = chapter\.linkError;/);
  // The hop keeps obeying the surface lifecycle on the ready screen too.
  assert.match(html, /\.su-first-relay-sent \.su-relay-moment i \{[^}]*animation-play-state:var\(--relay-loop-state\);/);
});

test("the screenshot preview accepts the Get started fields", () => {
  const preview = slice("    window.__relaySignupPreview = (stage, data = {}) => {", "  // ---------- views / tabs ----------");
  assert.match(preview, /firstRelayKind:data\.firstRelayKind === "link" \? "link" : "hello"/);
  assert.match(preview, /agentInstalled:data\.agentInstalled === true/);
});
