import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { mkdir, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
export const LIMITS = {
  archive: 64 * 1024 * 1024,
  file: 8 * 1024 * 1024,
  files: 5000,
  patch: 1024 * 1024,
};
export function safePath(value) {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 1024 ||
    value.includes("\0") ||
    value.includes("\\") ||
    value.startsWith("/") ||
    value.split("/").some(
      (v) =>
        !v ||
        v === ".." ||
        v === "." ||
        v
          .normalize("NFKC")
          .replace(/\p{Cf}/gu, "")
          .toLowerCase()
          .replace(/[. ]+$/, "") === ".git",
    )
  )
    throw new Error("UNSAFE_PATH");
  return value;
}
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function number(buffer) {
  const text = buffer.toString("ascii").replace(/\0.*$/, "").trim();
  if (text && !/^[0-7]+$/.test(text)) throw new Error("INVALID_TAR_NUMBER");
  return parseInt(text || "0", 8);
}
function pax(bytes) {
  const result = {};
  let offset = 0;
  while (offset < bytes.length) {
    const space = bytes.indexOf(32, offset);
    if (space < 0) throw new Error("INVALID_PAX");
    const length = Number(bytes.subarray(offset, space).toString());
    if (
      !Number.isSafeInteger(length) ||
      length < 5 ||
      offset + length > bytes.length
    )
      throw new Error("INVALID_PAX");
    const row = bytes.subarray(space + 1, offset + length - 1).toString("utf8"),
      equal = row.indexOf("=");
    if (equal < 1) throw new Error("INVALID_PAX");
    const key = row.slice(0, equal),
      value = row.slice(equal + 1);
    if (/sparse|linkpath|filetype/i.test(key))
      throw new Error("UNSUPPORTED_ARCHIVE_ENTRY");
    result[key] = value;
    offset += length;
  }
  return result;
}
export function parseArchive(
  input,
  { gzip = false, stripRoot = false, ignore = [], dependencyLink = false } = {},
) {
  const bytes = gzip
    ? gunzipSync(input, { maxOutputLength: LIMITS.archive })
    : input;
  if (bytes.length > LIMITS.archive) throw new Error("ARCHIVE_TOO_LARGE");
  const files = new Map();
  let root = null,
    pending = {},
    longName = null,
    total = 0,
    entries = 0;
  for (let offset = 0; offset + 512 <= bytes.length;) {
    const header = bytes.subarray(offset, offset + 512);
    offset += 512;
    if (header.every((b) => b === 0)) break;
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : header[i];
    if (sum !== number(header.subarray(148, 156)))
      throw new Error("INVALID_TAR_CHECKSUM");
    const size = number(header.subarray(124, 136)),
      mode = number(header.subarray(100, 108));
    if (size > LIMITS.archive || offset + size > bytes.length)
      throw new Error("INVALID_TAR_SIZE");
    const body = bytes.subarray(offset, offset + size);
    offset += Math.ceil(size / 512) * 512;
    const type = String.fromCharCode(header[156] || 48);
    const field = (a, b) =>
      header.subarray(a, b).toString("utf8").replace(/\0.*$/, "");
    let name = field(0, 100),
      prefix = field(345, 500);
    if (prefix) name = prefix + "/" + name;
    if (type === "x") {
      pending = pax(body);
      continue;
    }
    if (type === "g") {
      const global = pax(body);
      if (global.path) throw new Error("UNSUPPORTED_GLOBAL_PATH");
      continue;
    }
    if (type === "L") {
      longName = body.toString("utf8").replace(/\0.*$/, "");
      continue;
    }
    name = pending.path || longName || name;
    pending = {};
    longName = null;
    while (name.startsWith("./")) name = name.slice(2);
    name = name.replace(/\/$/, "");
    if (!name || name === ".") continue;
    if (stripRoot) {
      const parts = name.split("/");
      if (!root) root = parts[0];
      if (parts[0] !== root) throw new Error("ARCHIVE_MULTIPLE_ROOTS");
      if (parts.length === 1) {
        if (type !== "5") throw new Error("ARCHIVE_ROOT_REQUIRED");
        continue;
      }
      name = parts.slice(1).join("/");
    }
    if (++entries > LIMITS.files * 2) throw new Error("TOO_MANY_FILES");
    if (name === ".git" || name.startsWith(".git/")) {
      if (stripRoot) throw new Error("UNSAFE_PATH");
      continue;
    }
    if (
      dependencyLink &&
      name === "node_modules" &&
      type === "2" &&
      field(157, 257) === "/opt/crewroom-deps/node_modules"
    )
      continue;
    safePath(name);
    if (!["0", "5"].includes(type))
      throw new Error("UNSUPPORTED_ARCHIVE_ENTRY");
    if (type === "5") continue;
    if (
      ignore.some((prefix) => name === prefix || name.startsWith(prefix + "/"))
    )
      continue;
    if (
      size > LIMITS.file ||
      (total += size) > LIMITS.archive ||
      files.size >= LIMITS.files
    )
      throw new Error("ARCHIVE_TOO_LARGE");
    if (files.has(name)) throw new Error("DUPLICATE_ARCHIVE_PATH");
    files.set(name, {
      bytes: Buffer.from(body),
      mode: mode & 0o111 ? 0o755 : 0o644,
    });
  }
  if (!files.size) throw new Error("EMPTY_ARCHIVE");
  return files;
}
export async function materialize(files, directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const [path, file] of files) {
    const parts = path.split("/");
    parts.pop();
    if (parts.length)
      await mkdir(join(directory, ...parts), { recursive: true, mode: 0o700 });
    await writeFile(join(directory, path), file.bytes, {
      flag: "wx",
      mode: file.mode,
    });
    await chmod(join(directory, path), file.mode);
  }
}
export function treeHash(files) {
  return hash(
    JSON.stringify(
      [...files]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([path, file]) => ({
          path,
          mode: file.mode,
          hash: hash(file.bytes),
        })),
    ),
  );
}
export { hash };
