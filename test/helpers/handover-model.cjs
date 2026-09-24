"use strict";
// Stateful launchd boundary for fault tests. Never invokes host launchctl.
const fs = require("node:fs"), path = require("node:path");
const LABEL = "work.relay.companion.recovery";
const job = "work.relay.recovery.schedule-handover";
function model(homeDir, options = {}) {
  const stateFile = path.join(homeDir, "launchd-model.json");
  const root = path.join(homeDir, ".relay", "recovery");
  const plist = path.join(homeDir, "Library", "LaunchAgents", `${LABEL}.plist`);
  const plan = interval => ({ Label: LABEL, StartInterval: interval,
    ProgramArguments: [path.join(root, "node", "host", "node"), path.join(root, "launch.cjs")],
    EnvironmentVariables: { HOME: homeDir } });
  const read = () => JSON.parse(fs.readFileSync(stateFile, "utf8"));
  const save = value => fs.writeFileSync(stateFile, JSON.stringify(value));
  if (!fs.existsSync(stateFile)) {
    fs.mkdirSync(path.dirname(plist), { recursive: true }); fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(plist, JSON.stringify(plan(60)));
    fs.writeFileSync(path.join(root, "scheduler-previous.plist"), JSON.stringify(plan(300)));
    save({ loaded: plan(300), job: true, calls: [], bootstrapFailures: 0 });
  }
  const run = (_file, args, commandOptions = {}) => {
    if (_file.endsWith("plutil")) return { status: 0, stdout: String(commandOptions.input) };
    const state = read(); state.calls.push(args[0]); save(state);
    if (options.before) options.before(args, state);
    if (options.exitBefore === args[0]) process.exit(86);
    if (args[0] === "print") {
      if (state.queryUnknown) return { error: Error("query unavailable") };
      if (!state.loaded) return { status: 113, stderr: "Could not find service" };
      return { status: 0, stdout: `${LABEL} = {\n program = ${state.loaded.ProgramArguments[0]}\n arguments = {\n ${state.loaded.ProgramArguments.join("\n ")}\n }\n run interval = ${state.loaded.StartInterval} seconds\n}` };
    }
    if (args[0] === "list") {
      if (state.jobQueryUnknown) return { error: Error("job query unavailable") };
      if (!state.job) return { status: 113 };
      return { status: 0, stdout: `{\n "Label" = "${job}";\n${state.idle ? "" : ` "PID" = ${state.pid || process.pid};\n`}};` };
    }
    if (args[0] === "bootout") {
      if (!state.loaded) return { status: 113 };
      state.loaded = null; save(state);
    } else if (args[0] === "bootstrap") {
      if (state.bootstrapFailures > 0) { state.bootstrapFailures--; save(state); return { status: 1 }; }
      state.loaded = JSON.parse(fs.readFileSync(args[2], "utf8")); save(state);
    } else if (args[0] === "remove") {
      if (state.removeFailure) return { status: 1, stderr: "removal refused" };
      state.job = false; save(state);
    } else throw Error(`unexpected launchctl command: ${args}`);
    if (options.exitAfter === args[0]) process.exit(86);
    return { status: 0 };
  };
  return { run, read, save, plan, plist, root, mutations: () => read().calls.filter(x => ["bootout", "bootstrap", "remove"].includes(x)) };
}
module.exports = { model };
if (require.main === module) {
  const homeDir = process.argv[2];
  require("../../bootstrap/recovery-schedule-handover.cjs").handover({ homeDir, userId: 123,
    attempts: 1, report() {}, run: model(homeDir, process.argv[3].startsWith("before-")
      ? { exitBefore: process.argv[3].slice(7) } : { exitAfter: process.argv[3] }).run });
}
