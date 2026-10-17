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
  "docs/diagrams/README.md",
  "docs/diagrams/DESIGN_NOTES.md",
];
let links = 0;
for (const file of files) {
  const text = await readFile(file, "utf8");
  if (/^```mermaid\s*$/m.test(text))
    throw new Error(`Use a rendered diagram image in ${file}`);
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
  "docs/media/memory",
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
const diagramDirectory = "docs/diagrams",
  diagramManifest = JSON.parse(
    await readFile(diagramDirectory + "/manifest.json", "utf8"),
  ),
  diagrams = diagramManifest.diagrams,
  definitions = JSON.parse(
    await readFile(diagramDirectory + "/diagrams.json", "utf8"),
  );
if (diagrams.length !== definitions.length)
  throw new Error("Diagram manifest does not match the source list");
for (const receipt of diagramManifest.renderSources) {
  if (
    createHash("sha256")
      .update(await readFile(receipt.file))
      .digest("hex") !== receipt.sha256
  )
    throw new Error(
      "Diagram renderer changed; regenerate images: " + receipt.file,
    );
}
for (const diagram of diagrams) {
  const definition = definitions.find((entry) => entry.id === diagram.id);
  if (
    !definition ||
    Object.entries(definition).some(([key, value]) => diagram[key] !== value)
  )
    throw new Error(
      "Diagram definition changed; regenerate images: " + diagram.id,
    );
  const source = await readFile(diagramDirectory + "/" + diagram.source);
  if (createHash("sha256").update(source).digest("hex") !== diagram.sourceHash)
    throw new Error("Diagram needs regeneration: " + diagram.id);
  for (const format of ["png", "svg"]) {
    const receipt = diagram[format],
      data = await readFile(diagramDirectory + "/" + receipt.file);
    if (
      data.length !== receipt.bytes ||
      createHash("sha256").update(data).digest("hex") !== receipt.sha256
    )
      throw new Error("Diagram image mismatch: " + receipt.file);
    if (
      format === "png" &&
      data.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a"
    )
      throw new Error("Invalid diagram PNG: " + receipt.file);
  }
}
console.log(
  `Document links: ${links}; captured media: ${media}; rendered diagrams: ${diagrams.length}; image/source hashes verified.`,
);
