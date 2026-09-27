import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const html = fs.readFileSync(new URL("../overlay/inbox.html", import.meta.url), "utf8");
const source = html.slice(html.indexOf("  function chatSections()"), html.indexOf("  // Messages that arrive while their Chat room"));

function fixture() {
  const state = vm.createContext({
    activeView: "threads", conversationSurface: () => "relay",
    payload: { chats: [] }, contactChatAnchors: new Map(), canonicalChatDetails: new Map(),
    groupsList: [{ id: "grp_a", name: "Room" }, { id: "grp_b", name: "Room" }],
    convos: [],
    normalizedPartyName: (v) => String(v || "").toLowerCase(),
    stablePartyKey: (v) => v, sortConversationRooms: (rooms) => rooms,
    groupInfoRoster: () => [], groupMemberSummary: () => "", assignFallbackChatIds: () => {},
    isUnansweredLinkAudience: () => false, roomFromChatSummary: (chat) => chat,
    isSlackIntegratedRoom: (room) => room.provider === "slack",
  });
  vm.runInContext("function chatConversations() { return convos; }\n" + source, state);
  return state;
}

function sentRoom(threadId, groupId = "grp_a") {
  return { threadId, groupId, isGroup:true, groupName:"Room", name:"Room", people:[],
    msgs:[{ id:threadId, groupId }], latest:{ at:"2026-09-25T18:22:00Z" }, unreadCount:0 };
}

test("empty group remains addressable after first sent message replaces its temporary thread", () => {
  const state = fixture();
  assert.equal(state.chatRoomForThread("group-room:grp_a").hasActivity, false);
  state.convos = [sentRoom("relay_first")];
  const room = state.chatRoomForThread("group-room:grp_a");
  assert.ok(room, "the open room must survive Sent hydration");
  assert.equal(room.msgs[0].id, "relay_first");
  assert.equal(room.groupId, "grp_a");
  state.convos = [sentRoom("relay_later")];
  assert.equal(state.chatRoomForThread("group-room:grp_a").msgs[0].id, "relay_later");
  assert.equal(state.chatRoomForThread("relay_later").groupId, "grp_a");
});

test("stable group lookup distinguishes identical names and never resolves a missing group", () => {
  const state = fixture();
  state.convos = [sentRoom("relay_b", "grp_b"), sentRoom("relay_a")];
  assert.equal(state.chatRoomForThread("group-room:grp_a").groupId, "grp_a");
  assert.equal(state.chatRoomForThread("group-room:grp_b").groupId, "grp_b");
  assert.equal(state.chatRoomForThread("group-room:grp_missing"), null);
});

test("non-Slack cached details without a listed room return null without throwing", () => {
  const state = fixture();
  state.canonicalChatDetails.set("chat_missing", { chatId:"chat_missing", provider:"relay" });
  assert.equal(state.chatRoomForThread("chat_missing"), null);
});


test("Slack cached rooms remain addressable without a list summary", () => {
  const state = fixture();
  state.canonicalChatDetails.set("chat_slack", { chatId:"chat_slack", provider:"slack" });
  assert.equal(state.chatRoomForThread("chat_slack").chatId, "chat_slack");
});
