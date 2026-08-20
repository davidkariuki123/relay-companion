import assert from "node:assert/strict";
import test from "node:test";
import windowFit from "../overlay/window-fit.cjs";

const { fittedOverlayBounds, shouldIgnoreOverlayMouse } = windowFit;
const workArea = { x: 100, y: 40, width: 1400, height: 900 };
const options = {
  margin: 8,
  anchor: { top: 24, right: 36 },
  frame: { left: 4, bottom: 56 },
  maximum: { w: 720, h: 800 },
};

test("the native pill window fits the visible collapsed card", () => {
  assert.deepEqual(fittedOverlayBounds(workArea, { w: 244, h: 44 }, options), {
    x: 1208,
    y: 48,
    width: 284,
    height: 124,
  });
});

test("every card size keeps the visible card on the same top-right anchor", () => {
  const collapsed = fittedOverlayBounds(workArea, { w: 244, h: 44 }, options);
  const reader = fittedOverlayBounds(workArea, { w: 720, h: 760 }, options);
  const cardRight = (bounds) => bounds.x + bounds.width - options.anchor.right;
  const cardTop = (bounds) => bounds.y + options.anchor.top;
  assert.equal(cardRight(collapsed), cardRight(reader));
  assert.equal(cardTop(collapsed), cardTop(reader));
  assert.deepEqual(reader, { x: 732, y: 48, width: 760, height: 840 });
});

test("malformed renderer sizes cannot claim an oversized invisible window", () => {
  assert.deepEqual(fittedOverlayBounds(workArea, { w: 99999, h: 99999 }, options), {
    x: 732,
    y: 48,
    width: 760,
    height: 880,
  });
});

test("only the visible card receives mouse input", () => {
  const card = { x: 100, y: 80, w: 720, h: 760 };
  assert.equal(shouldIgnoreOverlayMouse({ x: 500, y: 500 }, card), false);
  assert.equal(shouldIgnoreOverlayMouse({ x: 500, y: 850 }, card), true, "the transparent strip below the card is click-through");
  assert.equal(shouldIgnoreOverlayMouse({ x: 90, y: 500 }, card), true);
  assert.equal(shouldIgnoreOverlayMouse({ x: 95, y: 500 }, card, 6), false, "the spring overshoot tolerance remains interactive");
});
