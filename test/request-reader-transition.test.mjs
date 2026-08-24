import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const html = fs.readFileSync(new URL("../overlay/inbox.html", import.meta.url), "utf8");

test("opening a row retires notification peek before reader geometry is sampled", () => {
  const start = html.indexOf("function openReader(id, source)");
  const end = html.indexOf("\n  function closeReader", start);
  assert.ok(start >= 0 && end > start, "openReader is present");
  const openReader = html.slice(start, end);
  const clear = openReader.indexOf("clearPeek()");
  const morph = openReader.indexOf("prepareReaderMorph(activeView)");
  assert.ok(clear >= 0, "the transient notification is explicitly retired");
  assert.ok(morph > clear, "peek state is retired before the morph snapshot is taken");
});
const main = fs.readFileSync(new URL("../overlay/main.cjs", import.meta.url), "utf8");
const preload = fs.readFileSync(new URL("../overlay/preload.cjs", import.meta.url), "utf8");

function between(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `missing ${start} .. ${end}`);
  return source.slice(from, to);
}

test("Tasks stages an inert source snapshot before exposing the prepared reader", () => {
  const prepare = between(html, "function prepareReaderMorph", "function startReaderMorph");
  const open = between(html, "function openReader", "function closeReader");

  assert.match(prepare, /const source = \{/);
  assert.match(prepare, /const snapshot = source\.cloneNode\(true\)/);
  assert.match(prepare, /querySelectorAll\("\[id\]"\)/, "the visual clone cannot duplicate live selector ids");
  assert.match(prepare, /setAttribute\("aria-hidden", "true"\)/);
  assert.match(prepare, /readerMorphInFlight = true/);

  const preparedAt = open.indexOf("prepareReaderMorph(activeView)");
  const switchedAt = open.indexOf('activeView = "reader"');
  const committedAt = open.indexOf("commitNavigation(");
  const startedAt = open.indexOf("startReaderMorph()");
  assert.ok(preparedAt >= 0 && preparedAt < switchedAt, "source pixels are captured before navigation state changes");
  assert.ok(switchedAt < committedAt && committedAt < startedAt, "the atomic navigation fully renders the reader before the morph starts");
  const commit = between(html, "function commitNavigation", "function syncTabs");
  assert.match(commit, /renderAll\(\)/, "the shared navigation commit builds the destination before the morph");
});

test("the native window growth barrier resolves before visible reader motion begins", () => {
  const start = between(html, "function startReaderMorph", "let peeking");
  const prepareAt = start.indexOf("await window.relay.prepareCardSize(destinationSize.w, destinationSize.h)");
  const revealAt = start.indexOf('classList.add("reader-morph-go")');
  const springAt = start.indexOf('syncCardSize(destinationView === "reader" || (destinationView === "threads" && chatExpanded))');
  assert.ok(prepareAt >= 0 && prepareAt < revealAt && revealAt < springAt);
  assert.match(preload, /prepareCardSize: \(w, h\) => ipcRenderer\.invoke\("relay:prepareCardSize", w, h\)/);
  assert.match(main, /ipcMain\.handle\("relay:prepareCardSize"/);
  assert.match(main, /event\.sender !== win\.webContents/);
});

test("shared frame crossfade has explicit source and destination states", () => {
  const sourceFrames = between(html, "@keyframes readerSourceOut", "@keyframes readerDestinationIn");
  const destinationFrames = between(html, "@keyframes readerDestinationIn", ".scroll.reader-morph");
  assert.match(sourceFrames, /from \{ opacity:1;/);
  assert.match(sourceFrames, /to \{ opacity:0;/);
  assert.match(destinationFrames, /from \{ opacity:0;/);
  assert.match(destinationFrames, /to \{ opacity:1;/);
  assert.match(html, /\.scroll\.reader-morph:not\(\.reader-morph-go\) \.reader-morph-destination \{ opacity:0; \}/);
  assert.match(html, /\.reader-morph-snapshot \{[^}]*pointer-events:none/s);
  assert.match(html, /@media \(prefers-reduced-motion:reduce\) \{[^}]*\.reader-morph-snapshot \{ display:none;/s);
});

test("the card spring approaches both reader and mini-list sizes monotonically", () => {
  const stepSource = between(html, "function step(s, dt)", "function frame(now)");
  const step = Function("K", "C", "M", `${stepSource}; return step;`)(170, 22, 1);
  const exercise = (from, to) => {
    const state = { v: from, vel: 0, t: to };
    const values = [from];
    for (let i = 0; i < 1000 && step(state, 1 / 120); i += 1) values.push(state.v);
    values.push(state.v);
    assert.equal(state.v, to);
    for (let i = 1; i < values.length; i += 1) {
      if (to > from) assert.ok(values[i] >= values[i - 1] && values[i] <= to);
      else assert.ok(values[i] <= values[i - 1] && values[i] >= to);
    }
  };
  exercise(344, 720);
  exercise(720, 344);
});

test("size preparation updates the fixed canvas hit region without native geometry", () => {
  const prepare = between(main, 'ipcMain.handle("relay:prepareCardSize"', 'ipcMain.on("relay:setPos"');
  assert.match(prepare, /cardSize = \{ w, h \}/);
  assert.doesNotMatch(prepare, /setBounds|setPosition|setSize|fitOverlayWindowToCard/);
});

test("chat, compact rooms, sent, and Tasks share the same source snapshot", () => {
  const prepare = between(html, "function prepareReaderMorph", "function startReaderMorph");
  for (const view of ["chat", "threads", "sent", "tasks"]) {
    assert.match(prepare, new RegExp(`${view}:`), `${view} is a supported compact source`);
  }
  assert.match(html, /startReaderMorph\("threads"\)/, "chat expansion uses the shared coordinator");
});
