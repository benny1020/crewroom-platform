import Fastify from "fastify";
import { readFile, stat } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { z } from "zod";
import {
  digest,
  transaction,
  event,
  assertRuntimeReady,
  lockContextMutation,
  lockContextRead,
} from "./db.js";
import { configuration, modelEndpoint } from "./config.js";
import {
  authenticate,
  issueSession,
  verifyPassword,
  limitAuth,
  createMember,
  publicMember,
  sessionToken,
  csrfToken,
  changePassword,
} from "./auth.js";
import { requireLead, requireRead, readPredicate } from "./permissions.js";
import { fail, HttpError } from "./errors.js";
import { listQuestions, createQuestion, updateQuestion } from "./questions.js";
import { login, register, taskInput, command, id } from "./validation.js";
import {
  createTask,
  executeCommand,
  taskDetail,
  getTask,
  listTasks,
} from "./tasks.js";
import {
  searchMemory,
  readMemorySource,
  documentsByKeys,
  sourceAllowed,
} from "./memory.js";
import { listWorkspace, readWorkspace } from "./agent-workspace.js";
import * as resources from "./resources.js";
import { taskHistory, taskArchive } from "./history.js";
import { EventHub, writeEvent } from "./event-hub.js";
import { operations, workerStatus } from "./operations.js";
import { listProposals, resolveProposal } from "./memory-learning.js";
import {
  listSkillStudios,
  createSkillStudio,
  skillStudioTurn,
  saveSkillStudio,
} from "./skill-studio.js";

