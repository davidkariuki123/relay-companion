import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export async function treeDigest(root) {
  const hash = crypto.createHash("sha256");
  async function visit(relative) {
    const file = path.join(root, relative);
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) {
      const target = fs.readlinkSync(file);
      const resolved = path.resolve(path.dirname(file), target);
      if (!resolved.startsWith(`${path.resolve(root)}${path.sep}`)) throw new Error("Candidate link escapes its input tree");
      hash.update(JSON.stringify([relative.replaceAll(path.sep, "/"), "link", target]));
    } else if (stat.isDirectory()) {
      hash.update(JSON.stringify([relative.replaceAll(path.sep, "/"), "directory"]));
      for (const name of fs.readdirSync(file).sort()) await visit(path.join(relative, name));
    } else if (stat.isFile()) {
      const digest = crypto.createHash("sha256");
      for await (const chunk of fs.createReadStream(file)) digest.update(chunk);
      hash.update(JSON.stringify([relative.replaceAll(path.sep, "/"), "file", stat.size, digest.digest("hex")]));
    } else throw new Error("Candidate contains an unsupported filesystem entry");
  }
  await visit("");
  return hash.digest("hex");
}
