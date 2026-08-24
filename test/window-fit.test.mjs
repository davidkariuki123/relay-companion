import assert from "node:assert/strict";
import test from "node:test";
import windowFit from "../overlay/window-fit.cjs";

const { fittedOverlayBounds, resizedOverlayBounds } = windowFit;
const workArea = { x: 100, y: 40, width: 1400, height: 900 };
const options = {
  margin: 8,
  maximum: { w: 720, h: 800 },
};

test("the native pill window fits the visible collapsed card", () => {
  assert.deepEqual(fittedOverlayBounds(workArea, { w: 244, h: 44 }, options), {
    x: 1248,
    y: 48,
    width: 244,
    height: 44,
  });
});

test("every card size keeps the visible card on the same top-right anchor", () => {
  const collapsed = fittedOverlayBounds(workArea, { w: 244, h: 44 }, options);
  const reader = fittedOverlayBounds(workArea, { w: 720, h: 760 }, options);
  const cardRight = (bounds) => bounds.x + bounds.width;
  const cardTop = (bounds) => bounds.y;
  assert.equal(cardRight(collapsed), cardRight(reader));
  assert.equal(cardTop(collapsed), cardTop(reader));
  assert.deepEqual(reader, { x: 772, y: 48, width: 720, height: 760 });
});

test("malformed renderer sizes cannot claim an oversized invisible window", () => {
  assert.deepEqual(fittedOverlayBounds(workArea, { w: 99999, h: 99999 }, options), {
    x: 772,
    y: 48,
    width: 720,
    height: 800,
  });
});

test("resizing preserves a user-positioned window's top-right corner", () => {
  const current = { x: 500, y: 120, width: 344, height: 524 };
  assert.deepEqual(resizedOverlayBounds(current, { w: 720, h: 760 }, options), {
    x: 124,
    y: 120,
    width: 720,
    height: 760,
  });
});

test("a dragged pill collapses and expands around the same screen-space anchor", () => {
  const dragged = { x: 500, y: 320, width: 344, height: 524 };
  const collapsed = resizedOverlayBounds(dragged, { w: 244, h: 44 }, options);
  const expanded = resizedOverlayBounds(collapsed, { w: 344, h: 524 }, options);
  assert.deepEqual(collapsed, { x: 600, y: 320, width: 244, height: 44 });
  assert.deepEqual(expanded, dragged);
  assert.equal(collapsed.x + collapsed.width, dragged.x + dragged.width);
  assert.equal(expanded.x + expanded.width, dragged.x + dragged.width);
});
