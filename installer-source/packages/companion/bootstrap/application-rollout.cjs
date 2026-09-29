"use strict";
// Capability only. Every background handoff additionally requires a fresh,
// signed channel-specific policy. An empty device list migrates nobody.
module.exports = Object.freeze({ enabled: true,
  manifestUrl: require("./application-release.cjs").applicationManifestUrl("stable") });
