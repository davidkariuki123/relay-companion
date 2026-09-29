"use strict";
const { parentPort } = require("node:worker_threads");
const { collectInstallationHealth, describeInstallationHealth } = require("./installation-health.cjs");
const installation = collectInstallationHealth();
parentPort.postMessage({ ...installation.health, message: describeInstallationHealth(installation) });
