import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

/**
 * Which tree will the machine's autostart registration actually start?
 *
 * The canonical pointer (~/.relay/runtime/current.json) records which release
 * SHOULD run. The launchd plist / Scheduled Task decides which one WILL run.
 * Nothing in the daemon ever compared the two, so when they disagreed the
 * daemon would exit "so the replacement can start" and launchd would restart
 * the same stale tree — forever, at 4s poll intervals it never survived long
 * enough to reach. Reading the registration is the only way to tell "a newer
 * tree exists" (which the pointer proves) apart from "something will actually
 * start it" (which only the registration proves).
 *
 * Returns null whenever the answer cannot be read. Null means UNKNOWN and must
 * never be treated as agreement: a caller that cannot prove a replacement is
 * coming has to assume none is.
 */

export const DAEMON_LAUNCH_LABEL = "work.relay.companion";
export const WINDOWS_DAEMON_TASK_NAME = "Relay Companion Daemon";

/** `<packageRoot>/bin/relay.js` -> `<packageRoot>`. */
function pathApi(platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

function packageRootForBin(bin, platform = process.platform) {
  const api = pathApi(platform);
  return api.dirname(api.dirname(api.resolve(String(bin))));
}

/** Pull the `<string>` entries out of the ProgramArguments array of a launchd plist. */
export function parseLaunchAgentProgramArguments(xml) {
  const text = String(xml || "");
  const keyAt = text.indexOf("<key>ProgramArguments</key>");
  if (keyAt === -1) return [];
  const arrayStart = text.indexOf("<array>", keyAt);
  if (arrayStart === -1) return [];
  const arrayEnd = text.indexOf("</array>", arrayStart);
  if (arrayEnd === -1) return [];
  const body = text.slice(arrayStart + "<array>".length, arrayEnd);
  return [...body.matchAll(/<string>([\s\S]*?)<\/string>/g)].map((match) =>
    match[1]
      .replaceAll("&lt;", "<")
      .replaceAll("&gt;", ">")
      .replaceAll("&quot;", '"')
      .replaceAll("&apos;", "'")
      .replaceAll("&amp;", "&"),
  );
}

/** The first argument that looks like Relay's entrypoint, ignoring node and its flags. */
function relayBinFromArguments(args) {
  for (const arg of args) {
    if (typeof arg !== "string") continue;
    if (/[\\/]bin[\\/]relay\.js$/.test(arg) || /[\\/]relay\.js$/.test(arg)) return arg;
  }
  return null;
}

function readDarwinRegistration({ homeDir, readFileImpl }) {
  const plistPath = path.posix.join(homeDir, "Library", "LaunchAgents", `${DAEMON_LAUNCH_LABEL}.plist`);
  let xml = null;
  try {
    xml = readFileImpl(plistPath, "utf8");
  } catch {
    return null;
  }
  const bin = relayBinFromArguments(parseLaunchAgentProgramArguments(xml));
  if (!bin) return null;
  return { root: packageRootForBin(bin, "darwin"), bin: path.posix.resolve(bin), source: plistPath };
}

function readWin32Registration({ runCommandImpl }) {
  // Best effort. schtasks is the only readable record of what a logon task will
  // run, and its XML shape is not something this codebase controls, so every
  // failure mode collapses to "unknown" rather than to a guess.
  let result = null;
  try {
    result = runCommandImpl("schtasks.exe", ["/query", "/tn", WINDOWS_DAEMON_TASK_NAME, "/xml", "ONELINE"]);
  } catch {
    return null;
  }
  if (!result || result.status !== 0) return null;
  const xml = String(result.stdout || "");
  const args = [...xml.matchAll(/<(?:Arguments|Command)>([\s\S]*?)<\/(?:Arguments|Command)>/g)].map((m) => m[1]);
  const joined = args.join(" ");
  const match = joined.match(/"?([A-Za-z]:[\\/][^"]*?[\\/]relay\.js)"?/) || joined.match(/"?((?:[\\/][^"]*?)[\\/]relay\.js)"?/);
  if (!match) return null;
  const bin = match[1]
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&");
  return { root: packageRootForBin(bin, "win32"), bin: path.win32.resolve(bin), source: WINDOWS_DAEMON_TASK_NAME };
}

/**
 * Resolve the daemon's autostart registration to a package root.
 * @returns {{root: string, bin: string, source: string} | null} null when unknown.
 */
export function readAutostartDaemonRoot({
  homeDir = os.homedir(),
  platform = process.platform,
  readFileImpl = fs.readFileSync,
  runCommandImpl = (file, args) => spawnSync(file, args, { encoding: "utf8" }),
} = {}) {
  try {
    if (platform === "darwin") return readDarwinRegistration({ homeDir, readFileImpl });
    if (platform === "win32") return readWin32Registration({ runCommandImpl });
  } catch {
    return null;
  }
  return null;
}

/**
 * Will exiting actually hand off to `canonicalRoot`?
 *
 * True only with positive evidence: the registration is readable AND names a
 * tree other than the one asking. Unknown registrations answer false, because
 * the failure this guards against is unrecoverable without a human and the
 * cost of a false negative is merely staying on an older version.
 */
export function autostartWillReplace(bootPackageRoot, {
  homeDir = os.homedir(),
  platform = process.platform,
  readImpl = readAutostartDaemonRoot,
} = {}) {
  const registration = readImpl({ homeDir, platform });
  if (!registration?.root) return { willReplace: false, reason: "registration-unreadable", registration: null };
  // Normalise BOTH sides identically. Resolving only one of them is how a path
  // that is really the same tree can compare unequal, and an unequal compare here
  // is precisely the "a replacement is coming" answer that must never be wrong.
  const normalise = (value) => {
    const resolved = pathApi(platform).resolve(String(value ?? ""));
    return platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  if (normalise(registration.root) === normalise(bootPackageRoot)) {
    return { willReplace: false, reason: "registration-still-names-this-tree", registration };
  }
  return { willReplace: true, reason: "registration-names-another-tree", registration };
}
