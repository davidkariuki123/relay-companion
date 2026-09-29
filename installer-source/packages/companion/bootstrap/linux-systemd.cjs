"use strict";

// systemd's user manager is normally created before a shell session. Transient
// update/repair jobs therefore do not automatically inherit the paths and
// graphical-session values Relay used during setup. Keep this list narrow and
// deliberately free of credentials: these values are visible in unit metadata.
const LINUX_SYSTEMD_ENV_NAMES = Object.freeze([
  "HOME",
  "PATH",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "RELAY_CONFIG",
  "RELAY_CONFIG_DIR",
  "RELAY_HOME",
  "RELAY_COMPANION_HOME",
  "CLAUDE_HOME",
  "CODEX_HOME",
  "CLAUDE_CLI_PATH",
  "CODEX_CLI_PATH",
  "RELAY_TERMINAL",
  "TERMINAL",
  "RELAY_ALLOW_SANDBOX_AUTHORIZATION",
  "CHROME_DEVEL_SANDBOX",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "SSH_AUTH_SOCK",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XAUTHORITY",
  "DBUS_SESSION_BUS_ADDRESS",
  "XDG_CURRENT_DESKTOP",
  "XDG_SESSION_TYPE",
  "XDG_RUNTIME_DIR",
]);

const LINUX_GRAPHICAL_ENV_NAMES = Object.freeze([
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XAUTHORITY",
  "DBUS_SESSION_BUS_ADDRESS",
  "XDG_CURRENT_DESKTOP",
  "XDG_SESSION_TYPE",
  "XDG_RUNTIME_DIR",
  "SSH_AUTH_SOCK",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
]);

function cleanEnvironmentEntries(names, env = process.env) {
  const entries = [];
  for (const name of names) {
    const value = env?.[name];
    if (value == null || value === "") continue;
    const text = String(value);
    if (/\0|\r|\n/.test(text)) continue;
    entries.push([name, text]);
  }
  return entries;
}

function systemdRunEnvironmentArgs(env = process.env) {
  return cleanEnvironmentEntries(LINUX_SYSTEMD_ENV_NAMES, env)
    .map(([name, value]) => `--setenv=${name}=${value}`);
}

function systemdImportEnvironmentArgs(env = process.env) {
  const names = cleanEnvironmentEntries(LINUX_GRAPHICAL_ENV_NAMES, env).map(([name]) => name);
  return names.length ? ["--user", "import-environment", ...names] : [];
}

module.exports = {
  LINUX_GRAPHICAL_ENV_NAMES,
  LINUX_SYSTEMD_ENV_NAMES,
  cleanEnvironmentEntries,
  systemdImportEnvironmentArgs,
  systemdRunEnvironmentArgs,
};
