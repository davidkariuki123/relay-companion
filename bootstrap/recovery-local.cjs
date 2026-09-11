"use strict";
const fs = require("node:fs"), path = require("node:path");
const { verifyExtractedRuntime, releasePlatform } = require("./relay-setup.cjs");
const { verifyCanonicalTreeComplete } = require("./runtime-tree.cjs");

// Read files only. Never import a failed application's recovery engine to decide
// whether it is usable. Sources are committed pointers, not arbitrary disk scans.
function validateLocalRuntime(target, { platform = process.platform, arch = process.arch } = {}) {
  if (!target?.packageRoot || !path.isAbsolute(target.packageRoot) || !/^\d+\.\d+\.\d+$/.test(target.version || "")) return false;
  try {
    verifyExtractedRuntime(target.packageRoot, target.version, releasePlatform(platform, arch));
    const tree = verifyCanonicalTreeComplete(target.packageRoot, { platform });
    return tree.ok && tree.verified && fs.statSync(path.join(target.packageRoot, "src", "recovery-entry.js")).isFile();
  } catch { return false; }
}
module.exports = { validateLocalRuntime };
