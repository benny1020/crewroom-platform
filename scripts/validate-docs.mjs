import { readdir, readFile, access } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { createHash } from "node:crypto";

const files = [
  "README.md",
  "THIRD_PARTY_NOTICES.md",
  ...(await readdir("docs"))
    .filter((name) => name.endsWith(".md"))
    .map((name) => "docs/" + name),
  "docs/research/2026-10-16-code-audit/README.md",
];
let links = 0;
for (const file of files) {
  const text = await readFile(file, "utf8");
  for (const [, value] of text.matchAll(/\]\(([^)]+)\)/g)) {
    if (value.includes("://") || value.startsWith("mailto:")) continue;
    const target = value.split("#")[0];
    if (!target) continue;
    await access(resolve(dirname(file), target));
    links++;
  }
}
let media = 0;
for (const directory of [
  "docs/media",
  "docs/media/server",
  "docs/media/execution",
]) {
  const manifest = JSON.parse(
    await readFile(directory + "/manifest.json", "utf8"),
  );
  for (const file of manifest.files) {
    const data = await readFile(directory + "/" + file.name);
    if (
      data.length !== file.bytes ||
      createHash("sha256").update(data).digest("hex") !== file.sha256
    )
      throw new Error("Media mismatch: " + file.name);
    if (
      file.name.endsWith(".gif") &&
      !["GIF89a", "GIF87a"].includes(data.subarray(0, 6).toString())
    )
      throw new Error("Invalid GIF: " + file.name);
  }
  if (manifest.pageErrors.length)
    throw new Error("Capture contains page errors");
  media += manifest.files.length;
}
console.log(
  `Document links: ${links}; captured media: ${media}; hashes and GIF signatures verified.`,
);
