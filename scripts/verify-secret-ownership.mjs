// Real Linux volume permissions, independent of Docker Desktop's host uid mapping.
import assert from "node:assert/strict";
import { command } from "../runner/broker.mjs";
const namespace = "crewroom-secret-test-" + Date.now(),
  names = ["source", "app", "worker", "runner"].map((n) => namespace + "-" + n),
  image = "crewroom:0.11.0";
const mount = (name, path, ro = false) => [
  "--mount",
  `type=volume,source=${name},target=${path}${ro ? ",readonly" : ""}`,
];
try {
  for (const name of names)
    await command("docker", [
      "volume",
      "create",
      "--label",
      "crewroom.secret-test=" + namespace,
      name,
    ]);
  await command("docker", [
    "run",
    "--rm",
    "--pull=never",
    "--user",
    "0",
    ...mount(names[0], "/source"),
    image,
    "node",
    "-e",
    "const fs=require('fs');for(const key of ['db_url','model_api_key','embedding_api_key','gitlab_token','runner_token']){fs.writeFileSync('/source/'+key,'synthetic-test-secret',{mode:384});fs.chownSync('/source/'+key,1001,1001);}fs.chownSync('/source',1001,1001);fs.chmodSync('/source',448);",
  ]);
  await assert.rejects(
    command("docker", [
      "run",
      "--rm",
      "--pull=never",
      "--user",
      "1000",
      ...mount(names[0], "/source", true),
      image,
      "node",
      "-e",
      "require('fs').readFileSync('/source/db_url')",
    ]),
    (e) => e.stderr.includes("EACCES"),
  );
  const stage = [
    "run",
    "--rm",
    "--pull=never",
    "--user",
    "0",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--cap-add",
    "CHOWN",
    "--cap-add",
    "FOWNER",
    "--cap-add",
    "DAC_OVERRIDE",
    ...mount(names[0], "/run/secrets", true),
    ...mount(names[1], "/out/app"),
    ...mount(names[2], "/out/worker"),
    ...mount(names[3], "/out/runner"),
    image,
    "node",
    "scripts/stage-secrets.mjs",
  ];
  await command("docker", stage);
  await command("docker", stage);
  for (const [index, uid, expected] of [
    [1, "1000", ["db_url"]],
    [
      2,
      "1000",
      [
        "db_url",
        "embedding_api_key",
        "gitlab_token",
        "model_api_key",
        "runner_token",
      ],
    ],
    [3, "0", ["runner_token"]],
  ])
    await command("docker", [
      "run",
      "--rm",
      "--pull=never",
      "--user",
      uid,
      "--cap-drop",
      "ALL",
      ...mount(names[index], "/check", true),
      image,
      "node",
      "-e",
      "const fs=require('fs'),assert=require('assert/strict');assert.deepEqual(fs.readdirSync('/check').sort(),JSON.parse(process.argv[1]).sort());for(const name of fs.readdirSync('/check')){assert.equal(fs.readFileSync('/check/'+name,'utf8'),'synthetic-test-secret');assert.equal(fs.statSync('/check/'+name).mode&511,256);}",
      JSON.stringify(expected),
    ]);
  console.log(
    JSON.stringify({
      sourceUid1001Mode600DeniedToUid1000: true,
      perServiceSecretOwnership: true,
      appHasNoRunnerToken: true,
      restaging: true,
    }),
  );
} finally {
  for (const name of names)
    await command("docker", ["volume", "rm", name]).catch(() => {});
}
