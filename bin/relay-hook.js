#!/usr/bin/env node
// Keep cached host commands valid after retirement. No account or runtime imports.
import retiredHook from "../src/retired-hook.cjs";
try { await retiredHook.drainRetiredHookInput(); } catch {}
