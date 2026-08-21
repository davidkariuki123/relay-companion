import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const html = fs.readFileSync(new URL("../overlay/inbox.html", import.meta.url), "utf8");
const main = fs.readFileSync(new URL("../overlay/main.cjs", import.meta.url), "utf8");

test("People and Groups are distinct counted panes with one consistent add action", () => {
  assert.match(html, /data-view="contacts">People</);
  assert.match(html, /id="cvSegPeople"[^>]*>People <span class="cv-seg-n" id="cvSegPeopleN"/);
  assert.match(html, /id="cvSegGroups"[^>]*>Groups <span class="cv-seg-n" id="cvSegGroupsN"/);
  assert.match(html, /id="cvAdd" aria-label="Add person">\+ Add</);
  assert.match(html, /id="cvgNew" aria-label="Add group">\+ Add</);
});

test("People rows use colored identity, editorial metadata, and recency without chevrons", () => {
  const render = html.slice(html.indexOf("function renderContacts()"), html.indexOf("function openContactRoom(key)"));
  assert.match(render, /style="--cv-h:\$\{cvHue\(c\.name \|\| primary\)\}"/);
  assert.match(render, /class="cv-sub"/);
  assert.match(render, /const recent = c\.updatedAt \? timeAgo\(c\.updatedAt\) : ""/);
  assert.match(render, /class="cv-meta"/);
  assert.doesNotMatch(render, /cv-chev|CHEVRON_SVG/);
});

test("Group rows show roster avatar stacks, member summaries, and people counts", () => {
  const render = html.slice(html.indexOf("function groupMemberSummary("), html.indexOf("function openGroupRoom(groupId)"));
  assert.match(render, /function groupAvatarStack\(group, roster\)/);
  assert.match(render, /class="cvg-stack"/);
  assert.match(render, /class="cvg-sub">\$\{esc\(groupMemberSummary\(roster\)\)\}/);
  assert.match(render, /count === 1 \? "person" : "people"/);
  assert.doesNotMatch(render, /cv-chev|CHEVRON_SVG/);
});

test("Group rows reserve the complete three-avatar footprint before text", () => {
  const stack = html.match(/\.cvg-stack \{ width:(\d+)px; flex:0 0 (\d+)px;/);
  const avatar = html.match(/\.cvg-stack \.cv-avatar \{ width:(\d+)px;/);
  const overlap = html.match(/\.cvg-stack \.cv-avatar \+ \.cv-avatar \{ margin-left:-(\d+)px;/);
  assert.ok(stack && avatar && overlap);

  const [reservedWidth, flexBasis] = stack.slice(1).map(Number);
  const avatarWidth = Number(avatar[1]);
  const overlapWidth = Number(overlap[1]);
  const threeAvatarFootprint = (avatarWidth * 3) - (overlapWidth * 2);

  assert.equal(reservedWidth, threeAvatarFootprint);
  assert.equal(flexBasis, threeAvatarFootprint);
});

test("managed Granular runtimes stay out of People without leaving the recipient system", () => {
  const refresh = main.slice(main.indexOf("async function refreshContacts()"), main.indexOf("function ensureContactsLoaded()"));
  assert.match(refresh, /contactFixtures\.filter\(\(c\) => c\.source !== "granular"\)/);
  assert.match(refresh, /source: c\.source \|\| ""/);
  assert.match(refresh, /\.filter\(\(c\) => c\.source !== "granular"\)/);
});
