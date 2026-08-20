// Name-claim matching against the local checkout index.
import assert from "node:assert/strict";
import test from "node:test";
import { findCheckouts, matchesNameClaim } from "../src/repo-index.js";

const INDEX = [
  { dir: "/Users/d/src/relay", originKey: "github.com/davidkariuki123/relay", rootCommit: "aaa", uses: 5, lastUsedAt: 500, isPrimary: true },
  { dir: "/Users/d/src/granular", originKey: "github.com/davidkariuki123/granular", rootCommit: "bbb", uses: 9, lastUsedAt: 900, isPrimary: true },
  { dir: "/Users/d/src/relay-wt", originKey: "github.com/davidkariuki123/relay", rootCommit: "aaa", uses: 1, lastUsedAt: 100, isPrimary: false },
  { dir: "/Users/d/scratch/notes", originKey: "", rootCommit: "ccc", uses: 1, lastUsedAt: 50, isPrimary: true },
];

test("matchesNameClaim matches the repo's name segment", () => {
  assert.ok(matchesNameClaim(INDEX[0], "relay"));
  assert.ok(matchesNameClaim(INDEX[0], "RELAY"), "case-insensitive");
  assert.ok(!matchesNameClaim(INDEX[0], "granular"));
});

test("matchesNameClaim matches an owner/name claim against the origin tail", () => {
  assert.ok(matchesNameClaim(INDEX[0], "davidkariuki123/relay"));
  assert.ok(!matchesNameClaim(INDEX[0], "someoneelse/relay"), "a different owner is a different repo");
});

test("matchesNameClaim falls back to the directory name for origin-less clones", () => {
  assert.ok(matchesNameClaim(INDEX[3], "notes"));
  assert.ok(!matchesNameClaim(INDEX[3], "relay"));
});

test("matchesNameClaim never matches on empty input", () => {
  for (const bad of ["", "   ", null, undefined]) assert.equal(matchesNameClaim(INDEX[0], bad), false);
});

test("exact identity always beats a name claim", () => {
  // A name is a weaker key, so it must only be consulted once exact matching fails.
  const found = findCheckouts({ originKey: "github.com/davidkariuki123/granular", nameClaim: "relay" }, { index: INDEX });
  assert.deepEqual(found.map((c) => c.dir), ["/Users/d/src/granular"]);
});

test("a name claim resolves and ranks like any other match", () => {
  const found = findCheckouts({ nameClaim: "relay" }, { index: INDEX });
  assert.deepEqual(
    found.map((c) => c.dir),
    ["/Users/d/src/relay", "/Users/d/src/relay-wt"],
    "most recently used checkout first",
  );
});

test("an origin that finds nothing locally falls back to the repo name", () => {
  // The recipient cloned the same project from a different fork or forge.
  const found = findCheckouts({ originKey: "github.com/a-fork/relay", rootCommit: "", nameClaim: "relay" }, { index: INDEX });
  assert.deepEqual(found.map((c) => c.dir), ["/Users/d/src/relay", "/Users/d/src/relay-wt"]);
});

test("no key at all matches nothing", () => {
  assert.deepEqual(findCheckouts({}, { index: INDEX }), []);
  assert.deepEqual(findCheckouts({ nameClaim: "" }, { index: INDEX }), []);
});
