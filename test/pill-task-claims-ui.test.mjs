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
  assert.doesNotMatch(html, /taskClaimControlHtml|data-task-claim-action/, "the separate claim control is gone");
  assert.match(html, /\.th-msg \.tk-footer \{ flex:1 0 100%/);
  // A channel Task's verbs are the claim lifecycle, re-homed into the footer.
  const verbs = html.slice(html.indexOf("function taskVerbsHtml(row, st"), html.indexOf("function taskAskRowHtml(row)"));
  assert.match(verbs, /taskBtn\("Claim", "primary", at\("claim"\)/);
  assert.match(verbs, /taskBtn\("Unclaim", "ghost", at\("unclaim"\)/);
  assert.match(verbs, /taskBtn\("Release", "ghost", at\("release"\)/);
});

test("Task ownership stays in the reader and the chat card", () => {
  // The expanded Task carries the ladder module (state, helper, verbs) where
  // the claim slot used to be; the card's verbs are wired on both surfaces.
  assert.match(html, /const taskModule = request \? taskStatusModuleHtml\(r\) : "";/);
  // Start is gone (David, 2026-09-13): a Task opens like a Relay, so there is
  // no actionable-state gate in the reader any more.
  assert.equal(html.includes('taskClaimAllowsStart(r) && ["waiting", "parked", "stopped"]'), false);
  assert.match(html, /wireTaskCards\(readerBodyEl, renderReader\)/);
  assert.match(html, /wireTaskCards\(newControls, \(\) => renderThreadDetail\(\)\)/);
});
