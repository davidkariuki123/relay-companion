// The bundle identifier is part of Relay's durable macOS identity. Keep it in
// one dependency-free module so the runtime builder, verifier, and overlay all
// agree on the NSUserDefaults suite that owns menu-bar placement.

const RELAY_MAC_BUNDLE_IDENTIFIER = "work.relay.companion.pill";
const RELAY_LEGACY_MAC_BUNDLE_IDENTIFIER = "com.github.Electron";

module.exports = {
  RELAY_LEGACY_MAC_BUNDLE_IDENTIFIER,
  RELAY_MAC_BUNDLE_IDENTIFIER,
};
