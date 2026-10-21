import test from "node:test";
import assert from "node:assert/strict";
import { characterById } from "../src/data.js";
import {
  diaryState,
  diaryIllustration,
  workDiary,
  developerDiaryEnabled,
} from "../src/work-diary.js";

test("plush skin retains old saved avatar choices and server role presets", () => {
  for (const [old, current] of [
    ["owl", "cloud"],
    ["red-panda", "fennec"],
    ["cat", "otter"],
    ["chief", "cloud"],
    ["dev", "otter"],
    ["qa", "penguin"],
  ])
    assert.equal(characterById(old).id, current);
  assert.equal(characterById("rabbit").id, "rabbit");
  assert.equal(characterById("unknown", "otter").id, "otter");
  assert.equal(characterById().id, "fox");
  for (const character of [undefined, "dev", "cat", "otter"])
    assert.equal(developerDiaryEnabled({ id: "dev", character }), true);
  for (const character of ["rabbit", "fox", "turtle"])
    assert.equal(developerDiaryEnabled({ id: "dev", character }), false);
  const customized = workDiary({
    agent: { id: "dev", name: "카이", character: "rabbit" },
    portrait: '<span data-character="rabbit"></span>',
  });
  assert.ok(customized.includes("카이의 개발 일지"));
  assert.ok(customized.includes('data-character="rabbit"'));
  assert.ok(!customized.includes("g-diary-illustration"));
});

test("diary preserves queued, stopped, failed and awaiting-human states regardless of old progress", () => {
  const phases = {
    queued: "queued",
    paused: "paused",
    failed: "blocked",
    cancelled: "blocked",
    needs_input: "question",
    result_ready: "review",
    done: "celebrating",
  };
  for (const [status, phase] of Object.entries(phases))
    assert.equal(
      diaryState({
        task: { status },
        run: { progress: { action: "run_check" } },
      }).phase,
      phase,
    );
  assert.equal(diaryState().phase, "ready");
  assert.equal(diaryState({ task: { status: "running" } }).phase, "planning");
  assert.equal(diaryState({ task: { status: "unknown" } }).phase, "ready");
});

test("only the currently running Run can select a tool scene; running tests never imply passed", () => {
  const task = {
    status: "running",
    current_run_id: "current",
    work_type: "chat",
  };
  const run = {
    id: "current",
    status: "running",
    progress: { action: "run_check" },
  };
  assert.equal(diaryState({ task, run }).phase, "testing");
  assert.ok(diaryState({ task, run }).detail.includes("아직"));
  for (const stale of [
    { ...run, id: "old" },
    { ...run, status: "failed" },
  ])
    assert.equal(diaryState({ task, run: stale }).phase, "planning");
  for (const [action, phase] of [
    ["write_file", "coding"],
    ["read_workspace", "investigating"],
    ["write_workspace", "writing"],
  ])
    assert.equal(
      diaryState({ task, run: { ...run, progress: { action } } }).phase,
      phase,
    );
});

test("test success requires the current native artifact and successful stopped checks; summary claims and imports are insufficient", () => {
  const task = {
    status: "result_ready",
    target_version: "v2",
    step_index: 0,
    steps: [{ current_artifact_id: "current" }],
  };
  const artifact = {
    id: "current",
    target_version: "v2",
    origin: "model",
    result: {
      summary: "테스트 통과!",
      execution: {
        passed: true,
        stopped: true,
        checks: [{ passed: true, exitCode: 0 }],
      },
    },
  };
  assert.equal(
    diaryState({ task, artifact }).label,
    "등록한 검사를 통과했어요",
  );
  assert.ok(diaryState({ task, artifact }).detail.includes("수용은 아직"));
  for (const unverified of [
    { ...artifact, origin: "external" },
    { ...artifact, id: "previous" },
    { ...artifact, target_version: "v1" },
    { ...artifact, result: { summary: "테스트 통과!" } },
    ...[
      { passed: true, stopped: false, checks: [{ passed: true, exitCode: 0 }] },
      { passed: true, stopped: true, checks: [] },
      { passed: true, stopped: true, checks: [{ passed: false, exitCode: 1 }] },
    ].map((execution) => ({ ...artifact, result: { execution } })),
  ])
    assert.equal(diaryState({ task, artifact: unverified }).phase, "review");
});

test("diary escapes saved names and task titles; unknown sprite phases cannot become markup", () => {
  const html = workDiary({
    agent: { id: "dev", name: '<img src=x onerror="bad">' },
    task: { status: "queued", title: "<script>bad</script>" },
  });
  assert.ok(!html.includes("<img"));
  assert.ok(!html.includes("<script>"));
  assert.ok(html.includes("&lt;script&gt;"));
  for (const phase of ["constructor", "__proto__", 'x" onclick="bad'])
    assert.ok(diaryIllustration(phase).includes('data-diary-scene="ready"'));
});
