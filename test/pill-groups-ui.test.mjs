// The pill's contact-groups management (Contacts tab). Groups shipped
// server-side + web + agent tools in PR #40; the pill had no surface at all —
// field report 2026-08-05: "how come i cant manage/create/remove/edit groups
// on the relay pill?". These pin the three layers the pill now carries.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { RelayClient } from "../src/client.js";

const main = fs.readFileSync(new URL("../overlay/main.cjs", import.meta.url), "utf8");
const preload = fs.readFileSync(new URL("../overlay/preload.cjs", import.meta.url), "utf8");
const html = fs.readFileSync(new URL("../overlay/inbox.html", import.meta.url), "utf8");

test("RelayClient carries group administration plus self-service leave", () => {
  const c = new RelayClient({ url: "https://example.test", token: "t" });
  for (const m of ["groups", "createGroup", "renameGroup", "deleteGroup", "addGroupMember", "removeGroupMember", "leaveGroup", "searchContacts"]) {
    assert.equal(typeof c[m], "function", `RelayClient.${m}`);
  }
});

test("preload bridges every group operation", () => {
  for (const bridge of [
    'groups: () => ipcRenderer.invoke("relay:groups")',
    'groupCreate: (name) => ipcRenderer.invoke("relay:groupCreate", name)',
    'groupRename: (id, name) => ipcRenderer.invoke("relay:groupRename", id, name)',
    'groupDelete: (id) => ipcRenderer.invoke("relay:groupDelete", id)',
    'groupAddMember: (id, contactId) => ipcRenderer.invoke("relay:groupAddMember", id, contactId)',
    'groupRemoveMember: (id, contactId) => ipcRenderer.invoke("relay:groupRemoveMember", id, contactId)',
    'groupLeave: (id) => ipcRenderer.invoke("relay:groupLeave", id)',
    'contactsSearch: (q) => ipcRenderer.invoke("relay:contactsSearch", q)',
  ]) {
    assert.ok(preload.includes(bridge), bridge);
  }
});

