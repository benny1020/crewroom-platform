import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import {
  configuration,
  modelProfile,
  sourceProfile,
  modelAuthentication,
} from "../server/config.js";
import { runModel } from "../server/provider.js";
import { collectInput } from "../server/inputs.js";
const result = {
  summary: "계약 테스트 응답",
  evidence: ["고정 입력"],
  unknowns: ["실제 추론 검증 아님"],
  nextActions: ["사람 확인"],
};
const fullHead = "b".repeat(40),
  fullBase = "a".repeat(40);
const gitConfig = (extra = {}) => ({
  ...configuration({}),
  gitlabBase: "https://git.internal.invalid/gitlab",
  gitlabProjects: ["team/subgroup/app"],
  gitlabSharedProjects: [],
  githubEnabled: false,
  ...extra,
});
const gitSnapshot = (config, extra = {}) => ({
  target:
    "https://git.internal.invalid/gitlab/team/subgroup/app/-/merge_requests/23",
  targetVersion: fullHead.slice(0, 10),
  goal: "MR 검토",
  visibility: "private",
  sourceProfile: sourceProfile(config),
  ...extra,
});
function secret(t, name, value) {
  const old = process.env[name],
    oldFile = process.env[name + "_FILE"];
  process.env[name] = value;
  delete process.env[name + "_FILE"];
  t.after(() => {
    if (old === undefined) delete process.env[name];
    else process.env[name] = old;
    if (oldFile === undefined) delete process.env[name + "_FILE"];
    else process.env[name + "_FILE"] = oldFile;
  });
}
function snapshot(config) {
  return {
    providerProfile: modelProfile(config),
    model: config.model,
    agent: { name: "노아", instructions: "검토", runtime: "readonly" },
    skill: { instructions: "근거 작성", done: "사람 확인" },
    goal: "검토",
    memories: [],
  };
}
async function stub(t, handler) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}
function gitFetch({ metadata = {}, comparison = {} } = {}) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return Response.json(
        calls.length === 1
          ? {
              title: "MR",
              description: "근거",
              sha: fullHead,
              diff_refs: { base_sha: fullBase, head_sha: fullHead },
              changes_count: "1",
              ...metadata,
            }
          : {
              diffs: [
                { old_path: "a.js", new_path: "a.js", diff: "@@\n-old\n+new" },
              ],
              ...comparison,
            },
      );
    },
  };
}

