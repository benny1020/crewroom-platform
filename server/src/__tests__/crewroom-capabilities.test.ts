import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, companyMemberships, createDb, principalPermissionGrants, issues, issueComments, agentWakeupRequests, issueAccessGrants } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { crewroomRoutes } from "../routes/crewroom.js";
import { issueRoutes } from "../routes/issues.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { errorHandler } from "../middleware/index.js";
import { issueService } from "../services/issues.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("Crewroom capability projection", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const companyId = randomUUID();
  const otherCompanyId = randomUUID();
  const agentId = randomUUID();
  const privateAgentId = randomUUID();
  const otherAgentId = randomUUID();
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("crewroom-capabilities-");
    db = createDb(database.connectionString);
    await instanceSettingsService(db).updateExperimental({ enableAgentChat: true });
    await db.insert(companies).values([{ id: companyId, name: "Crewroom", issuePrefix: "CRW" },
      { id: otherCompanyId, name: "Other", issuePrefix: "OTH" }]);
    await db.insert(agents).values([
      { id: agentId, companyId, name: "Public colleague", role: "engineer", status: "idle", adapterType: "process" },
      { id: privateAgentId, companyId, name: "Restricted colleague", role: "engineer", status: "idle", adapterType: "process",
        permissions: { authorizationPolicy: { agentVisibility: { mode: "private", hiddenFromDefaultDirectory: true } } } },
      { id: otherAgentId, companyId: otherCompanyId, name: "Other colleague", role: "engineer", status: "idle", adapterType: "process" },
    ]);
  }, 90000);
  afterAll(async () => { await db?.$client.end({ timeout: 0 }); await database?.cleanup(); });

  async function appFor(role: "operator" | "viewer", source: "session" | "local_implicit" = "session") {
    const userId = randomUUID();
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, membershipRole: role, status: "active" });
    const app = express();
    const wakeup = vi.fn(async () => null);
    app.use(express.json());
    app.use(async (req, _res, next) => {
      const rows = await db.select().from(companyMemberships).where(and(eq(companyMemberships.principalId, userId), eq(companyMemberships.status, "active")));
      req.actor = { type: "board", source, userId, companyIds: rows.map(row => row.companyId), memberships: rows };
      next();
    });
    app.use("/api", crewroomRoutes(db));
    app.use("/api", issueRoutes(db, { wakeup } as never));
    app.use(errorHandler);
    return { app, userId, wakeup };
  }
  const path = `/api/companies/${companyId}/crewroom/capabilities`;
  it("keeps viewer discovery read-only and agrees with the actual task mutation", async () => {
    const { app } = await appFor("viewer");
    const result = await request(app).get(path).query({ assigneeAgentId: agentId });
    expect(result.status).toBe(200);
    expect(result.headers["cache-control"]).toBe("no-store");
    expect(result.body).toMatchObject({ canAssignTasks: false, canCreateUnassignedTask: false,
      canConfigureAgents: false, canCreateAgents: false, reasonCodes: { createUnassignedTask: "company_write_denied" } });
    expect((await request(app).post(`/api/companies/${companyId}/issues`).send({ title: "Viewer write" })).status).toBe(403);
  });
  it("projects independent management grants and refreshes them after revocation", async () => {
    const { app, userId } = await appFor("operator");
    const initial = await request(app).get(path).query({ assigneeAgentId: agentId });
    expect(initial.body).toMatchObject({ canAssignTasks: true, canCreateUnassignedTask: true, canConfigureAgents: false, canCreateAgents: false });
    await db.insert(principalPermissionGrants).values({ companyId, principalType: "user", principalId: userId, permissionKey: "agents:configure" });
    expect((await request(app).get(path)).body).toMatchObject({ canConfigureAgents: true, canCreateAgents: false });
    await db.delete(principalPermissionGrants).where(eq(principalPermissionGrants.principalId, userId));
    expect((await request(app).get(path)).body.canConfigureAgents).toBe(false);
  });
  it("evaluates the selected assignee instead of granting company-wide assignment from a scoped grant", async () => {
    const { app, userId } = await appFor("operator");
    expect((await request(app).get(path).query({ assigneeAgentId: privateAgentId })).body.canAssignTasks).toBe(false);
    await db.insert(principalPermissionGrants).values({ companyId, principalType: "user", principalId: userId,
      permissionKey: "tasks:assign_scope", scope: { assigneeAgentId: privateAgentId } });
    expect((await request(app).get(path).query({ assigneeAgentId: privateAgentId })).body.canAssignTasks).toBe(true);
  });
  it("rejects cross-company or malformed selections and loses access after membership removal", async () => {
    const { app, userId } = await appFor("operator");
    expect((await request(app).get(path).query({ assigneeAgentId: otherAgentId })).status).toBe(404);
    expect((await request(app).get(path).query({ assigneeAgentId: "bad-id" })).status).toBe(400);
    expect((await request(app).get(`/api/companies/${otherCompanyId}/crewroom/capabilities`)).status).toBe(403);
    await db.update(companyMemberships).set({ status: "suspended" }).where(eq(companyMemberships.principalId, userId));
    expect((await request(app).get(path)).status).toBe(403);
  });
  it("does not mint private assignment grants through chat ensure and rechecks revoked agent use", async () => {
    const { app, userId } = await appFor("operator");
    const chatPath = `/api/companies/${companyId}/chats/${privateAgentId}`;
    const grantsBefore = await db.select().from(issueAccessGrants);
    expect((await request(app).post(chatPath)).status).toBe(403);
    expect(await db.select().from(issues).where(eq(issues.conversationUserId, userId))).toHaveLength(0);
    expect(await db.select().from(issueAccessGrants)).toHaveLength(grantsBefore.length);
    const [grant] = await db.insert(principalPermissionGrants).values({ companyId, principalType: "user", principalId: userId,
      permissionKey: "tasks:assign_scope", scope: { assigneeAgentId: privateAgentId } }).returning();
    const created = await request(app).post(chatPath);
    expect(created.status).toBe(200);
    expect(created.body.visibility).toBe("private");
    const chatId = created.body.id;
    await db.delete(principalPermissionGrants).where(eq(principalPermissionGrants.id, grant.id));
    expect((await request(app).post(chatPath)).status).toBe(403);
    for (const body of ["Continue", "/new"]) {
      expect((await request(app).post(`/api/issues/${chatId}/comments`)
        .send({ body, clientRequestId: randomUUID() })).status).toBe(403);
    }
    expect((await request(app).post(`/api/issues/${chatId}/queued-comments/interrupt`)
      .send({ queueId: randomUUID(), revision: "revoked", targetRunId: randomUUID() })).status).toBe(403);
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, chatId))).toHaveLength(0);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, privateAgentId))).toHaveLength(0);
    expect((await request(app).get(`/api/issues/${chatId}`)).status).toBe(200);
    expect((await request(app).get(chatPath)).status).toBe(200);
  });
  it("preserves the explicit single-operator local-trusted context", async () => {
    const { app } = await appFor("operator", "local_implicit");
    expect((await request(app).get(path).query({ assigneeAgentId: agentId })).body).toMatchObject({
      canAssignTasks: true, canCreateUnassignedTask: true, canConfigureAgents: true, canCreateAgents: true });
  });
  const feedbackCases = (["post", "patch"] as const).flatMap(method =>
    (["done", "cancelled"] as const).flatMap(status =>
      [false, true, undefined].map(reopen => ({ method, status, reopen }))));
  it.each(feedbackCases)("honors explicit feedback intent on $status through $method (reopen=$reopen)", async ({ method, status, reopen }) => {
    const { app, userId, wakeup } = await appFor("operator");
    const task = await issueService(db).create(companyId, { title: `Feedback ${randomUUID()}`, status,
      assigneeAgentId: agentId, createdByUserId: userId });
    const comment = reopen === false ? `@${agentId} 고마워요. 확인 의견만 남깁니다.` : "같은 업무의 결과를 수정해주세요.";
    const body = { ...(method === "post" ? { body: comment } : { comment }),
      ...(reopen === undefined ? {} : { reopen }) };
    const response = method === "post"
      ? await request(app).post(`/api/issues/${task.id}/comments`).send(body)
      : await request(app).patch(`/api/issues/${task.id}`).send(body);
    expect(response.status).toBe(method === "post" ? 201 : 200);
    const saved = await issueService(db).getById(task.id);
    expect(saved).toMatchObject({ id: task.id, status: reopen === false ? status : "todo" });
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, task.id))).toHaveLength(1);
    if (reopen !== false) await vi.waitFor(() => expect(wakeup).toHaveBeenCalledTimes(1));
    else expect(wakeup).not.toHaveBeenCalled();
    if (reopen !== false) expect(wakeup).toHaveBeenCalledWith(agentId, expect.objectContaining({
      reason: "issue_reopened_via_comment", contextSnapshot: expect.objectContaining({ issueId: task.id }),
    }));
  });
});
