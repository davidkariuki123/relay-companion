import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
const { createController, labelFor } = createRequire(import.meta.url)("../overlay/chat-typing.cjs");

const flush = async () => { for (let i=0; i<12; i++) await Promise.resolve(); };
function setup(read = async (context) => ({ ok:true, chatId:context.chatId, participants:[] })) {
  let time = 0, seq = 0;
  const timers = new Map(), writes = [], paints = [];
  const controller = createController({ read, write:async (context, typing) => writes.push([context.chatId, typing]),
    onChange:(people) => paints.push(people), now:() => time,
    setTimer:(fn, ms) => { const id=++seq; timers.set(id,{ fn, at:time+ms }); return id; },
    clearTimer:(id) => timers.delete(id),
  });
  async function advance(ms) {
    const end = time + ms;
    while (true) {
      const next = [...timers].sort((a,b) => a[1].at-b[1].at)[0];
      if (!next || next[1].at > end) break;
      time=next[1].at; timers.delete(next[0]); next[1].fn(); await flush();
    }
    time=end; await flush();
  }
  return { controller, writes, paints, advance, timers };
}
test("B describes single and group typists, including ambiguous first names", () => {
  const people=(...names)=>names.map(name=>({name}));
  assert.equal(labelFor([]), "");
  assert.equal(labelFor(people("Shane Acton")), "Shane is typing");
  assert.equal(labelFor(people("Shane Acton", "Sven Ozwellmann")), "Shane and Sven are typing");
  assert.equal(labelFor(people("Shane Acton", "Sven Ozwellmann", "David", "Jane")), "Shane, Sven + 2 are typing");
  assert.equal(labelFor(people("Alex One", "Alex Two")), "Alex One and Alex Two are typing");
});
test("keystrokes throttle, idle stops, room changes stop the old room and disposal is silent", async () => {
  const t=setup();
  t.controller.setContext({ chatId:"a" });
  for(let i=0;i<20;i++) t.controller.input(true);
  await flush(); assert.deepEqual(t.writes, [["a",true]]);
  await t.advance(2000); t.controller.input(true); await flush();
  assert.deepEqual(t.writes, [["a",true],["a",true]]);
  await t.advance(3000); assert.deepEqual(t.writes.at(-1), ["a",false]);
  t.controller.input(true); t.controller.setContext({ chatId:"b" }); t.controller.input(true); await flush();
  assert.deepEqual(t.writes.slice(-3), [["a",true],["a",false],["b",true]]);
  t.controller.input(false); await flush(); assert.deepEqual(t.writes.at(-1), ["b",false]);
  t.controller.destroy(); assert.equal(t.timers.size,0);
});
test("stale responses never cross rooms; failure and local expiry clear the indicator", async () => {
  const pending=[];
  const t=setup((context)=>new Promise(resolve=>pending.push({context,resolve})));
  t.controller.setContext({chatId:"a"});
  t.controller.setContext({chatId:"b"});
  pending[0].resolve({ok:true,chatId:"a",participants:[{id:"one",name:"Wrong person",expiresInMs:6000}]}); await flush();
  assert.deepEqual(t.paints.at(-1), []);
  pending[1].resolve({ok:true,chatId:"b",participants:[{id:"two",name:"Shane",expiresInMs:4000}]}); await flush();
  assert.equal(t.paints.at(-1)[0].name,"Shane");
  await t.advance(4001); assert.deepEqual(t.paints.at(-1), [], "expiry clears even while a network read is stuck");
  pending[2].resolve({ok:false}); await flush(); assert.deepEqual(t.paints.at(-1),[]);
  t.controller.destroy(); await t.advance(60_000); assert.equal(t.timers.size,0);
});
test("a delayed read cannot renew an already expired lease", async () => {
  let resolve;
  const t=setup(()=>new Promise(r=>resolve=r));
  t.controller.setContext({chatId:"a"}); await t.advance(7000);
  resolve({ok:true,chatId:"a",participants:[{id:"one",name:"Shane",expiresInMs:6000}]}); await flush();
  assert.deepEqual(t.paints.at(-1),[]); t.controller.destroy();
});
