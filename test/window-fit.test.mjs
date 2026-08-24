import assert from "node:assert/strict";
import test from "node:test";
import windowFit from "../overlay/window-fit.cjs";

const { fittedOverlayBounds, shouldIgnoreOverlayMouse } = windowFit;
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

test("only the visible card inside a fixed compositor surface receives input", () => {
  const card = { x: 1074, y: 8, w: 244, h: 44 };
  assert.equal(shouldIgnoreOverlayMouse({ x: 1100, y: 30 }, card), false);
  assert.equal(shouldIgnoreOverlayMouse({ x: 1000, y: 30 }, card), true);
  assert.equal(shouldIgnoreOverlayMouse({ x: 1100, y: 100 }, card), true);
});

test("hit-test padding is hysteresis around the visible card, not a second surface", () => {
  const card = { x: 1074, y: 8, w: 244, h: 44 };
  assert.equal(shouldIgnoreOverlayMouse({ x: 1070, y: 30 }, card, 6), false);
  assert.equal(shouldIgnoreOverlayMouse({ x: 1060, y: 30 }, card, 6), true);
});