test("main proxies group calls through the API client with inline error shape", () => {
  assert.match(main, /const groupCall = async \(fn\) => \{[\s\S]*?await relayClient\(\)/);
  for (const h of ["relay:groups", "relay:groupCreate", "relay:groupRename", "relay:groupDelete", "relay:groupAddMember", "relay:groupRemoveMember", "relay:groupLeave", "relay:contactsSearch"]) {
    assert.ok(main.includes(`ipcMain.handle("${h}"`), h);
  }
  assert.match(main, /c\.createGroup\(\{ name \}\)/);
  assert.match(main, /c\.renameGroup\(id, \{ name \}\)/);
});

test("the renderer manages channels from server truth: list, create, rename, archive, members", () => {
  assert.match(html, /id="cvGroups"/);
  assert.match(html, /No channels yet\. A channel relays to everyone in it as one conversation\./);
  // Mutations re-render from the RETURNED view (cvgApply), never a local guess.
  assert.match(html, /function cvgApply\(result\)/);
  assert.match(html, /groupDetailCall\(container, window\.relay\.groupRename, g\.id, name\)/);
  assert.match(html, /groupDetailCall\(container, window\.relay\.groupAddMember, g\.id/);
  assert.match(html, /groupDetailCall\(container, window\.relay\.groupRemoveMember, g\.id/);
  // Archiving is two-tap armed, like the contact form's delete, and the room
  // stays listed afterwards, marked archived — history is never dropped.
  assert.match(html, /Really archive\? Messages stay/);
  assert.match(html, /archivedAt: result\.archivedAt/);
  // Member picker searches the server book (contactId-accurate), excludes existing members.
  assert.match(html, /groupDetailCall\(container, window\.relay\.contactsSearch, q\)/);
  assert.match(html, /filter\(\(match\) => match\.contactId && !existing\.has\(match\.contactId\)\)/);
  // Groups load with the Contacts tab.
  assert.match(html, /renderContacts\(\);\s*\n\s*loadGroups\(\);/);
});

test("foreign channels expose a self-only leave action without roster administration", () => {
  assert.match(html, /const mine = !slack && g\.owned !== false/);
  // Archived rooms are shown, marked, and never editable — by anyone.
  assert.match(html, /const editable = mine && !archived/);
  assert.match(html, /<span class="cvg-badge">Archived<\/span>/);
  assert.match(html, /<span class="cvg-badge">Added you<\/span>/);
  assert.match(html, /editable && member\.role !== "owner" && id/);
  assert.match(html, /else if \(!mine\)/);
  assert.match(html, /data-gd-leave/);
  assert.match(html, /<button class="gd-leave" type="button" data-gd-leave>Leave channel<\/button>/);
  assert.doesNotMatch(html, /gd-leave-copy/);
  assert.match(html, /window\.relay\.groupLeave/);
  assert.match(html, /leftGroupIds\.add\(g\.id\)/);
  assert.match(html, /groupsList = groupsList\.filter\(\(group\) => group\.id !== g\.id\)/);
});

test("People details and See info share the same roster component", () => {
  assert.match(html, /id="thGroupInfo">See info<\/button>/);
  assert.match(html, /id="groupInfoBackdrop"/);
  // Tightened (Sven, re-landed 2026-08-16): See info shows only for NAMED
  // groups (isGroup alone can be inferred from legacy name-variant rows and
  // put the button on a 1:1) and only in the EXPANDED frame (at pill width it
  // crushed the room name and wrapped) — with CSS that actually hides it.
  assert.match(html, /!\(chatExpanded && room && room\.isGroup && \(room\.groupName \|\| room\.groupId\)\)/);
  assert.match(html, /\.th-info\.hidden \{ display:none; \}/);
  assert.match(html, /groupInfoGroup = groupsList\.find\(\(group\) => wantedId/);
  assert.match(html, /function groupDetailsMarkup\(g, \{ sheet = false \} = \{\}\)/);
  assert.match(html, /groupDetailsMarkup\(groupInfoGroup, \{ sheet:true \}\)/);
  assert.match(html, /groupDetailsMarkup\(group\)/);
  assert.match(html, /const ownerTools = editable \?/);
  assert.match(html, /editable && member\.role !== "owner" && id/);
  assert.match(html, /window\.relay\.groupRemoveMember/);
  assert.match(html, /window\.relay\.groupAddMember/);
  assert.match(html, /window\.relay\.contactsSearch/);
  assert.match(main, /recipientGroupId: p\.recipientGroupId \|\| null/,
    "the room retains the stable group id instead of guessing only by its display name");
});

test("group info joins creator, current user, and every member into one exact roster", () => {
  const source = html.slice(html.indexOf("function groupInfoRoster("), html.indexOf("function renderGroupInfo()"));
  const groupInfoRoster = Function(
    "normalizedPartyName",
    "contactsList",
    "contactEmails",
    `"use strict"; ${source}; return groupInfoRoster;`,
  )(
    (value) => String(value || "").trim().toLowerCase(),
    [{ id:"con_sven_local", name:"Sven Ozwellmann", email:"sven@example.com" }],
    (contact) => contact.emails || [contact.email].filter(Boolean),
  );

  // Exact production failure: Bugs and Features is Shane-owned; the API
  // correctly returns David + Sven in `members` and Shane in `owner`.
  const account = { name: "David Kariuki", email: "david@granular.work" };
  const group = {
    id: "grp_bugs_features",
    name: "Bugs and Features",
    owned: false,
    owner: { userId: "usr_shane", name: "Shane Acton", email: "shane@example.com" },
    members: [
      { contactId: "con_david", name: "David Kariuki", email: "david@granular.work" },
      { contactId: "con_sven", name: "Sven Wellmann", email: "sven@example.com" },
    ],
  };
  const roster = groupInfoRoster(group, account);
  assert.deepEqual(roster.map((person) => person.name), ["Shane Acton", "David Kariuki", "Sven Ozwellmann"]);
  assert.equal(roster[0].role, "owner");
  assert.equal(roster[1].currentUser, true);

  // A duplicated owner contact is one person, and compact owner-mutation
  // responses recover the signed-in owner without granting a Remove control.
  assert.equal(groupInfoRoster({ ...group, members: [group.owner, ...group.members] }, account).length, 3);
  const ownedRoster = groupInfoRoster({ name: "Mine", owned: true, members: group.members.slice(1) }, account);
  assert.deepEqual(ownedRoster.map((person) => [person.name, person.role]), [
    ["David Kariuki", "owner"],
    ["Sven Ozwellmann", "member"],
  ]);

  const details = html.slice(html.indexOf("function groupDetailsMarkup("), html.indexOf("async function groupDetailCall("));
  assert.match(details, /const roster = groupInfoRoster\(g\)/);
  assert.match(details, /const count = roster\.length/);
  assert.match(details, /const memberRows = roster\.length \? roster\.map/);
  assert.match(details, /member\.role !== "owner" && id/,
    "the creator is visible in People but never receives a remove button");
});

test("leaving keeps history but disables every group reply affordance", () => {
  assert.match(html, /function groupRoomPostingState\(room\)/);
  assert.match(html, /You left this channel\. Existing messages remain readable\./);
  assert.match(html, /const visibleThreadComposer = groupPostingBlocked/);
  assert.match(html, /chatShaped \? rowsShell \+ visibleThreadComposer : visibleThreadComposer \+ rowsShell/);
  // The room shell is keyed by the posting state, so leaving or rejoining a
  // group rebuilds it instead of leaving a live composer behind.
  assert.match(html, /\$\{groupPostingBlocked \? "blocked" : "open"\}/);
  assert.match(html, /!m\.request && !groupPostingBlocked/);
});

test("Slack-owned channels join the Channels pane without becoming editable Relay rosters", () => {
  assert.match(html, /function syncSlackChannelRows\(\)/);
  assert.match(html, /payload\.chats \|\| \[\]/);
  assert.match(html, /chat\.channel\?\.slack/);
  assert.match(html, /provider:"slack"/);
  assert.match(html, /src="slackMark\.png" alt="Slack"/);
  assert.match(html, /slack \? "" : `<span class="cvg-edit"/,
    "Slack controls its channel roster, so Relay must not expose the legacy editor");
  assert.match(html, /<span class="cvg-badge">Slack<\/span>/);
});
