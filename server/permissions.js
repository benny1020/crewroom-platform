import { fail } from "./errors.js";
export const canRead = (user, resource) =>
  Boolean(
    user?.active &&
    resource &&
    (resource.owner_id === user.id ||
      resource.visibility === "team" ||
      (resource.visibility === "department" &&
        resource.department === user.department)),
  );
export const canOperate = (user, task) =>
  canRead(user, task) && task.responsible_id === user.id;
export const canIntervene = (user, task) =>
  canRead(user, task) && task.visibility !== "private" && user.role === "lead";
export function requireRead(user, resource) {
  if (!canRead(user, resource))
    fail(404, "NOT_FOUND", "자료를 찾을 수 없어요.");
}
export function requireOperator(user, task) {
  requireRead(user, task);
  if (!canOperate(user, task))
    fail(403, "RESPONSIBLE_REQUIRED", "현재 업무 책임자만 조작할 수 있어요.");
}
export function requireLead(user) {
  if (user.role !== "lead") fail(403, "LEAD_REQUIRED", "팀장 권한이 필요해요.");
}
export const readPredicate = (alias = "t", offset = 1) =>
  `(${alias}.owner_id=$${offset} OR ${alias}.visibility='team' OR (${alias}.visibility='department' AND ${alias}.department=$${offset + 1}))`;
