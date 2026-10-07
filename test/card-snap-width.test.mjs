import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const html = fs.readFileSync(new URL("../overlay/inbox.html", import.meta.url), "utf8");
const snapSource = html.slice(html.indexOf("  function snapSize("), html.indexOf("  function resetOffstage("));
const syncSource = html.slice(html.indexOf("  function syncCardSize("), html.indexOf("  function cleanReaderMorph("));

function fixture(width) {
  const commits = [];
  const springs = [];
  const cancelled = [];
  const context = vm.createContext({
    W:{ v:width, t:width, vel:4 }, H:{ v:760, t:760, vel:3 },
    raf:7, cardMotionId:0, EXPANDED:{ w:344, h:524 }, READER:{ w:720, h:760 },
    cardEl:{ style:{ width:`${width}px`, height:"760px", willChange:"width" } },
    scrollEl:{ style:{ width:`${width}px` } },
    collapsed:false, peeking:false, ghost:false, readerMorphInFlight:false, cardViewTransition:null,
    readerOpenNow:false,
    cancelAnimationFrame:id => cancelled.push(id),
    commitSettledCardSize:(...args) => commits.push(args),
    springTo:(...args) => springs.push(args),
  });
  // The small card (the expanded app is off): the frame is the reader's or the card's.
  vm.runInContext("function openFrameSize(readerOpen = readerOpenNow) { return readerOpen ? READER : EXPANDED; }\n" + snapSource + syncSource, context);
  return { context, commits, springs, cancelled };
}

for (const priorWidth of [400, 720]) {
  test(`closing a ${priorWidth}px surface then reopening compact resets content width`, () => {
    const { context, commits, springs, cancelled } = fixture(priorWidth);
    // resetOffstage and the fresh trayOpen path both use this snap. The next
    // render has no size delta, so syncCardSize correctly skips the spring.
    context.snapSize(344, 524);
    context.syncCardSize(false);
    assert.equal(context.cardEl.style.width, "344px");
    assert.equal(context.scrollEl.style.width, "344px", "conversation must fit inside its card");
    assert.equal(springs.length, 0);
    assert.equal(context.W.vel, 0);
    assert.equal(context.H.vel, 0);
    assert.deepEqual(cancelled, [7]);
    assert.deepEqual(commits, [[344, 524, 1]]);
  });
}

test("a ghost notification snaps its contents to banner width", () => {
  const { context } = fixture(344);
  context.snapSize(400, 180);
  assert.equal(context.scrollEl.style.width, "400px");
});

test("snapping the folded pill preserves the minimum open content width", () => {
  const { context } = fixture(720);
  context.snapSize(120, 44);
  assert.equal(context.scrollEl.style.width, "344px");
});
