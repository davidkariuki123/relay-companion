import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { stagePlainRelayItem } from "../src/notifications.js";

const html = fs.readFileSync(new URL("../overlay/inbox.html", import.meta.url), "utf8");
function between(start, end) {
  const from = html.indexOf(start);
  const to = html.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from);
  return html.slice(from, to);
}

function mutationHarness(update) {
  const calls = [];
  const notices = [];
  const row = { id:"relay_1", todoStatus:"triage", todoVersion:7, unread:true };
  const context = vm.createContext({
    crypto:{ randomUUID }, activeView:"tasks", payload:{ account:{ id:"owner" } },
    accountCacheIdentity:account => account.id,
    window:{ relay:{ todoVisibilityUpdate:async (...args) => { calls.push(args); return update(...args); } } },
    todoVisibilityPending:new Set(), todoReaderVisibility:new Map(), todoHydratedRows:new Map(), todoRemovalUndo:null, todoRemovalNotice:null,
    renderTasksBoard(){}, readerRow:() => row,
    showTodoRemovalNotice:(...args) => notices.push(args), loadTodo:async () => {},
    tasksListEl:{ querySelector:() => null },
  });
  vm.runInContext(between("  async function commitTodoVisibility(", "  document.addEventListener(\"pointerdown\""), context);
  return { context, calls, notices, row };
}

test("removal and Undo use visibility versions without reading or changing the Relay's status", async () => {
  const h = mutationHarness(async (_id, input) => ({ ok:true, removed:input.removed, version:input.expectedVersion+1 }));
  assert.equal(await h.context.commitTodoVisibility("relay_1", true, 0), true);
  assert.equal(h.row.todoRemoved, true);
  assert.equal(h.row.todoStatus, "triage");
  assert.equal(h.row.todoVersion, 7);
  assert.equal(h.row.unread, true);
  assert.equal(h.notices[0][0], "Removed from Todo");
  const undo = h.context.todoRemovalUndo;
  assert.equal(undo.version, 1);
  assert.equal(await h.context.commitTodoVisibility(undo.itemId, false, undo.version, undo.idempotencyKey), true);
  assert.equal(h.calls[1][1].idempotencyKey, undo.idempotencyKey);
  assert.equal(h.row.todoRemoved, false);
  assert.equal(h.context.todoRemovalUndo, null);
});

test("failure leaves membership intact; failed Undo retains a retry key, while conflict retires it", async () => {
  const h = mutationHarness(async () => { throw new Error("Offline"); });
  assert.equal(await h.context.commitTodoVisibility("relay_1", true, 0), false);
  assert.equal(h.row.todoRemoved, undefined);
  assert.equal(h.notices[0][0], "Offline");
  h.context.todoRemovalUndo = { itemId:"relay_1", version:1, idempotencyKey:"undo-stable-key" };
  await h.context.commitTodoVisibility("relay_1", false, 1, "undo-stable-key");
  assert.equal(h.context.todoRemovalUndo.idempotencyKey, "undo-stable-key");
  h.context.window.relay.todoVisibilityUpdate = async () => ({ ok:false, code:"todo_visibility_conflict", error:"Changed elsewhere" });
  await h.context.commitTodoVisibility("relay_1", false, 1, "undo-stable-key");
  assert.equal(h.context.todoRemovalUndo, null);
});

test("double-clicks make one request and a reply for the previous account cannot mutate the next account's view", async () => {
  let resolve;
  const h = mutationHarness(() => new Promise(done => { resolve=done; }));
  const first = h.context.commitTodoVisibility("relay_1", true, 0);
  assert.equal(await h.context.commitTodoVisibility("relay_1", true, 0), false);
  assert.equal(h.calls.length, 1);
  h.context.payload.account.id="different-owner";
  resolve({ ok:true, removed:true, version:1 });
  assert.equal(await first, false);
  assert.equal(h.notices.length, 0);
  assert.equal(h.row.todoRemoved, undefined);
});

test("the menu has its own button and cannot trigger the row's read/open handler", async () => {
  const listeners={};
  const openButton={addEventListener:(name,handler) => {listeners.open=handler;}};
  const menuButton={addEventListener:(name,handler) => {listeners.menu=handler;}};
  const item={relayId:"relay_1",todoVisibilityVersion:0};
  let opens=0, reads=0, menus=0;
  const row={getAttribute:() => "relay_1",querySelector:selector => selector==="[data-todo-open]"?openButton:menuButton};
  const context=vm.createContext({
    tasksListEl:{querySelectorAll:selector => selector==="[data-todo-item]"?[row]:[],querySelector:() => null},
    todoDuplicateSource:null, todoItemById:() => item, openTodoActions:() => {menus++;},
    payload:{relays:[{id:"relay_1",unread:true}]}, persistReadIds:() => {reads++;}, openTodoItem:async () => {opens++;},
  });
  vm.runInContext(between("  function wireTodoBoard()", "  function renderTasksBoard()"),context);
  context.wireTodoBoard();
  listeners.menu({stopPropagation(){},currentTarget:menuButton});
  assert.equal(menus,1); assert.equal(reads,0); assert.equal(opens,0);
  await listeners.open(); assert.equal(reads,1); assert.equal(opens,1);
});

test("an old poll cannot undo a newer removal, and a newer restoration preserves chat content and unread state", () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"relay-todo-visibility-"));
  const statePath=path.join(dir,"state.json");
  const item={relayId:"relay_1",state:"delivered",title:"Keep the chat",createdAt:"2026-09-07T10:00:00Z",updatedAt:"2026-09-07T10:00:00Z",sender:{name:"Sven"}};
  const packet={forHuman:"Keep these words.",forAgent:"Keep the context.",attachments:[]};
  const stage=(removed,version) => stagePlainRelayItem({item:{...item,todoRemoved:removed,todoVisibilityVersion:version},packet},{statePath});
  const read=() => JSON.parse(fs.readFileSync(statePath,"utf8")).packets.relay_1;
  try {
    stage(true,1); stage(false,0);
    assert.equal(read().todoRemoved,true);
    assert.equal(read().todoVisibilityVersion,1);
    stage(false,2); stage(true,1);
    assert.equal(read().todoRemoved,false);
    assert.equal(read().todoVisibilityVersion,2);
    assert.equal(read().state,"unread");
    assert.equal(read().forHuman,packet.forHuman);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});
