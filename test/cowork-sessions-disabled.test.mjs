import assert from "node:assert/strict";
import test from "node:test";
import {
  appendCoworkMessage,
  createAndSeedCoworkSession,
  listCoworkSessions,
  readCoworkSession,
} from "../src/cowork-sessions.js";

test("Cowork transport is disabled without touching credentials or the network", async () => {
  for (const operation of [listCoworkSessions, createAndSeedCoworkSession, readCoworkSession, appendCoworkMessage]) {
    await assert.rejects(operation(), /temporarily unavailable/);
  }
});
