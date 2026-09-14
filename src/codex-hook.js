import retiredHook from "./retired-hook.cjs";

// Compatibility only: no lifecycle event may inject correspondence or wake a turn.
export async function runCodexHook({ input = process.stdin } = {}) {
  await retiredHook.drainRetiredHookInput(input);
}
