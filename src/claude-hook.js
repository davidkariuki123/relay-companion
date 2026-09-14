import retiredHook from "./retired-hook.cjs";

// Compatibility only: no lifecycle event may inject correspondence or wake a turn.
export async function runClaudeHook({ input = process.stdin } = {}) {
  await retiredHook.drainRetiredHookInput(input);
}
