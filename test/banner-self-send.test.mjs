import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const html = fs.readFileSync(new URL("../overlay/inbox.html", import.meta.url), "utf8");
function sourceBetween(start, end) {
  const from = html.indexOf(start);
  const to = html.indexOf(end, from);
  assert.ok(from >= 0 && to > from);
  return html.slice(from, to);
}

const selectSource = sourceBetween("function bannerIdentityRows(", "function renderRelays()");
const partySource = sourceBetween("function sameDirectParty(", "function sortConversationRooms(");
const rowSource = sourceBetween("function relayIdentityRowHtml(", "// ---------- the reader:");

function select(rooms, rows, received, activeIds) {
  const partyHelpers = sourceBetween("function normalizedPartyName(", "function sameDirectParty(");
  return Function("payload", "activeNotificationIds", "rooms", "rows",
    `${partyHelpers}\n${partySource}\n${selectSource}\nreturn bannerIdentityRows(rooms, rows);`)(
    { relays:received }, activeIds, rooms, rows,
  );
}

function fixture() {
  const task = { id:"relay_self", threadId:"thread_self", direction:"out", unread:false,
    party:"Shane Acton", partyKey:"email:shane@example.com", title:"Test Relay tasks",
    request:true, at:"2026-09-22T12:40:20.892Z" };
  const room = { name:"Shane Acton", partyKey:task.partyKey, threadId:task.threadId,
    latest:task, latestAt:task.at, unreadCount:0, isGroup:false };
  const received = { id:task.id, unread:true };
  return { task, room, received };
}

test("a self-sent Task paints its title and Task chip despite having no chat unread count", () => {
  const { task, room, received } = fixture();
  const before = structuredClone({ task, room, received });
  const [banner] = select([room], [task], [received], [task.id]);
  assert.ok(banner, "the arrival must not produce an empty notification");
  assert.equal(banner.latest.id, task.id);
  assert.equal(banner.latest.direction, "in", "the banner presents the received copy");
  assert.equal(banner.unreadCount, 0, "notification selection does not invent unread chat debt");
  const render = Function("peeking", "esc", "relayListGist", "mentionPreviewText", "avatarHue",
    "avatarInitials", "timeAgo", "bannerIsTask", "bannerVerbsHtml", "bannerComposerHtml",
    `${rowSource}\nreturn relayIdentityRowHtml;`)(
    true, String, String, String, () => 0, () => "SA", () => "now",
    (row) => row.request, () => "", () => "",
  );
  const markup = render(banner);
  assert.match(markup, /Test Relay tasks/);
  assert.match(markup, /class="kchip">Task</);
  assert.match(markup, /data-opening-id="relay_self"/);
  assert.deepEqual({ task, room, received }, before, "chat ownership and raw read state stay intact");
});

test("read, deleted, or inactive self-sends do not reappear as notifications", () => {
  const { task, room, received } = fixture();
  for (const [raw, active] of [
    [received, []], [{ ...received, unread:false }, [task.id]],
    [{ ...received, deletedAt:task.at }, [task.id]],
  ]) assert.deepEqual(select([room], [task], [raw], active), []);
});

test("the triggering self-send remains visible when a newer outgoing message owns the room preview", () => {
  const { task, room, received } = fixture();
  const newer = { ...task, id:"relay_newer", threadId:"thread_newer", title:"Later message",
    at:"2026-09-22T12:41:00.000Z" };
  const [banner] = select([{ ...room, latest:newer }], [newer, task], [received], [task.id]);
  assert.equal(banner.latest.id, task.id);
  assert.equal(banner.latestAt, task.at);
});

test("ordinary unread rooms remain visible and exact group identities stay separate", () => {
  const { task, room, received } = fixture();
  const ordinary = { ...room, name:"Sven", partyKey:"email:sven@example.com", unreadCount:1 };
  const groupTask = { ...task, isGroup:true, groupId:"grp_a" };
  const groups = ["grp_a", "grp_b"].map((groupId) => ({ ...room, isGroup:true, groupId }));
  const banners = select([ordinary, ...groups], [groupTask], [received], [task.id]);
  assert.equal(banners.length, 2);
  assert.equal(banners[0], ordinary);
  assert.equal(banners[1].groupId, "grp_a");
});
