#!/usr/bin/env node

import fs from "node:fs";
import { createGzip, constants } from "node:zlib";
import { pipeline } from "node:stream/promises";

const input = process.argv[2];
const output = process.argv[3];
if (!input || !output) throw new Error("deterministic-gzip requires input and output paths");

// Node writes a zero gzip MTIME; explicit level/strategy keep the compressed
// bytes stable across reruns on the same supported runtime/toolchain.
await pipeline(
  fs.createReadStream(input),
  createGzip({ level: 9, strategy: constants.Z_DEFAULT_STRATEGY, mtime: 0 }),
  fs.createWriteStream(output, { flags: "wx", mode: 0o600 }),
);
