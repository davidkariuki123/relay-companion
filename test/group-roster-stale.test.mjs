// A payload that names a group, sender, or @handle the loaded roster does not
// know must make the roster stale, so a mention chip and the @ picker resolve
// without waiting for an unrelated reload.
//
// Field report (David, live, 2026-09-16): Sven created "Silhouette", added
// Chandler and wrote "@Chandler_De_Kock welcome to relay" within a minute. The
// pill had loaded its groups before that and never asked again, so the mention
// rendered as plain text and the composer's @ menu was empty until a later
// contacts reload happened to chain into loadGroups().
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const html = fs.readFileSync(new URL("../overlay/inbox.html", import.meta.url), "utf8");

function between(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

function harness({ groups, contacts = [] }) {
  const mentionHelpers = between(html, "  function normalizedMentionToken(value) {", "  function mentionContact(handle) {");
  const declarations = between(html, "  let groupsList = [];", "  let cvgExpandedId = null;");
  const loader = between(html, "  // Resolves true when the roster arrived.", "  // ---- room-level group info");
  const calls = { groups: 0, renderChat: 0, renderThreadDetail: 0 };
  const clock = { now: 1_000_000 };
  const env = new Function(
    "Date", "window", "cvgCall", "syncSlackChannelRows", "renderGroups", "contactsList",
    "activeView", "threadDetailId", "renderChat", "renderThreadDetail",
    `"use strict"; ${mentionHelpers}\n${declarations}\n${loader}\n` +
    "return { loadGroups, groupsLoadDue, groupRosterStaleFor, refreshGroupRosterIfStale, " +
    "state: () => ({ groupsLoaded, groupsLoading, groupsRetryAt, groupsList }) };",
  )(
    { now: () => clock.now },
    { relay: { groups: async () => { calls.groups += 1; return groups(); } } },
    async (fn) => {
      let res = null;
      try { res = await fn(); } catch (e) { res = { ok: false, error: String(e && e.message) }; }
      return res && res.ok === true ? res.result : null;
    },
    () => {},
    () => {},
    contacts,
    "chat",
    "",
    () => { calls.renderChat += 1; },
    () => { calls.renderThreadDetail += 1; },
  );
  return { ...env, calls, clock };
}

const sven = { email: "sven@example.com", name: "Sven Wellmann" };
const shane = { email: "shane@example.com", name: "Shane Acton" };
const chandler = { email: "chandler@example.com", name: "Chandler De Kock" };
const silhouette = (members) => ({ id: "grp_silhouette", name: "Silhouette", owner: sven, members });

test("a message from a group the roster never saw marks it stale and refetches", async () => {
  let roster = [];
  const h = harness({ groups: () => ({ ok: true, result: roster }) });
  assert.equal(await h.loadGroups(), true);
  assert.equal(h.groupRosterStaleFor([{ recipientGroupId: "grp_silhouette", senderEmail: sven.email, forHuman: "Gmgm!" }]), true);
  roster = [silhouette([shane, chandler])];
  assert.equal(h.refreshGroupRosterIfStale([{ recipientGroupId: "grp_silhouette", senderEmail: sven.email, forHuman: "Gmgm!" }]), true);
  await h.state().groupsLoading;
  assert.equal(h.state().groupsLoaded, true);
  assert.deepEqual(h.state().groupsList, roster);
  assert.equal(h.calls.groups, 2);
  assert.equal(h.calls.renderChat, 1, "the room repaints once the roster lands");
});

test("a mention of someone the known roster does not list marks it stale", async () => {
  const h = harness({ groups: () => ({ ok: true, result: [silhouette([shane])] }) });
  assert.equal(await h.loadGroups(), true);
  const row = { recipientGroupId: "grp_silhouette", senderEmail: sven.email, forHuman: "@Chandler_De_Kock welcome to relay" };
  assert.equal(h.groupRosterStaleFor([row]), true);
});

test("a sender the known roster does not list marks it stale", async () => {
  const h = harness({ groups: () => ({ ok: true, result: [silhouette([shane])] }) });
  assert.equal(await h.loadGroups(), true);
  assert.equal(h.groupRosterStaleFor([{ recipientGroupId: "grp_silhouette", senderEmail: chandler.email, forHuman: "hi" }]), true);
});

test("a message the loaded roster fully explains is not stale", async () => {
  const h = harness({ groups: () => ({ ok: true, result: [silhouette([shane, chandler])] }) });
  assert.equal(await h.loadGroups(), true);
  const rows = [
    { recipientGroupId: "grp_silhouette", senderEmail: sven.email, forHuman: "@Chandler_De_Kock welcome to relay" },
    { recipientGroupId: "grp_silhouette", senderEmail: shane.email, forHuman: "mail me at shane@example.com" },
    { recipientGroupId: "", senderEmail: "stranger@example.com", forHuman: "@Nobody direct messages carry no roster" },
  ];
  assert.equal(h.groupRosterStaleFor(rows), false);
  assert.equal(h.refreshGroupRosterIfStale(rows), false);
  assert.equal(h.calls.groups, 1, "no refetch for a roster that already explains the payload");
});

test("a handle from the viewer's own contact book is not a stranger", async () => {
  const h = harness({ groups: () => ({ ok: true, result: [silhouette([shane])] }), contacts: [{ ...chandler, handle: "chandler" }] });
  assert.equal(await h.loadGroups(), true);
  assert.equal(h.groupRosterStaleFor([{ recipientGroupId: "grp_silhouette", senderEmail: sven.email, forHuman: "@chandler hi" }]), false);
});

test("a stale roster still respects the failed-fetch retry window", async () => {
  let attempts = 0;
  const h = harness({ groups: () => { attempts += 1; return attempts === 1 ? { ok: true, result: [] } : { ok: false, error: "fetch failed" }; } });
  assert.equal(await h.loadGroups(), true);
  const row = { recipientGroupId: "grp_silhouette", senderEmail: sven.email, forHuman: "Gmgm!" };
  assert.equal(h.refreshGroupRosterIfStale([row]), true);
  await h.state().groupsLoading;
  assert.equal(h.state().groupsLoaded, false);
  assert.equal(h.calls.groups, 2);
  // Not loaded, so the row cannot be judged stale again; and the retry window holds.
  assert.equal(h.refreshGroupRosterIfStale([row]), false);
  assert.equal(h.groupsLoadDue(), false);
  h.clock.now += 15_000;
  assert.equal(h.groupsLoadDue(), true, "the next render may try again");
  assert.equal(h.calls.groups, 2);
});
