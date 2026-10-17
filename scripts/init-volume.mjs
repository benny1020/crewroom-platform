import { mkdir, chown, chmod } from "node:fs/promises";
const directory = process.env.DATA_DIR || "/data";
await mkdir(directory, { recursive: true, mode: 0o700 });
await chown(directory, 1000, 1000);
await chmod(directory, 0o700);
