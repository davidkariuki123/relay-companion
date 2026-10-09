#!/usr/bin/env node
// First: started as an Electron app instead of Node, re-run as Node and quit.
import "../bootstrap/electron-as-node.cjs";
// Keep cached host commands valid after retirement. No account or runtime imports.
import retiredHook from "../src/retired-hook.cjs";
try { await retiredHook.drainRetiredHookInput(); } catch {}
