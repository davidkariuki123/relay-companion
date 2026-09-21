import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const { createSpring } = createRequire(import.meta.url)("../overlay/reader-status-motion.cjs");
function settle(spring, fps) {
  for (let i = 0; i < fps * 3 && !spring.settled; i += 1) spring.advance(1 / fps);
  assert.equal(spring.settled, true, "finite motion stops requesting frames");
}

for (const fps of [30, 60, 120]) {
  test(`quiet spring settles without visible overshoot at ${fps} fps`, () => {
    const spring = createSpring();
    spring.aim(0);
    let previous = 1;
    for (let i = 0; i < fps * 2; i += 1) {
      const value = spring.advance(1 / fps);
      assert.ok(value <= previous && value >= 0, "withdrawal is monotonic");
      previous = value;
    }
    assert.equal(spring.value, 0);
    spring.aim(1);
    settle(spring, fps);
    assert.equal(spring.value, 1);
  });
}

test("reversing a moving spring preserves its position and momentum", () => {
  const spring = createSpring();
  spring.aim(0);
  for (let i = 0; i < 6; i += 1) spring.advance(1 / 60);
  const before = spring.value;
  spring.aim(1);
  assert.equal(spring.value, before, "retargeting cannot jump");
  assert.ok(spring.advance(1 / 240) < before, "existing downward velocity decelerates before reversing");
  settle(spring, 60);
  assert.equal(spring.value, 1);
});

test("resuming after a long pause remains bounded; reduced motion can snap", () => {
  const spring = createSpring();
  spring.aim(0);
  assert.ok(spring.advance(600) > 0, "a suspended clock does not become one huge integration step");
  spring.snap();
  assert.equal(spring.value, 0);
  assert.equal(spring.settled, true);
  spring.snap(1);
  assert.equal(spring.value, 1);
  assert.equal(spring.target, 1);
});
