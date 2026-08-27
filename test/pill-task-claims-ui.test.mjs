import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const html = fs.readFileSync(new URL("../overlay/inbox.html", import.meta.url), "utf8");

test("the existing chat Task bubble owns a separate full-width claim sibling", () => {
  assert.match(html, /\.th-task-stack\s*>\s*\.th-msg\s*\{[^}]*width:100%/s);
  assert.match(html, /\.task-claim-button\s*\{[^}]*width:100%/s);
  assert.match(
    html,
    /<\/div>\$\{channelTask \? `\$\{claimControl}<\/div>` : ""}\s*\n\s*\$\{slackThreadLinkHtml/,
    "the bubble closes before the ownership control is rendered",
  );
  assert.doesNotMatch(
    html,
    /class="th-msg[^`]*task-claim-button/s,
    "Claim is not part of the message frame markup",
  );
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

test("Tasks and reader say channel and Created by instead of a bare member name", () => {
  assert.match(html, /\$\{esc\(channel\)} · Created by \$\{esc\(creator\)}/);
  assert.match(html, /Task · Created by \$\{esc\(sender\)}/);
  assert.match(html, /section\("Unclaimed", groups\.unclaimed/);
  assert.match(html, /section\("Claimed", groups\.claimed/);
});

test("reader and board share the same claim renderer and Start is owner-gated", () => {
  assert.match(html, /taskClaimControlHtml\(r, \{ surface: "reader" \}\)/);
  assert.match(html, /taskClaimControlHtml\(r, \{ surface: "tasks" \}\)/);
  assert.match(html, /taskClaimAllowsStart\(r\) && \["waiting", "parked", "stopped"\]/);
  assert.match(html, /wireTaskClaimControls\(readerBodyEl/);
  assert.match(html, /wireTaskClaimControls\(tasksListEl/);
  assert.match(html, /wireTaskClaimControls\(thHistoryEl/);
  assert.match(html, /window\.relay\.taskStop\(key\)/, "a terminal Work feed durably enables later Unclaim");
});
