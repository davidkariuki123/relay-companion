import fs from "node:fs";
import { parentPort, workerData } from "node:worker_threads";
import { collectCompanionFleetTelemetry, encodeCompanionFleetTelemetry } from "./fleet-telemetry.js";
import { normalizeUpdateChannel } from "./config.js";
import runtimeHealth from "../bootstrap/runtime-health.cjs";
import installationHealth from "../bootstrap/installation-health.cjs";

// Resolve channel metadata without hydrating credentials or migrating config.
// All expensive filesystem work stays here; process enumeration was collected
// asynchronously by the parent and must never be repeated in this worker.
let config = {};
try { config = JSON.parse(fs.readFileSync(workerData.configFile, "utf8")); }
catch (error) { if (error.code !== "ENOENT") throw error; }
const commands = runtimeHealth.parseRuntimeProcessCommands(workerData.processOutput, process.platform);
const report = collectCompanionFleetTelemetry({
  homeDir: workerData.homeDir,
  updateStatePath: workerData.updateStatePath,
  channel: normalizeUpdateChannel(process.env.RELAY_UPDATE_CHANNEL || config?.updateChannel),
  collectHealth: options => installationHealth.collectInstallationHealth({ ...options, commands }),
});
parentPort.postMessage(encodeCompanionFleetTelemetry(report));
