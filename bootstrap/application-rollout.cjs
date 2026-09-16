"use strict";
// Capability only. Every background handoff additionally requires a fresh,
// signed channel-specific policy. An empty device list migrates nobody.
module.exports = Object.freeze({ enabled: true,
  manifestUrl: "https://api.sendrelays.com/v1/application-releases/stable/manifest.json" });
