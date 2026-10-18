import test from "node:test";
import assert from "node:assert/strict";
import {
  agentTask,
  officeStation,
  stationMode,
} from "../src/office-station.js";
test("agent activity uses immutable IDs and prioritizes active work over newer completed work", () => {
  const tasks = [
    {
      agent_id: "review",
      agent_name: "renamed",
      status: "running",
      updated_at: "2026-10-01",
    },
    {
      agent_id: "qa",
      agent_name: "renamed",
      status: "failed",
      updated_at: "2026-10-18",
    },
    { agent_id: "review", status: "done", updated_at: "2026-10-18" },
  ];
  assert.equal(agentTask(tasks, "review"), tasks[0]);
  assert.equal(agentTask(tasks, "qa"), tasks[1]);
  assert.equal(agentTask(tasks, "unknown"), undefined);
  assert.equal(stationMode("running"), "working");
  assert.equal(stationMode("queued"), "idle");
});
test("shared station escapes labels and remains an actionable keyboard button", () => {
  const html = officeStation({
    id: 'x" onclick="bad',
    name: "<script>",
    role: "QA",
    portrait: "<span></span>",
    mode: "waiting",
    label: "확인 필요",
    taskTitle: "<img src=x>",
    selected: true,
  });
  assert.ok(html.startsWith('<button type="button"'));
  assert.ok(html.includes('aria-pressed="true"'));
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(!html.includes('onclick="bad'));
  assert.ok(!html.includes("<img"));
});
