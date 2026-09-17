import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const html = fs.readFileSync(new URL("../overlay/inbox.html", import.meta.url), "utf8");

test("the chat Task bubble carries its card footer inside it (the claim slot is gone)", () => {
  // The Task card (David, 2026-09-17): the ownership, the state and the verbs
  // live in a footer INSIDE the bubble, on its grid — no separate sibling.
  assert.match(html, /const taskFooter = m\.request \? taskCardFooterHtml\(m\) : "";/);
  assert.match(html, /\$\{taskFooter\}\s*\n\s*\$\{badges\}/, "the footer is the bubble's last row, before the reaction badges");
  assert.doesNotMatch(html, /th-task-stack\$\{mine/, "no stack wrapper around a Task bubble");
  assert.doesNotMatch(html, /taskClaimControlHtml\(m, \{ surface: "chat" \}\)/, "no claim control under the bubble");
  assert.match(html, /\.th-msg \.tk-footer \{ flex:1 0 100%/);
  // A channel Task's verbs are the claim lifecycle, re-homed into the footer.
  const verbs = html.slice(html.indexOf("function taskVerbsHtml(row, st"), html.indexOf("function taskAskRowHtml(row)"));
  assert.match(verbs, /taskBtn\("Claim", "primary", at\("claim"\)/);
  assert.match(verbs, /taskBtn\("Unclaim", "ghost", at\("unclaim"\)/);
  assert.match(verbs, /taskBtn\("Release", "ghost", at\("release"\)/);
});

test("claim states use obvious full-width verbs and named ownership", () => {
  assert.match(html, />Claim task<\/button>/);
  assert.match(html, />Unclaim task<\/button>/);
  assert.match(html, /Claimed by \$\{String\(claimant\?\.name/);
  assert.match(html, /Claimed by you\$\{working \? " · Working"/);
  assert.match(html, /Stop the active Task work before unclaiming it|!working/);
  assert.match(html, /min-height:44px/);
  assert.match(html, /Unclaimed again/);
  assert.match(html, /Released by/);
});

test("Todo rows name a channel when present and omit a direct-task placeholder", () => {
  assert.match(html, /item\.recipientGroupName \? `\$\{item\.recipientGroupName\} · ` : ""/);
  assert.doesNotMatch(html, /recipientGroupName \|\| "Direct"/);
  assert.match(html, /Task · Created by \$\{esc\(sender\)}/);
  assert.match(html, /triage:"Needs attention", in_progress:"In Progress"/);
});

test("Task ownership stays in reader/chat while Todo status remains independent", () => {
  // The expanded Task carries the ladder module (state, helper, verbs) where
  // the claim slot used to be; the card's verbs are wired on both surfaces.
  assert.match(html, /const taskModule = request \? taskStatusModuleHtml\(r\) : "";/);
  // Start is gone (David, 2026-09-13): a Task opens like a Relay, so there is
  // no actionable-state gate in the reader any more.
  assert.equal(html.includes('taskClaimAllowsStart(r) && ["waiting", "parked", "stopped"]'), false);
  assert.match(html, /wireTaskCards\(readerBodyEl, renderReader\)/);
  assert.match(html, /wireTaskCards\(newControls, \(\) => renderThreadDetail\(\)\)/);
  assert.match(html, /lifecycleOnly = task && \["in_progress", "done"\]\.includes\(candidate\)/);
});
