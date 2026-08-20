import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../overlay/work-ui.js", import.meta.url), "utf8");

function load(extra = {}) {
  const sandbox = {
    setTimeout, clearTimeout,
    requestAnimationFrame:(fn) => { fn(); return 1; }, cancelAnimationFrame() {},
    performance:{ now:() => 0 }, ...extra,
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(source, sandbox);
  return sandbox.RelayWorkUI;
}

test("Work presentation pins installed Codex typography to the audited 14/21 formula", () => {
  assert.deepEqual({ ...load().NATIVE_TYPOGRAPHY }, { fontSizePx:14, lineHeightPx:21, lineHeightRatio:1.5 });
});

test("canonical conversation units preserve turn chronology and keep strict final separate", () => {
  const ui = load();
  const view = ui.normalizeConversationView([
    { id:"t1", status:"completed", timing:{ durationMs:2300 }, units:[
      { id:"u1", type:"message", side:"right", placement:"user", text:"Please inspect it" },
      { id:"a1", type:"activity", placement:"collapsible", activity:{ kind:"read" } },
      { id:"q1", type:"request", placement:"blocking", blocking:true, text:"Approve?" },
      { id:"f1", type:"message", side:"left", phase:"final_answer", placement:"final", text:"Done." },
    ] },
  ]);
  assert.equal(view.turns[0].users[0].text, "Please inspect it");
  assert.equal(view.turns[0].units.map((unit) => unit.key).join(","), "u1,a1,q1,f1");
  assert.equal(view.turns[0].units.find((unit) => unit.blocking).key, "q1");
  assert.equal(view.turns[0].final.text, "Done.");
  assert.equal(view.turns[0].timing.durationMs, 2300);
});

test("native provider state survives renderer normalization without disabling a blocked composer", () => {
  const turn = load().normalizeConversationView([{ id:"cowork", status:"inProgress", providerState:"blocked",
    providerLabel:"Needs input", composerAvailable:true, requiresAction:true, units:[] }]).turns[0];
  assert.deepEqual({ state:turn.providerState, label:turn.providerLabel, composer:turn.composerAvailable, action:turn.requiresAction },
    { state:"blocked", label:"Needs input", composer:true, action:true });
});

test("a settled final without activity has no fabricated summary unit", () => {
  const ui = load();
  const result = ui.normalizeConversationView([{ id:"t", status:"completed", units:[
    { id:"f", type:"message", side:"left", phase:"final_answer", placement:"final", text:"Answer" },
  ] }]);
  assert.equal(result.turns[0].units.length, 1);
  assert.equal(result.turns[0].final.text, "Answer");
});

test("every same-turn user/Steer stays in canonical position", () => {
  const turn = load().normalizeConversationView([{ key:"turn-1", status:"completed", settled:true, units:[
    { id:"u1", type:"message", side:"right", placement:"user", text:"first" },
    { id:"a1", type:"activity", placement:"collapsible", activity:{ kind:"read" } },
    { id:"u2", type:"message", side:"right", placement:"user", text:"steer" },
    { id:"f1", type:"message", side:"left", phase:"final_answer", placement:"final", text:"done" },
  ] }]).turns[0];
  assert.deepEqual(turn.units.map((unit) => [unit.id, unit.placement]), [
    ["u1", "user"], ["a1", "collapsible"], ["u2", "user"], ["f1", "final"],
  ]);
  assert.deepEqual(turn.users.map((unit) => unit.text), ["first", "steer"]);
  assert.equal(turn.final.text, "done");
});

test("shared turn partition produces right/left/right/final physical order", () => {
  const ui = load();
  const turn = ui.normalizeConversationView([{ key:"t", settled:true, canCollapse:true, summary:"Worked for 2 sec", units:[
    { id:"u1", type:"message", placement:"user", text:"first" },
    { id:"a1", type:"activity", placement:"collapsible" },
    { id:"u2", type:"message", placement:"user", text:"steer" },
    { id:"c2", type:"message", placement:"collapsible", text:"checking" },
    { id:"f1", type:"message", placement:"final", phase:"final_answer", text:"done" },
  ] }]).turns[0];
  assert.equal(ui.partitionTurn(turn).map((block) => block.type).join(","), "user,activity,user,activity,divider,final");
  assert.equal(ui.partitionTurn(turn).filter((block) => block.type === "user").map((block) => block.unit.text).join(","), "first,steer");
});

test("divider is absent when a persistent unit sits between disclosure and final", () => {
  const blocks = load().partitionTurn({ key:"t", canCollapse:true, summary:"Worked", units:[
    { id:"a", placement:"collapsible" },
    { id:"q", placement:"blocking" },
    { id:"f", placement:"final", text:"done" },
  ] });
  assert.equal(blocks.map((block) => block.type).join(","), "activity,unit,final");
});

test("summary changes stabilize for 1000ms", () => {
  const timers = [];
  const commits = [];
  const ui = load();
  const stable = ui.createSummaryStabilizer({ delayMs:1000, setTimer:(fn, ms) => (timers.push({ fn, ms }), timers.length), clearTimer() {} });
  stable.offer("t", "Worked for 1 sec", (value) => commits.push(value));
  stable.offer("t", "Worked for 2 sec", (value) => commits.push(value));
  assert.deepEqual(commits, ["Worked for 1 sec"]);
  assert.equal(timers[0].ms, 1000);
  timers[0].fn();
  assert.deepEqual(commits, ["Worked for 1 sec", "Worked for 2 sec"]);
});

test("summary stabilizer hydrates replacement nodes and repaint cannot postpone a pending label", () => {
  const timers = [];
  const cleared = [];
  const ui = load();
  const stable = ui.createSummaryStabilizer({
    delayMs:1000,
    setTimer:(fn, ms) => (timers.push({ fn, ms }), timers.length),
    clearTimer:(id) => cleared.push(id),
  });
  const firstNode = { textContent:"" };
  stable.offer("request:turn", "Worked for 1 sec", (value) => { firstNode.textContent = value; });
  assert.equal(firstNode.textContent, "Worked for 1 sec");

  const replacementNode = { textContent:"" };
  stable.offer("request:turn", "Worked for 1 sec", (value) => { replacementNode.textContent = value; });
  assert.equal(replacementNode.textContent, "Worked for 1 sec");

  stable.offer("request:turn", "Worked for 2 sec", (value) => { replacementNode.textContent = value; });
  const pendingReplacementNode = { textContent:"" };
  stable.offer("request:turn", "Worked for 2 sec", (value) => { pendingReplacementNode.textContent = value; });
  assert.equal(timers.length, 1);
  assert.deepEqual(cleared, []);
  assert.equal(pendingReplacementNode.textContent, "Worked for 1 sec");
  timers[0].fn();
  assert.equal(replacementNode.textContent, "Worked for 1 sec");
  assert.equal(pendingReplacementNode.textContent, "Worked for 2 sec");

  stable.offer("request:turn", "Worked for 3 sec", (value) => { pendingReplacementNode.textContent = value; });
  stable.offer("request:turn", "Worked for 2 sec", (value) => { pendingReplacementNode.textContent = value; });
  assert.deepEqual(cleared, [2]);
  assert.equal(pendingReplacementNode.textContent, "Worked for 2 sec");
});

function fakeElement() {
  const attrs = new Map(); const listeners = new Map();
  return {
    style:{}, scrollHeight:84, inert:false, firstElementChild:null,
    setAttribute:(k, v) => attrs.set(k, String(v)), getAttribute:(k) => attrs.get(k) || null,
    removeAttribute:(k) => attrs.delete(k), addEventListener:(k, fn) => listeners.set(k, fn),
    removeEventListener:(k) => listeners.delete(k), dispatch:(k, event = {}) => listeners.get(k)?.({ target:null, ...event }),
    getBoundingClientRect:() => ({ height:84 }), attrs,
  };
}

test("four-state disclosure stays mounted and enforces inert/ARIA through closing", () => {
  const button = fakeElement(); const body = fakeElement(); body.firstElementChild = fakeElement();
  const root = fakeElement(); root.querySelector = (selector) => selector.includes("toggle") ? button : body;
  const ui = load({ ResizeObserver:class { observe() {} disconnect() {} } });
  const controller = ui.createDisclosureController(root);
  assert.equal(controller.state, "collapsed"); assert.equal(body.inert, true);
  controller.toggle(); assert.equal(controller.state, "opening"); assert.equal(body.inert, false);
  body.dispatch("transitionend", { target:body, propertyName:"height" });
  assert.equal(controller.state, "expanded");
  controller.toggle(); assert.equal(controller.state, "closing"); assert.equal(body.inert, true);
  assert.equal(body.attrs.get("aria-hidden"), "true");
  body.dispatch("transitionend", { target:body, propertyName:"height" });
  assert.equal(controller.state, "collapsed");
});

test("scrollbar/touch upward movement detaches native follow mode", () => {
  const listeners = new Map();
  const scroller = {
    scrollHeight:1000, clientHeight:300, scrollTop:700, style:{ setProperty() {} },
    addEventListener:(name, fn) => listeners.set(name, fn), removeEventListener:(name) => listeners.delete(name),
    querySelectorAll:() => [], getBoundingClientRect:() => ({ top:0 }),
    scrollTo({ top }) { this.scrollTop = top; },
  };
  const footer = { getBoundingClientRect:() => ({ height:64 }) };
  const ui = load({ ResizeObserver:class { observe() {} disconnect() {} } });
  const controller = ui.createScrollController(scroller, footer);
  assert.equal(controller.isFollowing(), true);
  listeners.get("pointerdown")({ isTrusted:true });
  scroller.scrollTop = 500;
  listeners.get("scroll")({ isTrusted:true });
  listeners.get("pointerup")({ isTrusted:true });
  assert.equal(controller.isFollowing(), false);
  controller.destroy();
});

test("native follow owns asynchronous content growth until the user detaches", () => {
  const listeners = new Map(); let contentResize;
  const content = {};
  const scroller = {
    scrollHeight:700, clientHeight:300, scrollTop:400, firstElementChild:content,
    style:{ setProperty() {} }, querySelector:() => content, querySelectorAll:() => [],
    getBoundingClientRect:() => ({ top:0 }),
    addEventListener:(name, fn) => listeners.set(name, fn), removeEventListener:(name) => listeners.delete(name),
    scrollTo({ top }) { this.scrollTop = top; },
  };
  class ResizeObserver { constructor(fn) { this.fn = fn; } observe(node) { if (node === content) contentResize = this.fn; } disconnect() {} }
  const controller = load({ ResizeObserver }).createScrollController(scroller, { getBoundingClientRect:() => ({ height:60 }) });
  scroller.scrollHeight = 980; contentResize();
  assert.equal(scroller.scrollTop, 680);
  listeners.get("pointerdown")({ isTrusted:true }); scroller.scrollTop = 420; listeners.get("scroll")({ isTrusted:true }); listeners.get("pointerup")({ isTrusted:true });
  scroller.scrollHeight = 1200; contentResize();
  assert.equal(scroller.scrollTop, 420);
  controller.destroy();
});

test("both Work surfaces use push subscriptions and stable keyed reconciliation", () => {
  const inbox = fs.readFileSync(new URL("../overlay/inbox.html", import.meta.url), "utf8");
  const preview = fs.readFileSync(new URL("../overlay/preview-renderer.js", import.meta.url), "utf8");
  assert.match(inbox, /watchRunFeed/);
  assert.match(inbox, /function keyedChildren/);
  assert.doesNotMatch(inbox, /setInterval\(tick/);
  assert.match(preview, /watchSession|watchRunFeed/);
  assert.match(preview, /if \(!subscribeNativeRun\) pollSession/);
  assert.match(preview, /if \(!revision && sessionRevision > 0\) return/);
  assert.doesNotMatch(preview, /sessionListEl\.replaceChildren/);
  assert.doesNotMatch(preview, /setInterval\(/);
  assert.match(inbox, /font-size:14px; line-height:21px/);
});

test("historical images use only the authorized bounded attachment channel", () => {
  const inbox = fs.readFileSync(new URL("../overlay/inbox.html", import.meta.url), "utf8");
  const preview = fs.readFileSync(new URL("../overlay/preview-renderer.js", import.meta.url), "utf8");
  const preload = fs.readFileSync(new URL("../overlay/preload.cjs", import.meta.url), "utf8");
  const previewPreload = fs.readFileSync(new URL("../overlay/preview-preload-source.cjs", import.meta.url), "utf8");
  assert.match(preload, /relay:runFeed:attachment/);
  assert.match(previewPreload, /relay:runFeed:attachment/);
  assert.match(inbox, /runFeedAttachment/);
  assert.match(preview, /runFeedAttachment/);
  assert.equal(inbox.includes("/^https:\\/\\//"), false);
  assert.equal(preview.includes("/^https:\\/\\//"), false);
});
