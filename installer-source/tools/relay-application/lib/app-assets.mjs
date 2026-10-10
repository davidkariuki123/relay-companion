// The setup window borrows two things from the Companion so the two surfaces
// read as one: the "Five ways to use Relay" card module and the bundled
// fonts. They are copied from the source tree at preparation time (and by the
// local UI tests), never from the extracted runtime, so a candidate built from
// a commit always shows that commit's five ways.
//
// The app icon it shows is the application's own (lib/relay-app-icon.svg, the
// drawing relay.icns is rendered from), not the Companion's relayAppIcon.svg:
// the window installing Relay shows the icon Relay has in Finder and the Dock.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const overlay = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/companion/overlay");
export const APPLICATION_ICON = path.join(path.dirname(fileURLToPath(import.meta.url)), "relay-app-icon.svg");
export const COMPANION_APP_ASSETS = Object.freeze([
  { from: "relay-anyone-tip.cjs", to: "five-ways.js" },
  { from: "fonts/newsreader-var.woff2", to: "fonts/newsreader-var.woff2" },
  { from: "fonts/plexmono-400.woff2", to: "fonts/plexmono-400.woff2" },
  { from: "fonts/plexmono-500.woff2", to: "fonts/plexmono-500.woff2" },
  { from: "fonts/inter-var.woff2", to: "fonts/inter-var.woff2" },
]);

export function copyCompanionAppAssets(appDir) {
  for (const { from, to } of COMPANION_APP_ASSETS) {
    const destination = path.join(appDir, to);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(overlay, from), destination);
  }
  fs.copyFileSync(APPLICATION_ICON, path.join(appDir, "relayAppIcon.svg"));
  const source = fs.readFileSync(path.join(overlay, "inbox.html"), "utf8");
  const styles = [...source.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(match => match[1]).join("\n");
  fs.writeFileSync(path.join(appDir, "installed-tokens.css"), styles);
  const lockup = source.match(/<div class="lockup" id="lockup">[\s\S]*?<\/div>/)?.[0];
  const definitions = source.slice(source.indexOf("<body")).match(/<svg[^>]*>[\s\S]*?<defs>[\s\S]*?<\/defs>[\s\S]*?<\/svg>/)?.[0] || "";
  if (!lockup) throw new Error("Relay brand header is missing");
  fs.writeFileSync(path.join(appDir, "native-install.html"), `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'"><link rel="stylesheet" href="installed-tokens.css"><link rel="stylesheet" href="native-install.css"><title>Install Relay</title></head><body>${definitions}<div class="sheet">${lockup}<main></main></div><script src="native-install.js"></script></body></html>`);
  fs.writeFileSync(path.join(appDir, "native-bootstrap.html"), fs.readFileSync(path.join(appDir,"native-install.html"),"utf8").replace('src="native-install.js"','src="native-bootstrap.js"'));
  return ["relayAppIcon.svg", ...COMPANION_APP_ASSETS.map((asset) => asset.to), "installed-tokens.css", "native-install.html", "native-bootstrap.html"];
}
