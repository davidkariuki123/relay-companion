"use strict";
// Resolves "which Claude Desktop chat is the user in right now" off the pill's
// main thread. findCurrentClaudeSession reads Claude's focus log and walks the
// desktop session folder synchronously; on a laptop with hundreds of chats that
// is 1.3 s after a restart, and the Open-in picker asks for it when it opens
// and again every 2 s while it stays open. The ranking logic itself is
// untouched: this worker runs the same function and posts its answer.
const { parentPort, workerData } = require("node:worker_threads");
const { findCurrentClaudeSession } = require("../src/claude-inject.cjs");

let result = null;
try {
  result = findCurrentClaudeSession(workerData && workerData.options ? workerData.options : {}) || null;
} catch {
  result = null;
}
parentPort.postMessage(result);