export function buildApp(pool, config = configuration()) {
  const app = Fastify({
    logger: config.production
      ? {
          level: "info",
          redact: [
            "req.headers.cookie",
            "req.headers.authorization",
            "req.headers.x-csrf-token",
          ],
        }
      : false,
    bodyLimit: 100000,
    trustProxy: false,
    requestTimeout: 15000,
  });
  app.setErrorHandler((error, req, reply) => {
    if (error instanceof z.ZodError)
      return reply.code(400).send({
        code: "VALIDATION_ERROR",
        message: "입력 내용을 확인해주세요.",
        fields: error.issues.map((i) => i.path.join(".")),
      });
    if (error.code === "RESTORE_INCOMPLETE")
      return reply.code(503).send({
        code: error.code,
        message: "복원이 완료되지 않아 접속을 잠시 차단했어요.",
      });
    if (error instanceof HttpError)
      return reply
        .code(error.statusCode)
        .send({ code: error.code, message: error.message });
    if (error.code === "23505")
      return reply.code(409).send({
        code: "ALREADY_EXISTS",
        message: "이미 사용 중이거나 다른 요청이 진행 중이에요.",
      });
    if (error.statusCode === 400)
      return reply
        .code(400)
        .send({ code: "BAD_REQUEST", message: "요청 형식을 확인해주세요." });
    if (error.statusCode === 413)
      return reply
        .code(413)
        .send({ code: "TOO_LARGE", message: "요청 내용이 너무 커요." });
    req.log.error(
      { code: error.code || error.name, requestId: req.id },
      "Request failed",
    );
    reply.code(500).send({
      code: "INTERNAL_ERROR",
      message: "처리하지 못했어요. 잠시 후 다시 시도해주세요.",
      requestId: req.id,
    });
  });
  app.addHook("onRequest", async (req, reply) => {
    reply
      .header("x-content-type-options", "nosniff")
      .header("x-frame-options", "DENY")
      .header("referrer-policy", "same-origin")
      .header(
        "content-security-policy",
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
      );
    if (req.url.startsWith("/api/")) reply.header("cache-control", "no-store");
    if (
      ["POST", "PATCH", "DELETE", "PUT"].includes(req.method) &&
      req.url.startsWith("/api/")
    ) {
      if (req.headers.origin !== config.origin)
        fail(403, "ORIGIN_REQUIRED", "허용된 화면에서 요청해주세요.");
      if (
        !String(req.headers["content-type"] || "").startsWith(
          "application/json",
        )
      )
        fail(415, "JSON_REQUIRED", "JSON 형식의 요청이 필요해요.");
    }
  });
  app.addHook("preHandler", async (req) => {
    const path = req.url.split("?")[0];
    if (path.startsWith("/api/") && path !== "/api/health")
      await assertRuntimeReady(pool);
    if (
      !path.startsWith("/api/") ||
      [
        "/api/health",
        "/api/ready",
        "/api/auth/login",
        "/api/auth/register",
        "/api/setup",
      ].includes(path)
    )
      return;
    req.member = await authenticate(pool, req);
    if (!["GET", "HEAD"].includes(req.method)) {
      const csrf = String(req.headers["x-csrf-token"] || "");
      if (!csrf || digest(csrf) !== req.member.csrf_hash)
        fail(403, "CSRF_REQUIRED", "화면을 새로고침하고 다시 시도해주세요.");
    }
  });
  app.get("/api/health", async () => ({
    ok: true,
    release: config.release,
    mode: "server",
  }));
  app.get("/api/ready", async () => {
    await pool.query("SELECT 1");
    return { ok: true };
  });
  app.get("/api/setup", async () => ({
    bootstrapped: Boolean(
      (await pool.query("SELECT 1 FROM cr_members LIMIT 1")).rowCount,
    ),
    registrationEnabled: false,
  }));
  app.post("/api/auth/login", async (req, reply) => {
    const v = login.parse(req.body);
    await limitAuth(pool, req.ip, v.email);
    const user = (
      await pool.query("SELECT * FROM cr_members WHERE email=$1", [
        v.email.toLowerCase().trim(),
      ])
    ).rows[0];
    const valid = await verifyPassword(v.password, user?.password_hash);
    if (!valid || !user?.active)
      fail(401, "INVALID_CREDENTIALS", "이메일과 비밀번호를 확인해주세요.");
    return issueSession(pool, user, reply, config);
  });
  app.post("/api/auth/register", async () => {
    fail(
      403,
      "PROVISIONING_REQUIRED",
      "운영 담당자가 발급한 팀 계정으로 로그인해주세요.",
    );
  });
  app.post("/api/auth/lead-request", async (req) => {
    await pool.query(
      "UPDATE cr_members SET lead_requested=true WHERE id=$1 AND role='member'",
      [req.member.id],
    );
    await event(
      pool,
      null,
      { type: "user", id: req.member.id },
      "lead_requested",
    );
    return { ok: true };
  });
  app.get("/api/auth/session", async (req) => ({
    user: publicMember(req.member),
    csrfToken: csrfToken(sessionToken(req)),
  }));
  app.post("/api/auth/password", async (req, reply) => {
    const values = z
      .object({
        currentPassword: z.string().min(1).max(128),
        nextPassword: z.string().min(12).max(128),
      })
      .strict()
      .parse(req.body);
    await limitAuth(pool, req.ip, req.member.email);
    await changePassword(
      pool,
      req.member.id,
      values.currentPassword,
      values.nextPassword,
    );
    reply.header(
      "set-cookie",
      "cr_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0" +
        (config.secureCookies ? "; Secure" : ""),
    );
    return { ok: true };
  });
  app.post("/api/auth/logout", async (req, reply) => {
    await pool.query("DELETE FROM cr_sessions WHERE token_hash=$1", [
      digest(sessionToken(req)),
    ]);
    reply.header(
      "set-cookie",
      `cr_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${config.secureCookies ? "; Secure" : ""}`,
    );
    return { ok: true };
  });
  app.get("/api/workspace", async (req) => {
    const user = req.member;
    const [members, agents, skills, tasks, memories, workers] =
      await Promise.all([
        pool.query(
          "SELECT id,name,email,role,department,lead_requested,active FROM cr_members ORDER BY created_at",
        ),
        resources.agents(pool, user),
        resources.listSkills(pool, user),
        listTasks(pool, user),
        resources.listMemories(pool, user),
        workerStatus(pool),
      ]);
    return {
      user: publicMember(user),
      members: members.rows.map((m) => ({
        ...publicMember(m),
        email: user.role === "lead" || m.id === user.id ? m.email : undefined,
      })),
      agents,
      skills,
      skillStudios: await listSkillStudios(pool, user),
      tasks,
      questions: await listQuestions(pool, user),
      memories,
      workers: workers.map((w) => ({
        ...w,
        id: user.role === "lead" ? w.id : undefined,
        last_error_code: user.role === "lead" ? w.last_error_code : undefined,
        maintenance_error_code:
          user.role === "lead" ? w.maintenance_error_code : undefined,
      })),
      runtime: {
        provider: config.provider,
        model: config.model,
        mode: "native",
        codeExecution: !!config.runnerUrl,
        fixture: config.allowFixture,
        modelConfigured: Boolean(
          (config.allowFixture && config.provider === "fixture") ||
          (config.model && modelEndpoint(config)),
        ),
      },
      release: config.release,
    };
  });
  app.get("/api/admin/operations", async (req) => operations(pool, req.member));
  app.get("/api/tasks", async (req) =>
    taskArchive(pool, req.member, req.query),
  );
  app.post("/api/tasks", async (req, reply) => {
    const task = await createTask(
      pool,
      req.member,
      taskInput.parse(req.body),
      req.headers["idempotency-key"],
    );
    reply.code(201);
    return { task };
  });
  app.get("/api/tasks/:id", async (req) => ({
    task: await taskDetail(pool, req.member, id.parse(req.params.id)),
  }));
  app.get("/api/tasks/:id/history/:kind", async (req) =>
    taskHistory(
      pool,
      req.member,
      id.parse(req.params.id),
      req.params.kind,
      req.query,
    ),
  );
  app.post("/api/tasks/:id/questions", async (req, reply) => {
    const question = await createQuestion(
      pool,
      req.member,
      id.parse(req.params.id),
      req.body,
    );
    reply.code(201);
    return { question };
  });
  app.patch("/api/tasks/:id/questions/:questionId", async (req) => ({
    question: await updateQuestion(
      pool,
      req.member,
      id.parse(req.params.id),
      id.parse(req.params.questionId),
      req.body,
    ),
  }));
  app.post("/api/tasks/:id/commands", async (req) => ({
    task: await executeCommand(
      pool,
      req.member,
      id.parse(req.params.id),
      command.parse(req.body),
      config,
    ),
  }));
  app.post("/api/tasks/:id/messages", async (req) => {
    const taskId = id.parse(req.params.id),
      body = z
        .object({ body: z.string().trim().min(1).max(6000) })
        .strict()
        .parse(req.body);
    return transaction(pool, async (db) => {
      const sourceTask = await getTask(db, req.member, taskId, true);
      const message = (
        await db.query(
          "INSERT INTO cr_messages(task_id,user_id,body,target_version) VALUES($1,$2,$3,$4) RETURNING *",
          [taskId, req.member.id, body.body, sourceTask.target_version],
        )
      ).rows[0];
      await db.query("UPDATE cr_tasks SET updated_at=now() WHERE id=$1", [
        taskId,
      ]);
      await event(db, taskId, { type: "user", id: req.member.id }, "message", {
        messageId: message.id,
      });
      return { message };
    });
  });
  const workspaceRead = (req, read) =>
    transaction(pool, async (db) => {
      await db.query("SET TRANSACTION READ ONLY");
      await lockContextRead(db);
      // Auth before waiting on the gate may be stale after a membership change.
      const member = await authenticate(db, req);
      return read(db, member);
    });
  app.get("/api/agents/:agentId/workspace", async (req) => {
    const query = z
      .object({
        query: z.string().max(100).optional(),
        cursor: z.string().uuid().optional(),
      })
      .parse(req.query);
    return workspaceRead(req, async (db, member) => {
      const agent = (await resources.agents(db, member)).find(
        (a) => a.id === req.params.agentId,
      );
      if (!agent) fail(404, "NOT_FOUND", "동료를 찾을 수 없어요.");
      return listWorkspace(db, member, { agentId: agent.id, ...query });
    });
  });
  app.get("/api/tasks/:id/workspace", async (req) => {
    const taskId = id.parse(req.params.id);
    const query = z
      .object({
        query: z.string().max(100).optional(),
        cursor: z.string().uuid().optional(),
      })
      .parse(req.query);
    return workspaceRead(req, async (db, member) => {
      const task = await getTask(db, member, taskId);
      return listWorkspace(db, member, { taskId: task.id, ...query });
    });
  });
  app.get("/api/workspace/documents/:id", async (req) => {
    const query = z
      .object({
        offset: z.coerce.number().int().min(0).max(32768).optional(),
        revision: z.coerce.number().int().min(1).optional(),
        beforeRevision: z.coerce.number().int().min(1).optional(),
      })
      .parse(req.query);
    return workspaceRead(req, async (db, member) => {
      return readWorkspace(db, member, id.parse(req.params.id), query);
    });
  });
  app.get("/api/artifacts/:id", async (req, reply) => {
    const artifact = (
      await pool.query("SELECT * FROM cr_artifacts WHERE id=$1", [
        id.parse(req.params.id),
      ])
    ).rows[0];
    if (!artifact) fail(404, "NOT_FOUND", "결과를 찾을 수 없어요.");
    await getTask(pool, req.member, artifact.task_id);
    if (req.query.format === "patch") {
      if (!artifact.result.execution)
        fail(404, "NO_PATCH", "수정 diff가 없어요.");
      return reply
        .type("text/plain; charset=utf-8")
        .header(
          "content-disposition",
          'attachment; filename="crewroom-' + artifact.id + '.patch"',
        )
        .send(artifact.result.execution.patch);
    }
    const result = artifact.result,
      text = `# 결과 v${artifact.version}\n\n대상: ${artifact.target_version}\n출처: ${artifact.origin}\n\n${result.summary}\n\n## 근거\n${(result.evidence || []).map((e) => `- ${e}`).join("\n")}\n\n## 미확인 사항\n${(result.unknowns || []).map((e) => `- ${e}`).join("\n")}\n\n## 다음 행동\n${(result.nextActions || []).map((e) => `- ${e}`).join("\n")}\n`;
    reply
      .type("text/markdown; charset=utf-8")
      .header(
        "content-disposition",
        `attachment; filename="crewroom-${artifact.id}.md"`,
      );
    return (
      text +
      (result.execution
        ? "\n## 실제 실행\n\n```json\n" +
          JSON.stringify({ ...result.execution, patch: undefined }, null, 2) +
          "\n```\n\n## 수정 diff\n\n```diff\n" +
          result.execution.patch +
          "\n```\n"
        : "")
    );
  });
  app.patch("/api/agents/:id", async (req) => ({
    agent: await resources.updateAgent(
      pool,
      req.member,
      req.params.id,
      req.body,
    ),
  }));
  app.post("/api/agents/:id/bindings", async (req) =>
    resources.bindSkill(pool, req.member, req.params.id, req.body),
  );
  app.post("/api/skills", async (req, reply) => {
    const skill = await resources.createSkill(pool, req.member, req.body);
    return reply.code(201).send({ skill });
  });
  app.post("/api/skill-studio", async (req, reply) => {
    const task = await createSkillStudio(
      pool,
      req.member,
      req.body,
      req.headers["idempotency-key"],
      config,
    );
    return reply.code(201).send({ task });
  });
  app.post("/api/skill-studio/:id/turns", async (req) => ({
    task: await skillStudioTurn(
      pool,
      req.member,
      id.parse(req.params.id),
      req.body,
      config,
    ),
  }));
  app.post("/api/skill-studio/:id/save", async (req) => ({
    skill: await saveSkillStudio(
      pool,
      req.member,
      id.parse(req.params.id),
      req.body,
    ),
  }));
  app.post("/api/skills/:id/versions", async (req) =>
    resources.publishSkill(pool, req.member, req.params.id, req.body),
  );
  app.patch("/api/skills/:id/steward", async (req) =>
    resources.setSteward(
      pool,
      req.member,
      req.params.id,
      z.object({ stewardId: id.nullable() }).strict().parse(req.body).stewardId,
    ),
  );
  app.patch("/api/members/:id", async (req) =>
    resources.updateMember(pool, req.member, id.parse(req.params.id), req.body),
  );
  const publicMemory = (d) => ({
    key: d.key,
    kind: d.kind,
    title: d.title,
    body: d.excerpt || d.body,
    source: d.source,
    taskId: d.task_id,
    project: d.project,
    visibility: d.visibility,
    targetVersion: d.target_version,
    createdAt: d.created_at,
    audience: d.audience,
    validFrom: d.valid_from,
    validTo: d.valid_to,
    supersedesId: d.supersedes_id,
  });
  app.get("/api/tasks/:id/memory", async (req) => {
    const task = await getTask(pool, req.member, id.parse(req.params.id));
    const run = (
      await pool.query("SELECT * FROM cr_runs WHERE id=$1", [
        task.current_run_id,
      ])
    ).rows[0];
    if (!run) return { items: [], unavailable: 0 };
    const reads = (
      await pool.query("SELECT refs FROM cr_memory_reads WHERE run_id=$1", [
        run.id,
      ])
    ).rows;
    const refs = [
      ...(run.snapshot.memoryContext?.refs || []),
      ...reads.flatMap((r) => r.refs),
    ];
    const docs = await documentsByKeys(pool, [
      ...new Set(refs.map((r) => r.key)),
    ]);
    const items = [...docs.values()]
      .filter(
        (d) =>
          sourceAllowed(req.member, task, d) &&
          refs.some(
            (r) =>
              r.key === d.key &&
              (r.revision === d.revision ||
                r.legacyRevision === d.record_revision),
          ) &&
          (d.dependencies || []).every((r) => {
            const source = docs.get(r.key);
            return (
              source &&
              sourceAllowed(req.member, task, source) &&
              (r.revision === source.revision ||
                r.legacyRevision === source.record_revision)
            );
          }),
      )
      .map(publicMemory);
    return {
      items,
      unavailable: new Set(refs.map((r) => r.key)).size - items.length,
      method: run.snapshot.memoryContext?.method || "legacy",
      semanticStatus: run.snapshot.memoryContext?.semanticStatus || "disabled",
    };
  });
  app.get("/api/memory/search", async (req) => {
    const v = z
      .object({
        q: z.string().max(300).default(""),
        agentId: z.string().max(80).default(""),
        project: z.string().max(80).default(""),
        asOf: z.iso.datetime({ offset: true }).optional(),
      })
      .strict()
      .parse(req.query);
    const docs = await searchMemory(
      pool,
      req.member,
      { visibility: "private", department: req.member.department },
      {
        query: v.q,
        agentId: v.agentId,
        project: v.project,
        asOf: v.asOf,
        limit: 30,
      },
    );
    return {
      items: docs.map(publicMemory),
      method: "rrf-keyword",
      automaticSummaries: "extractive",
    };
  });
  app.get("/api/memory/proposals", async (req) => ({
    items: await listProposals(pool, req.member),
  }));
  app.post("/api/memory/proposals/:id", async (req) =>
    resolveProposal(pool, req.member, id.parse(req.params.id), req.body),
  );
  app.get("/api/memory/sources/:key", async (req) => {
    const key = z.string().max(100).parse(req.params.key),
      doc = await readMemorySource(
        pool,
        req.member,
        { visibility: "private", department: req.member.department },
        key,
      );
    return { item: publicMemory({ ...doc, excerpt: doc.body }) };
  });
  app.get("/api/memories", async (req) => ({
    memories: await resources.listMemories(
      pool,
      req.member,
      z
        .string()
        .max(200)
        .parse(req.query.q || ""),
    ),
  }));
  app.post("/api/memories", async (req, reply) => {
    reply.code(201);
    return resources.createMemory(pool, req.member, req.body);
  });
  app.patch("/api/memories/:id", async (req) =>
    resources.changeMemory(pool, req.member, id.parse(req.params.id), req.body),
  );
  app.delete("/api/memories/:id", async (req) =>
    resources.changeMemory(
      pool,
      req.member,
      id.parse(req.params.id),
      req.body,
      true,
    ),
  );
  app.get("/api/admin/audit", async (req) => {
    requireLead(req.member);
    return {
      events: (
        await pool.query(
          "SELECT * FROM cr_events WHERE task_id IS NULL AND type NOT LIKE 'memory_%' ORDER BY id DESC LIMIT 100",
        )
      ).rows,
    };
  });
  app.post("/api/runs/:id/confirm-stopped", async (req) => {
    requireLead(req.member);
    z.object({ confirmedStopped: z.literal(true) })
      .strict()
      .parse(req.body);
    return transaction(pool, async (db) => {
      const ref = (
        await db.query("SELECT task_id FROM cr_runs WHERE id=$1", [
          id.parse(req.params.id),
        ])
      ).rows[0];
      if (!ref) fail(404, "NOT_FOUND", "실행을 찾을 수 없어요.");
      await getTask(db, req.member, ref.task_id, true);
      const run = (
        await db.query("SELECT * FROM cr_runs WHERE id=$1 FOR UPDATE", [
          id.parse(req.params.id),
        ])
      ).rows[0];
      if (!run) fail(404, "NOT_FOUND", "실행을 찾을 수 없어요.");
      await getTask(db, req.member, run.task_id);
      if (
        ["RESTORE_CONFIRMATION_REQUIRED", "DISPATCH_UNKNOWN"].includes(
          run.error_code,
        ) ||
        (
          await db.query(
            "SELECT 1 FROM cr_model_dispatches WHERE run_id=$1 AND state IN ('prepared','launched','unknown')",
            [run.id],
          )
        ).rowCount
      )
        fail(
          409,
          "OPERATOR_CLI_REQUIRED",
          "운영 담당자의 종료 확인과 근거 파일이 필요해요.",
        );
      if (
        !["failed", "paused", "cancelled"].includes(run.status) ||
        (run.lease_until && new Date(run.lease_until) > new Date())
      )
        fail(
          409,
          "RUN_NOT_EXPIRED",
          "실행 종료와 임대 만료를 먼저 확인해주세요.",
        );
      await db.query(
        "UPDATE cr_runs SET lease_owner=NULL,lease_until=NULL,generation=generation+1 WHERE id=$1",
        [run.id],
      );
      await event(
        db,
        run.task_id,
        { type: "user", id: req.member.id },
        "execution_stop_confirmed",
        { runId: run.id },
      );
      return { ok: true };
    });
  });
  const streams = new Set(),
    eventHub = new EventHub(pool);
  app.addHook("onReady", () => eventHub.start());
  app.get("/api/events", async (req, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    if (!writeEvent(reply.raw, "retry: 2000\n\n")) return;
    let closed = false,
      busy = false,
      lastEpoch = -1,
      lastSync = 0;
    const subscription = eventHub.subscribe();
    const tick = async () => {
      if (closed || busy) return;
      busy = true;
      try {
        const user = await authenticate(pool, req);
        const ids = eventHub.drain(subscription),
          force =
            lastEpoch !== eventHub.epoch || Date.now() - lastSync >= 60000;
        const changed =
          ids.length &&
          (
            await pool.query(
              `SELECT 1 FROM cr_events e LEFT JOIN cr_tasks t ON t.id=e.task_id WHERE e.id=ANY($3::bigint[]) AND ((${readPredicate("t")}) OR (e.task_id IS NULL AND e.actor_id=$1::text)) LIMIT 1`,
              [user.id, user.department, ids],
            )
          ).rowCount;
        if (force || changed) {
          lastEpoch = eventHub.epoch;
          lastSync = Date.now();
          writeEvent(reply.raw, `event: refresh\ndata: {"resync":true}\n\n`);
        } else writeEvent(reply.raw, ": heartbeat\n\n");
      } catch {
        reply.raw.end();
      } finally {
        busy = false;
      }
    };
    const interval = setInterval(tick, 2000);
    streams.add(reply.raw);
    reply.raw.on("close", () => {
      closed = true;
      clearInterval(interval);
      streams.delete(reply.raw);
      eventHub.unsubscribe(subscription);
    });
    await tick();
  });
  app.addHook("preClose", async () => {
    for (const stream of streams) stream.end();
    await eventHub.close();
  });
  if (config.serveDist) {
    const dist = resolve("dist"),
      types = {
        ".js": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".svg": "image/svg+xml",
        ".png": "image/png",
        ".webp": "image/webp",
        ".ico": "image/x-icon",
      };
    app.get("/*", async (req, reply) => {
      const path = req.url.split("?")[0];
      if (path.startsWith("/api/"))
        return reply
          .code(404)
          .send({ code: "NOT_FOUND", message: "요청 경로를 찾을 수 없어요." });
      if (path === "/" || path === "/index.html") {
        reply
          .type("text/html; charset=utf-8")
          .header("cache-control", "no-store");
        return (await readFile(resolve(dist, "index.html"), "utf8")).replace(
          "<head>",
          '<head><meta name="crewroom-runtime" content="server">',
        );
      }
      let file;
      try {
        file = resolve(dist, `.${decodeURIComponent(path)}`);
      } catch {
        fail(400, "BAD_PATH", "경로를 확인해주세요.");
      }
      if (!file.startsWith(dist + sep))
        fail(404, "NOT_FOUND", "파일을 찾을 수 없어요.");
      try {
        if (!(await stat(file)).isFile()) throw new Error();
      } catch {
        fail(404, "NOT_FOUND", "파일을 찾을 수 없어요.");
      }
      reply
        .type(types[extname(file)] || "application/octet-stream")
        .header(
          "cache-control",
          path.startsWith("/assets/")
            ? "public, max-age=31536000, immutable"
            : "no-cache",
        );
      return readFile(file);
    });
  }
  return app;
}
