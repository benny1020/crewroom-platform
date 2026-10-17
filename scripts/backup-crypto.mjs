import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  createHash,
} from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  writeFile,
  appendFile,
  open,
  stat,
  unlink,
  readFile,
} from "node:fs/promises";
import { pipeline } from "node:stream/promises";
export async function backupKey(path) {
  const value = (await readFile(path, "utf8")).trim();
  if (!/^[a-f\d]{64}$/i.test(value))
    throw new Error(
      "Backup key file must contain 32 random bytes encoded as hex",
    );
  return Buffer.from(value, "hex");
}
export async function fileHash(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
export async function encryptFile(source, target, key) {
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key, iv);
  await writeFile(target, iv, { flag: "wx", mode: 0o600 });
  try {
    await pipeline(
      createReadStream(source),
      cipher,
      createWriteStream(target, { flags: "a" }),
    );
    await appendFile(target, cipher.getAuthTag());
  } catch (error) {
    await unlink(target).catch(() => {});
    throw error;
  }
}
export async function decryptFile(source, target, key) {
  const size = (await stat(source)).size;
  if (size < 28) throw new Error("Invalid encrypted backup");
  const file = await open(source, "r"),
    iv = Buffer.alloc(12),
    tag = Buffer.alloc(16);
  try {
    await file.read(iv, 0, 12, 0);
    await file.read(tag, 0, 16, size - 16);
  } finally {
    await file.close();
  }
  const cipher = createDecipheriv("aes-256-gcm", key, iv);
  cipher.setAuthTag(tag);
  try {
    await pipeline(
      createReadStream(source, { start: 12, end: size - 17 }),
      cipher,
      createWriteStream(target, { flags: "wx", mode: 0o600 }),
    );
  } catch (error) {
    await unlink(target).catch(() => {});
    throw error;
  }
}