test("Claude Messages uses a configurable custom endpoint, auth and native response contract", async (t) => {
  secret(t, "MODEL_API_KEY", "test-only-endpoint-key");
  let received;
  const base = await stub(t, async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    received = { url: req.url, headers: req.headers, body: JSON.parse(body) };
    res.setHeader("request-id", "endpoint-fixture-request");
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        content: [{ type: "text", text: JSON.stringify(result) }],
        stop_reason: "end_turn",
        usage: { input_tokens: 21, output_tokens: 13 },
      }),
    );
  });
  const config = configuration({
    MODEL_PROVIDER: "anthropic",
    MODEL_ENDPOINT_URL: base + "/proxy/claude/messages",
    MODEL_NAME: "custom-model",
    MODEL_AUTH_HEADER: "x-endpoint-token",
    MODEL_AUTH_SCHEME: "raw",
  });
  let dispatched = 0;
  const output = await runModel(snapshot(config), config, {
    dispatch: (send) => {
      dispatched++;
      return send();
    },
  });
  assert.equal(dispatched, 1);
  assert.equal(received.url, "/proxy/claude/messages");
  assert.equal(received.headers["x-endpoint-token"], "test-only-endpoint-key");
  assert.equal(received.headers["anthropic-version"], "2023-06-01");
  assert.equal(received.headers.authorization, undefined);
  assert.equal(received.body.messages[0].role, "user");
  assert.ok(received.body.system.includes("노아"));
  assert.equal(received.body.tools, undefined);
  assert.equal(received.body.response_format, undefined);
  assert.deepEqual(output.result, result);
  assert.equal(output.receipt.requestId, "endpoint-fixture-request");
  assert.deepEqual(output.receipt.usage, {
    promptTokens: 21,
    completionTokens: 13,
  });
});
test("provider route or auth changes reject pinned requests before any outbound call", async () => {
  const config = configuration({
    MODEL_PROVIDER: "anthropic",
    MODEL_BASE_URL: "https://internal.invalid/v1",
    MODEL_NAME: "claude",
  });
  let calls = 0;
  for (const next of [
    { ...config, modelEndpoint: "https://different.invalid/messages" },
    { ...config, modelAuthScheme: "bearer" },
  ])
    await assert.rejects(
      () =>
        runModel(snapshot(config), next, {
          fetchImpl: () => {
            calls++;
          },
        }),
      { code: "PROVIDER_PROFILE_CHANGED" },
    );
  assert.equal(calls, 0);
  assert.deepEqual(modelAuthentication(config), {
    header: "x-api-key",
    prefix: "",
  });
  assert.throws(() =>
    modelAuthentication({ ...config, modelAuthHeader: "Host" }),
  );
});
test("Claude unexpected tool use and truncated output are explicit failures", async (t) => {
  secret(t, "MODEL_API_KEY", "");
  const config = configuration({
    MODEL_PROVIDER: "anthropic",
    MODEL_BASE_URL: "https://internal.invalid/v1",
    MODEL_NAME: "claude",
  });
  for (const [body, code] of [
    [
      { content: [{ type: "tool_use", name: "terminal" }] },
      "UNEXPECTED_TOOL_CALL",
    ],
    [
      {
        content: [{ type: "text", text: JSON.stringify(result) }],
        stop_reason: "max_tokens",
      },
      "MODEL_OUTPUT_TRUNCATED",
    ],
  ])
    await assert.rejects(
      () =>
        runModel(snapshot(config), config, {
          fetchImpl: async () => Response.json(body),
        }),
      { code },
    );
});
test("self-managed GitLab supports a subpath, subgroup, private token and immutable SHA compare", async (t) => {
  secret(t, "GITLAB_TOKEN", "test-only-gitlab-key");
  const config = gitConfig(),
    mock = gitFetch(),
    output = await collectInput(gitSnapshot(config), { config, ...mock });
  assert.equal(mock.calls.length, 2);
  assert.equal(
    mock.calls[0].url,
    "https://git.internal.invalid/gitlab/api/v4/projects/team%2Fsubgroup%2Fapp/merge_requests/23",
  );
  assert.equal(
    mock.calls[0].options.headers["PRIVATE-TOKEN"],
    "test-only-gitlab-key",
  );
  assert.equal(mock.calls[0].options.redirect, "error");
  const compare = new URL(mock.calls[1].url);
  assert.equal(compare.searchParams.get("from"), fullBase);
  assert.equal(compare.searchParams.get("to"), fullHead);
  assert.equal(compare.searchParams.get("straight"), "true");
  assert.equal(output.kind, "gitlab-immutable-diff");
  assert.equal(output.project, "team/subgroup/app");
  assert.ok(output.text.includes("+new"));
  assert.equal(output.hash.length, 64);
});
test("unregistered host/project and non-approved sharing produce zero GitLab requests", async (t) => {
  secret(t, "GITLAB_TOKEN", "test-only-key");
  const config = gitConfig();
  for (const [extra, code] of [
    [
      {
        target:
          "https://evil.invalid/gitlab/team/subgroup/app/-/merge_requests/23",
      },
      "GITLAB_TARGET_DENIED",
    ],
    [
      {
        target:
          "https://git.internal.invalid/gitlab/team/other/-/merge_requests/23",
      },
      "GITLAB_PROJECT_DENIED",
    ],
    [{ visibility: "team" }, "GITLAB_SHARING_DENIED"],
    [{ visibility: "department" }, "GITLAB_SHARING_DENIED"],
  ]) {
    const mock = gitFetch();
    await assert.rejects(
      () => collectInput(gitSnapshot(config, extra), { config, ...mock }),
      { code },
    );
    assert.equal(mock.calls.length, 0);
  }
  const shared = gitConfig({ gitlabSharedProjects: ["team/subgroup/app"] }),
    mock = gitFetch();
  await collectInput(gitSnapshot(shared, { visibility: "team" }), {
    config: shared,
    ...mock,
  });
  assert.equal(mock.calls.length, 2);
});
test("moved MR head and incomplete GitLab diff cannot become complete review inputs", async (t) => {
  secret(t, "GITLAB_TOKEN", "test-only-key");
  const config = gitConfig(),
    moved = gitFetch({ metadata: { sha: "c".repeat(40) } });
  await assert.rejects(
    () => collectInput(gitSnapshot(config), { config, ...moved }),
    { code: "TARGET_MOVED" },
  );
  assert.equal(moved.calls.length, 1);
  for (const options of [
    { comparison: { compare_timeout: true } },
    { comparison: { diffs: [{ collapsed: true }] } },
    { comparison: { diffs: [{ too_large: true }] } },
    { metadata: { changes_count: "1000+" } },
    { metadata: { changes_count: "2" } },
  ])
    await assert.rejects(
      () => collectInput(gitSnapshot(config), { config, ...gitFetch(options) }),
      { code: "DIFF_INCOMPLETE" },
    );
});
test("GitLab profile changes and missing legacy profile cannot fetch using new credentials", async () => {
  const config = gitConfig(),
    mock = gitFetch();
  await assert.rejects(
    () =>
      collectInput(gitSnapshot(config), {
        config: { ...config, gitlabBase: "https://new.invalid" },
        ...mock,
      }),
    { code: "SCM_PROFILE_CHANGED" },
  );
  await assert.rejects(
    () =>
      collectInput(gitSnapshot(config, { sourceProfile: undefined }), {
        config,
        ...mock,
      }),
    { code: "SCM_PROFILE_MISSING" },
  );
  assert.equal(mock.calls.length, 0);
});
test("deployment configuration can disable public GitHub without silently treating a PR as manual input", async () => {
  const config = gitConfig(),
    mock = gitFetch();
  await assert.rejects(
    () =>
      collectInput(
        {
          target: "https://github.com/team/project/pull/1",
          targetVersion: fullHead,
          goal: "검토",
        },
        { config, ...mock },
      ),
    { code: "GITHUB_DISABLED" },
  );
  assert.equal(mock.calls.length, 0);
});

