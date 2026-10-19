import { randomUUID } from "node:crypto";
import { z } from "zod";
import { transaction, event } from "./db.js";
import { getTask } from "./tasks.js";
import { requireOperator, canRead, readPredicate } from "./permissions.js";
import { fail, conflict } from "./errors.js";
import { id, revision } from "./validation.js";

const createInput = z
  .object({
    taskRevision: revision,
    assigneeId: id,
    prompt: z.string().trim().min(1).max(500),
  })
  .strict();
const updateInput = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("answer"),
      revision,
      answer: z.string().trim().min(1).max(1000),
    })
    .strict(),
  z.object({ action: z.literal("close"), revision }).strict(),
  z.object({ action: z.literal("assign"), revision, assigneeId: id }).strict(),
]);
export async function listQuestions(db, user) {
  return (
    await db.query(
      `SELECT q.*,t.number,t.title,t.responsible_id FROM cr_questions q JOIN cr_tasks t ON t.id=q.task_id WHERE ${readPredicate()} AND q.status='pending' ORDER BY q.created_at LIMIT 100`,
      [user.id, user.department],
    )
  ).rows;
}
async function assignee(db, task, memberId) {
  const member = (
    await db.query("SELECT * FROM cr_members WHERE id=$1", [memberId])
  ).rows[0];
  if (!canRead(member, task))
    fail(
      400,
      "ASSIGNEE_SCOPE",
      "이 업무를 볼 수 있는 활성 구성원을 선택해주세요.",
    );
}
async function record(db, task, user, type, questionId) {
  await db.query(
    "UPDATE cr_tasks SET revision=revision+1,updated_at=now() WHERE id=$1",
    [task.id],
  );
  await event(db, task.id, { type: "user", id: user.id }, type, { questionId });
}
export async function createQuestion(pool, user, taskId, input) {
  const v = createInput.parse(input);
  return transaction(pool, async (db) => {
    const task = await getTask(db, user, taskId, true);
    requireOperator(user, task);
    if (task.revision !== v.taskRevision) conflict();
    const run = task.current_run_id
      ? (
          await db.query("SELECT * FROM cr_runs WHERE id=$1", [
            task.current_run_id,
          ])
        ).rows[0]
      : null;
    if (
      !["queued", "result_ready", "failed"].includes(task.status) ||
      run?.lease_owner ||
      ["queued", "running", "paused"].includes(run?.status)
    )
      fail(
        409,
        "QUESTION_STATE",
        "새 업무나 실행이 끝난 업무에서 질문을 남겨주세요. 진행 중인 입력은 바뀌지 않습니다.",
      );
    await assignee(db, task, v.assigneeId);
    if (
      Number(
        (
          await db.query(
            "SELECT count(*) FROM cr_questions WHERE task_id=$1 AND target_version=$2",
            [taskId, task.target_version],
          )
        ).rows[0].count,
      ) >= 5
    )
      fail(
        409,
        "QUESTION_LIMIT",
        "대상 버전별 질문은 최대 5개입니다. 범위를 정리해 새 업무나 재작업으로 이어주세요.",
      );
    const question = (
      await db.query(
        "INSERT INTO cr_questions(id,task_id,target_version,asked_by,assignee_id,prompt) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",
        [
          randomUUID(),
          taskId,
          task.target_version,
          user.id,
          v.assigneeId,
          v.prompt,
        ],
      )
    ).rows[0];
    await record(db, task, user, "question_created", question.id);
    return question;
  });
}
export async function updateQuestion(pool, user, taskId, questionId, input) {
  const v = updateInput.parse(input);
  return transaction(pool, async (db) => {
    const task = await getTask(db, user, taskId, true);
    const q = (
      await db.query(
        "SELECT * FROM cr_questions WHERE id=$1 AND task_id=$2 FOR UPDATE",
        [questionId, taskId],
      )
    ).rows[0];
    if (!q) fail(404, "NOT_FOUND", "질문을 찾을 수 없어요.");
    if (
      q.revision !== v.revision ||
      q.status !== "pending" ||
      q.target_version !== task.target_version
    )
      conflict();
    if (["done", "cancelled"].includes(task.status))
      fail(409, "QUESTION_STATE", "종료된 업무의 질문은 변경할 수 없어요.");
    if (v.action === "answer") {
      if (q.assignee_id !== user.id)
        fail(403, "QUESTION_ASSIGNEE", "지정된 답변자만 답할 수 있어요.");
      await db.query(
        "UPDATE cr_questions SET answer=$2,answered_by=$3,answered_at=now(),status='answered',revision=revision+1 WHERE id=$1",
        [q.id, v.answer, user.id],
      );
      await db.query(
        "UPDATE cr_tasks SET question_revision=question_revision+1 WHERE id=$1",
        [taskId],
      );
    } else {
      requireOperator(user, task);
      if (v.action === "assign") {
        await assignee(db, task, v.assigneeId);
        await db.query(
          "UPDATE cr_questions SET assignee_id=$2,revision=revision+1 WHERE id=$1",
          [q.id, v.assigneeId],
        );
      } else
        await db.query(
          "UPDATE cr_questions SET status='closed',revision=revision+1 WHERE id=$1",
          [q.id],
        );
    }
    await record(db, task, user, "question_" + v.action, q.id);
    return (await db.query("SELECT * FROM cr_questions WHERE id=$1", [q.id]))
      .rows[0];
  });
}
