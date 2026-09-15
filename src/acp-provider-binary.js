// Resolve the same native binary the pinned ACP adapter uses. Sign-in remains
// provider-owned, without requiring a separately installed command on PATH.
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
const require = createRequire(import.meta.url);
export function acpProviderBinary(provider) {
  if (provider === "claude" || provider === "claude_code") {
    const adapter = createRequire(require.resolve("@agentclientprotocol/claude-agent-acp/dist/index.js"));
    const sdk = createRequire(adapter.resolve("@anthropic-ai/claude-agent-sdk"));
    const musl = process.platform === "linux" && !process.report?.getReport()?.header?.glibcVersionRuntime;
    return sdk.resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}${musl ? "-musl" : ""}/claude${process.platform === "win32" ? ".exe" : ""}`);
  }
  if (provider !== "codex") throw new Error(`Unsupported ACP provider: ${provider}`);
  const adapter = createRequire(require.resolve("@agentclientprotocol/codex-acp/dist/index.js"));
  const codex = createRequire(adapter.resolve("@openai/codex/package.json"));
  const root = path.dirname(codex.resolve(`@openai/codex-${process.platform}-${process.arch}/package.json`));
  const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
  const os = { linux: "unknown-linux-musl", darwin: "apple-darwin", win32: "pc-windows-msvc" }[process.platform];
  const binary = path.join(root, "vendor", `${arch}-${os}`, "bin", process.platform === "win32" ? "codex.exe" : "codex");
  if (!fs.existsSync(binary)) throw new Error("The bundled Codex ACP binary is missing");
  return binary;
}
