import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const html = fs.readFileSync(new URL('../overlay/inbox.html', import.meta.url), 'utf8');
const source = html.slice(html.indexOf('  let cardViewTransition = null;'), html.indexOf('  let peeking = false'));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return {promise,resolve}; };
function harness({ reduced = false, barrier = Promise.resolve() } = {}) {
  const finished = deferred();
  const ready = deferred();
  const receipts = [];
  let callback;
  const context = vm.createContext({
    REDUCED:reduced, collapsed:false, ghost:false, raf:null,
    W:{v:344,t:344,vel:0}, H:{v:524,t:524,vel:0}, EXPANDED:{w:344,h:524},
    cardEl:{style:{}}, scrollEl:{style:{}}, cardMotionId:0,
    activeView:'threads', threadDetailEntryFollow:{token:1},
    window:{relay:{prepareCardSize:() => barrier}},
    document:{documentElement:{classList:{add(){},remove(){}}},
      startViewTransition(update) {
        callback = update;
        queueMicrotask(() => { update(); ready.resolve(); });
        return {ready:ready.promise,updateCallbackDone:ready.promise,finished:finished.promise,skipTransition(){finished.resolve();}};
      }},
    requestAnimationFrame:cb => setImmediate(cb), cancelAnimationFrame:clearImmediate,
    queueMicrotask, publishCardSize:(w,h) => receipts.push(['prepare',w,h]),
    commitSettledCardSize:(w,h) => receipts.push(['settled',w,h]),
    supersedeRoomViewTransition(){},cleanReaderMorph(){},assessReaderFit(){},onPayload(){},
  });
  vm.runInContext(source, context);
  return {context,receipts,finished,ready,callback:()=>callback, active:()=>vm.runInContext('!!cardViewTransition',context)};
}

test('native shrink waits for the rendered transition and restores layout before capture', async () => {
  const h = harness(); h.context.W.v = h.context.W.t = 720; h.context.H.v = h.context.H.t = 760;
  let restored = false;
  const work = h.context.startCardViewTransition(() => () => { restored = true; }, {w:344,h:524});
  await h.ready.promise;
  assert.equal(restored,true);
  assert.equal(h.context.threadDetailEntryFollow,null);
  assert.equal(h.context.W.v,344);
  assert.equal(h.context.cardEl.style.viewTransitionName,'relay-card');
  assert.deepEqual(h.receipts,[['prepare',720,760]]);
  h.finished.resolve(); await work;
  assert.deepEqual(h.receipts.at(-1),['settled',344,524]);
  assert.equal(h.active(),false);
});

test('navigation during native preparation invalidates the obsolete reader callback', async () => {
  const barrier = deferred(); const h = harness({barrier:barrier.promise}); let updates=0;
  const work = h.context.startCardViewTransition(() => updates++, {w:720,h:760});
  h.context.cancelCardViewTransition(); barrier.resolve(); await work;
  assert.equal(updates,0); assert.equal(h.context.W.v,344); assert.equal(h.active(),false);
});

test('a skipped platform callback cannot resurrect a superseded reader', async () => {
  const h = harness();let updates=0;
  const work=h.context.startCardViewTransition(() => updates++,{w:720,h:760});
  await h.ready.promise;h.context.cancelCardViewTransition();h.callback()();await work;
  assert.equal(updates,1);assert.equal(h.active(),false);
});

test('reduced motion and native barrier failure still commit exactly once', async () => {
  for(const settings of [{reduced:true},{barrier:Promise.reject(new Error('native unavailable'))}]) {
    const h=harness(settings);let updates=0;
    await h.context.startCardViewTransition(() => updates++,{w:720,h:760});
    assert.equal(updates,1);assert.equal(h.context.W.v,720);assert.equal(h.active(),false);
    assert.deepEqual(h.receipts.at(-1),['settled',720,760]);
  }
});
