# Connect the installed Relay app

Relay is already installed. Do not download or reinstall it. This local setup supports Claude Code and Codex with command access on the same computer.

The person pasted a request containing the installed helper path and current run id. Use that helper with the installed Node runtime or an available compatible Node, preserving quoted paths. Read and explain the scope before changing integrations: Relay connects through the person's browser, runs in the background, maintains its managed skill, and registers local tools for future conversations. Preserve their other tools and any modified skill files. A host permission denial stops the affected operation; report it plainly.

1. Call `node <helper> onboarding start --run <run> --guide-version 1 --host codex` (use `claude_code` for Claude Code). This opens the account connection in the person's browser. Never handle their password.
2. Read `onboarding status --run <run>` with backoff, no faster than every two seconds and stop after two minutes with a clear resumable update. The person must explicitly approve Connect Relay. Copying this prompt does not approve an account.
3. When state is `verifying`, call `onboarding ready --run <run>`. This makes a live authenticated account check. Do not claim success until state is `teaching`.
4. Read the installed Relay managed skill and follow its first-Relay tutorial. Ask what the person wants to share; creating an account does not authorize sending. Use the actual Relay tools. The application observes confirmed sends and minted links itself.

If the run is cancelled, expired or belongs to a different account, report the returned state and ask the person to restart from Relay. Never edit setup state or credentials to advance it. If local files are unavailable, explain that this prompt must be used on the computer where Relay is installed.