test("GitLab preserves mode changes, renames and empty file creation/deletion; unexplained empty diffs fail", async (t) => {
  secret(t, "GITLAB_TOKEN", "test-only-key");
  const config = gitConfig();
  for (const metadata of [
    { a_mode: "100644", b_mode: "100755" },
    { new_file: true },
    { deleted_file: true },
    { renamed_file: true, new_path: "renamed.js" },
  ]) {
    const mock = gitFetch({
      comparison: {
        diffs: [{ old_path: "a.js", new_path: "a.js", diff: "", ...metadata }],
      },
    });
    const output = await collectInput(gitSnapshot(config), { config, ...mock });
    assert.ok(output.text.includes("METADATA:"));
    for (const [key, value] of Object.entries(metadata))
      assert.ok(
        output.text.includes(JSON.stringify(key) + ":" + JSON.stringify(value)),
      );
    assert.ok(output.text.includes("only the metadata above is available"));
  }
  await assert.rejects(
    () =>
      collectInput(gitSnapshot(config), {
        config,
        ...gitFetch({
          comparison: {
            diffs: [
              {
                old_path: "a.js",
                new_path: "a.js",
                a_mode: "100644",
                b_mode: "100644",
                diff: "",
              },
            ],
          },
        }),
      }),
    { code: "DIFF_INCOMPLETE" },
  );
});
