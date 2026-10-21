// Capture only an explicitly selected isolated test database; never the live App.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
if (!process.env.TEST_DATABASE_URL)
  throw Error(
    "TEST_DATABASE_URL is required for an isolated workspace capture",
  );
const encoder = process.env.FFMPEG_BIN || "ffmpeg",
  directory = "docs/media/workspace";
async function run(command, args, env = process.env) {
  const child = spawn(command, args, { stdio: "inherit", env });
  if ((await once(child, "close"))[0] !== 0)
    throw Error("Workspace capture command failed: " + command);
}
await run(encoder, ["-version"]);
await mkdir(directory, { recursive: true });
await run("npm", ["run", "build"]);
await run(
  "npx",
  [
    "playwright",
    "test",
    "--config",
    "playwright.server.config.js",
    "tests/server-e2e/agent-workspace.spec.js",
  ],
  { ...process.env, CAPTURE_WORKSPACE: "1" },
);
await run(encoder, [
  "-y",
  "-loop",
  "1",
  "-t",
  "2",
  "-i",
  `${directory}/agent-home.png`,
  "-loop",
  "1",
  "-t",
  "2",
  "-i",
  `${directory}/document.png`,
  "-loop",
  "1",
  "-t",
  "2",
  "-i",
  `${directory}/workroom.png`,
  "-filter_complex",
  "[0:v][1:v][2:v]concat=n=3:v=1:a=0,scale=1000:-1:flags=lanczos,fps=4,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse",
  "-loop",
  "0",
  `${directory}/workflow.gif`,
]);
const hash = (data) => createHash("sha256").update(data).digest("hex");
const files = await Promise.all(
  [
    "office.png",
    "agent-home.png",
    "document.png",
    "workroom.png",
    "workflow.gif",
  ].map(async (name) => {
    const b = await readFile(`${directory}/${name}`);
    return { name, bytes: b.length, sha256: hash(b) };
  }),
);
await writeFile(
  `${directory}/manifest.json`,
  JSON.stringify(
    {
      release: JSON.parse(
        await readFile(new URL("../package.json", import.meta.url), "utf8"),
      ).version,
      capturedAt: new Date().toISOString(),
      mode: "isolated PostgreSQL fixture; three-screen walkthrough; no live AI calls",
      viewport: { width: 1440, height: 1080 },
      pageErrors: [],
      files,
    },
    null,
    2,
  ) + "\n",
);
