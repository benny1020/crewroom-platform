import test from "node:test";
import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import { parseArchive, safePath } from "../runner/archive.mjs";
import { tarFiles } from "../runner/broker.mjs";
const file = { bytes: Buffer.from("safe"), mode: 420 };
function changed(mutator) {
  const bytes = gunzipSync(tarFiles(new Map([["a.txt", file]])));
  mutator(bytes);
  bytes.fill(32, 148, 156);
  let sum = 0;
  for (const b of bytes.subarray(0, 512)) sum += b;
  bytes.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  return bytes;
}
test("archive rejects traversal, links, special files, duplicate entries and corruption", () => {
  for (const path of [
    "../x",
    "a/../x",
    "/etc/passwd",
    "a\\b",
    ".git/config",
    ".GIT/config",
    ".gi\u200ct/config",
    "a//b",
  ])
    assert.throws(() => safePath(path), /UNSAFE_PATH/);
  for (const type of [49, 50, 51, 54])
    assert.throws(
      () =>
        parseArchive(
          changed((b) => (b[156] = type)),
          { stripRoot: true },
        ),
      /UNSUPPORTED_ARCHIVE_ENTRY/,
    );
  assert.throws(
    () =>
      parseArchive(
        changed((b) => {
          b.fill(0, 0, 100);
          b.write("source/../escape");
        }),
        { stripRoot: true },
      ),
    /UNSAFE_PATH/,
  );
  const one = gunzipSync(tarFiles(new Map([["a.txt", file]])));
  assert.throws(
    () =>
      parseArchive(Buffer.concat([one.subarray(0, 1024), one]), {
        stripRoot: true,
      }),
    /DUPLICATE/,
  );
  one[100] ^= 1;
  assert.throws(() => parseArchive(one), /CHECKSUM/);
});
test("canonical source archive roundtrips long Unicode project paths without losing content", () => {
  const path = "src/" + "긴패키지이름/".repeat(15) + "테스트.js",
    files = new Map([[path, file]]);
  assert.equal(
    parseArchive(tarFiles(files), { gzip: true, stripRoot: true })
      .get(path)
      .bytes.toString(),
    "safe",
  );
});
