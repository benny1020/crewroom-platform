import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { isUuidLike } from "@paperclipai/shared";
import { badRequest, forbidden, HttpError, notFound } from "../errors.js";
import { accessService, agentService } from "../services/index.js";
import { assertCompanyAccess } from "./authz.js";

/** Presentation hints only: every mutation reauthorizes its actual resource. */
export function crewroomRoutes(db: Db) {
  const router = Router();
  const access = accessService(db);
  const agents = agentService(db);
  router.get("/companies/:companyId/crewroom/capabilities", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (req.actor.type !== "board" || !req.actor.userId) throw forbidden("Board user access required");
    let assigneeAgentId: string | null = null;
    if (req.query.assigneeAgentId !== undefined) {
      if (typeof req.query.assigneeAgentId !== "string" || !isUuidLike(req.query.assigneeAgentId)) {
        throw badRequest("assigneeAgentId must be a UUID");
      }
      assigneeAgentId = req.query.assigneeAgentId;
      const agent = await agents.getById(assigneeAgentId);
      if (!agent || agent.companyId !== companyId) throw notFound("Agent not found");
    }
    let canCreateUnassignedTask = true;
    let mutationReason: string | null = null;
    try { assertCompanyAccess(req, companyId, { mutation: true }); }
    catch (error) {
      if (!(error instanceof HttpError) || error.status !== 403) throw error;
      canCreateUnassignedTask = false;
      mutationReason = "company_write_denied";
    }
    const scope = { projectId: null, parentIssueId: null, assigneeAgentId, assigneeUserId: null };
    const [assignment, configure, create] = await Promise.all([
      access.decide({ actor: req.actor, action: "tasks:assign", resource: { type: "issue", companyId, ...scope }, scope }),
      access.decide({ actor: req.actor, action: "agents:configure", resource: { type: "company", companyId } }),
      access.decide({ actor: req.actor, action: "agents:create", resource: { type: "company", companyId } }),
    ]);
    res.setHeader("Cache-Control", "no-store");
    res.json({ companyId, assigneeAgentId,
      canCreateUnassignedTask,
      canAssignTasks: canCreateUnassignedTask && assignment.allowed,
      canConfigureAgents: canCreateUnassignedTask && configure.allowed,
      canCreateAgents: canCreateUnassignedTask && create.allowed,
      reasonCodes: {
        createUnassignedTask: mutationReason,
        assignTasks: mutationReason ?? (assignment.allowed ? null : assignment.reason),
        configureAgents: mutationReason ?? (configure.allowed ? null : configure.reason),
        createAgents: mutationReason ?? (create.allowed ? null : create.reason),
      },
    });
  });
  return router;
}
