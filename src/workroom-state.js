export function workroomState(task) {
  const step = task.steps[task.step_index];
  const current = task.artifacts.find(
    (a) =>
      a.id === step.current_artifact_id &&
      a.step_index === task.step_index &&
      a.target_version === task.target_version,
  );
  const run = current && task.runs.find((r) => r.id === current.run_id);
  const pending = (task.questions || []).filter(
    (q) => q.status === "pending" && q.target_version === task.target_version,
  );
  return {
    current,
    pending,
    answersApplied:
      Number(run?.snapshot?.questionRevision || 0) ===
      Number(task.question_revision || 0),
    previous:
      current &&
      task.artifacts
        .filter(
          (a) =>
            a.step_index === task.step_index &&
            a.id !== current.id &&
            a.version < current.version,
        )
        .sort((a, b) => b.version - a.version)[0],
  };
}
