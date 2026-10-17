import {
  randomBytes,
  randomUUID,
  scrypt as rawScrypt,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";
import { digest, transaction, event } from "./db.js";
import { fail } from "./errors.js";
const scrypt = promisify(rawScrypt);
const options = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
export async function hashPassword(password) {
  if (
    typeof password !== "string" ||
    password.length < 12 ||
    password.length > 128
  )
    fail(400, "PASSWORD_POLICY", "비밀번호는 12~128자로 입력해주세요.");
  const salt = randomBytes(24).toString("base64url");
  return `scrypt:${salt}:${Buffer.from(await scrypt(password, salt, 64, options)).toString("base64url")}`;
}
export async function verifyPassword(password, encoded) {
  const [, salt, value] = String(encoded || "scrypt:crewroom-invalid:").split(
    ":",
  );
  const actual = Buffer.from(
    await scrypt(
      String(password).slice(0, 128),
      salt || "crewroom-invalid",
      64,
      options,
    ),
  );
  const expected = Buffer.from(value || "", "base64url");
  return expected.length === actual.length && timingSafeEqual(actual, expected);
}
export const publicMember = (m) => ({
  id: m.id,
  email: m.email,
  name: m.name,
  role: m.role,
  department: m.department,
  leadRequested: m.lead_requested,
  active: m.active,
});
export const sessionToken = (req) =>
  String(req.headers.cookie || "")
    .split(";")
    .map((x) => x.trim())
    .find((x) => x.startsWith("cr_session="))
    ?.slice(11);
export const csrfToken = (token) => digest(`${token}:csrf`);
export async function issueSession(db, user, reply, config) {
  const token = randomBytes(32).toString("base64url"),
    csrf = csrfToken(token);
  await db.query(
    "INSERT INTO cr_sessions(token_hash,user_id,csrf_hash,expires_at) VALUES($1,$2,$3,now()+interval '12 hours')",
    [digest(token), user.id, digest(csrf)],
  );
  reply.header(
    "set-cookie",
    `cr_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200${config.secureCookies ? "; Secure" : ""}`,
  );
  return { user: publicMember(user), csrfToken: csrf };
}
export async function authenticate(pool, req) {
  const token = sessionToken(req);
  if (!token || !/^[\w-]{43}$/.test(token))
    fail(401, "UNAUTHENTICATED", "로그인이 필요해요.");
  const record = (
    await pool.query(
      "SELECT m.*,s.csrf_hash FROM cr_sessions s JOIN cr_members m ON m.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now() AND m.active=true",
      [digest(token)],
    )
  ).rows[0];
  if (!record) fail(401, "UNAUTHENTICATED", "다시 로그인해주세요.");
  return record;
}
export async function limitAuth(pool, ip, email) {
  const key = digest(`auth:${ip}:${String(email).toLowerCase()}`);
  const { rows } = await pool.query(
    `INSERT INTO cr_auth_attempts(key,attempts) VALUES($1,1) ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN cr_auth_attempts.window_start<now()-interval '15 minutes' THEN 1 ELSE cr_auth_attempts.attempts+1 END,window_start=CASE WHEN cr_auth_attempts.window_start<now()-interval '15 minutes' THEN now() ELSE cr_auth_attempts.window_start END RETURNING attempts`,
    [key],
  );
  if (rows[0].attempts > 15)
    fail(429, "RATE_LIMITED", "잠시 후 다시 시도해주세요.");
}
export async function createMember(db, values, role = "member") {
  const id = randomUUID(),
    hash = await hashPassword(values.password);
  const user = (
    await db.query(
      "INSERT INTO cr_members(id,email,name,password_hash,role,department,lead_requested) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *",
      [
        id,
        values.email.toLowerCase().trim(),
        values.name,
        hash,
        role,
        values.department,
        role !== "lead" && Boolean(values.leadRequested),
      ],
    )
  ).rows[0];
  await db.query(
    "INSERT INTO cr_agents(id,owner_id,department,name,role,character,instructions) VALUES($1,$2,$3,$4,$5,$6,$7)",
    [
      `personal-${id}`,
      id,
      user.department,
      values.assistantName || "나의 비서",
      "개인 업무 비서",
      "lumi",
      "사용자의 개인 업무를 돕습니다. 허가된 기억만 사용하고 확인하지 않은 사실은 미확인으로 표시합니다.",
    ],
  );
  await db.query(
    "INSERT INTO cr_skill_bindings(agent_id,skill_id,version) VALUES($1,'conversation',1)",
    [`personal-${id}`],
  );
  await event(db, null, { type: "user", id }, "member_joined", {
    memberId: id,
    leadRequested: user.lead_requested,
  });
  return user;
}
export async function bootstrap(pool, values) {
  return transaction(pool, async (db) => {
    await db.query(
      "SELECT pg_advisory_xact_lock(hashtext('crewroom-members'))",
    );
    if ((await db.query("SELECT 1 FROM cr_members LIMIT 1")).rowCount)
      fail(409, "ALREADY_BOOTSTRAPPED", "첫 팀장은 이미 설정됐어요.");
    return createMember(db, values, "lead");
  });
}

export async function changePassword(
  pool,
  userId,
  currentPassword,
  nextPassword,
) {
  return transaction(pool, async (db) => {
    const user = (
      await db.query("SELECT * FROM cr_members WHERE id=$1 FOR UPDATE", [
        userId,
      ])
    ).rows[0];
    if (
      !user?.active ||
      !(await verifyPassword(currentPassword, user.password_hash))
    )
      fail(403, "PASSWORD_MISMATCH", "현재 비밀번호를 확인해주세요.");
    const encoded = await hashPassword(nextPassword);
    await db.query("UPDATE cr_members SET password_hash=$2 WHERE id=$1", [
      userId,
      encoded,
    ]);
    await db.query("DELETE FROM cr_sessions WHERE user_id=$1", [userId]);
    await event(db, null, { type: "user", id: userId }, "password_changed");
  });
}
export async function resetPassword(pool, email, password) {
  const encoded = await hashPassword(password);
  return transaction(pool, async (db) => {
    const user = (
      await db.query(
        "UPDATE cr_members SET password_hash=$2 WHERE email=$1 RETURNING id",
        [email.toLowerCase().trim(), encoded],
      )
    ).rows[0];
    if (!user) fail(404, "MEMBER_NOT_FOUND", "구성원을 찾을 수 없어요.");
    await db.query("DELETE FROM cr_sessions WHERE user_id=$1", [user.id]);
    await event(
      db,
      null,
      { type: "system", id: "operator-cli" },
      "password_reset",
      { memberId: user.id },
    );
    return { reset: true };
  });
}
