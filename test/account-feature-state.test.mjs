import assert from "node:assert/strict";
import test from "node:test";
import stateModule from "../src/account-feature-state.cjs";
import policy from "../src/product-features.cjs";

const { createAccountFeatureState } = stateModule;
const { productFeatures } = policy;
const snapshot = (id, token, cachedRole = false) => ({
  env: { RELAY_ENV: "dev" },
  apiUrl: "https://dev-api.example.test",
  config: { apiUrl: "https://dev-api.example.test", deviceToken: token, user: { id, accountKind: "human", isDeveloper: cachedRole } },
});
const user = (id, role) => ({ id, accountKind: "human", isDeveloper: role });

test("saved roles cannot make Execute visible before this account is verified", () => {
  const state = createAccountFeatureState();
  const david = snapshot("david", "dev_david", true);
  assert.equal(productFeatures({ ...david, user: null }).taskExecution, false);
  assert.equal(state.current(david).taskExecution, false);
  assert.equal(state.apply(david, user("david", true), david).applied, true);
  assert.equal(state.current(david).taskExecution, true);
});

test("account switches clear the previous role and discard late profile responses", () => {
  const state = createAccountFeatureState();
  const david = snapshot("david", "dev_david", true);
  const ordinary = snapshot("ordinary", "dev_ordinary", true); // deliberately stale pairing role
  state.apply(david, user("david", true), david);
  assert.equal(state.current(david).taskExecution, true);
  assert.equal(state.current(ordinary).taskExecution, false);
  assert.equal(state.apply(david, user("david", true), ordinary).applied, false);
  assert.equal(state.current(ordinary).taskExecution, false);
  state.apply(ordinary, user("ordinary", false), ordinary);
  assert.equal(state.current(ordinary).taskExecution, false);
  assert.equal(state.current(david).taskExecution, false);
  state.apply(david, user("david", true), david);
  assert.equal(state.current(david).taskExecution, true);
});

test("token rotation and mismatched server identity cannot reuse a role", () => {
  const state = createAccountFeatureState();
  const old = snapshot("david", "dev_old");
  const rotated = snapshot("david", "dev_new", true);
  state.apply(old, user("david", true), old);
  assert.equal(state.current(rotated).taskExecution, false);
  assert.equal(state.apply(rotated, user("other", true), rotated).applied, false);
  assert.equal(state.current(rotated).taskExecution, false);
  state.apply(rotated, user("david", true), rotated);
  assert.equal(state.current(rotated).taskExecution, true);
  state.clear({ ...rotated, config: { ...rotated.config, deviceToken: "" } });
  assert.equal(state.current({ ...rotated, config: { ...rotated.config, deviceToken: "" } }).taskExecution, false);
});
