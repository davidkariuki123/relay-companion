"use strict";
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const file = homeDir => path.join(homeDir, ".relay", "recovery", "intent.json");
function stopped(homeDir = os.homedir()) {
  try { return JSON.parse(fs.readFileSync(file(homeDir), "utf8")).stopped === true; }
  catch (error) { return error.code !== "ENOENT"; }
}
function setStopped(value, homeDir = os.homedir()) {
  require("./recovery-launcher.cjs").write(file(homeDir), { schema: 1, stopped: value, at: Date.now() });
}
module.exports = { stopped, setStopped };
