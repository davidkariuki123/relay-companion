# Relay Companion

This is the public, auditable source for the `relay-companion` npm package and Relay desktop runtime.

Relay connects Claude Code, Cowork, and Codex to a shared inbox. The first-contact package has no install lifecycle and, in thin-installer releases, no dependencies. `setup` downloads the exact platform runtime from `api.sendrelays.com`, checks its signed manifest and SHA-512 digest, and only then activates it.

The device credential is stored in macOS Keychain or Windows Credential Manager. `~/.relay/config.json` contains non-secret account and device metadata only. Inbound Relay content is treated as untrusted correspondence and is never executed directly; any agent action remains subject to that host's approvals and sandbox.

Release commits are generated from the shipped Companion source, reviewed here, and published manually from the protected GitHub environment. The package version, runtime artifacts, dependency lock, SBOMs, source commit, and npm provenance are all bound to that release. The complete public source is [davidkariuki123/relay-companion](https://github.com/davidkariuki123/relay-companion).

Start at [sendrelays.com/get-started](https://sendrelays.com/get-started). Never install a version that Relay's Get Started page did not name exactly.

```sh
npx --yes relay-companion@<EXACT_VERSION> setup
```

Setup installs and opens the signed-out Relay pill, registers the local Relay MCP launcher for Claude Code and Codex, and registers the always-on task daemon with macOS launchd or Windows Task Scheduler. New setup never asks the agent for a pairing code.
