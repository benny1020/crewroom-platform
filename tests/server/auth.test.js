import test from "node:test";
import assert from "node:assert/strict";
import { harness, password } from "./helpers.js";

test("registration requests a role, never grants it; secure session and origin/CSRF checks apply", async (t) => {
  const h = await harness(t),
    lead = await h.client("lead@example.com"),
    member = await h.client("member@example.com", true);
  assert.equal(member.user.role, "member");
  assert.equal(member.user.leadRequested, true);
  assert.equal(
    (await member.request("GET", "/api/admin/audit")).statusCode,
    403,
  );
  const session = await h.app.inject({
    url: "/api/auth/session",
    headers: { cookie: member.cookie },
  });
  assert.equal(session.statusCode, 200);
  assert.equal(session.json().csrfToken, member.csrf);
  assert.equal(
    (
      await member.request(
        "POST",
        "/api/auth/logout",
        {},
        { origin: "http://attacker.example" },
      )
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await member.request(
        "POST",
        "/api/auth/logout",
        {},
        { "x-csrf-token": "wrong" },
      )
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await lead.request("PATCH", `/api/members/${lead.user.id}`, {
        role: "member",
        department: "development",
        active: true,
      })
    ).json().code,
    "LAST_LEAD",
  );
  assert.equal(
    (
      await lead.request("PATCH", `/api/members/${member.user.id}`, {
        role: "lead",
        department: "qa",
        active: true,
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (await member.request("GET", "/api/admin/audit")).statusCode,
    200,
  );
  assert.equal(
    (
      await lead.request("PATCH", `/api/members/${member.user.id}`, {
        role: "member",
        department: "qa",
        active: false,
      })
    ).statusCode,
    200,
  );
  assert.equal((await member.request("GET", "/api/workspace")).statusCode, 401);
});
test("unknown accounts and bad passwords share a generic response and login is rate limited", async (t) => {
  const h = await harness(t);
  const login = async (email) =>
    h.app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { origin: h.config.origin, "content-type": "application/json" },
      payload: { email, password: "wrong-passphrase" },
    });
  assert.equal(
    (await login("lead@example.com")).body,
    (await login("unknown@example.com")).body,
  );
  for (let i = 0; i < 14; i++) await login("unknown@example.com");
  assert.equal((await login("unknown@example.com")).statusCode, 429);
  const forbidden = await h.app.inject({
    method: "POST",
    url: "/api/auth/register",
    headers: { origin: h.config.origin, "content-type": "application/json" },
    payload: {
      email: "outsider@example.com",
      name: "외부",
      department: "qa",
      password,
    },
  });
  assert.equal(forbidden.statusCode, 403);
  assert.ok(!forbidden.body.includes("password_hash"));
});
test("member password hashes and session secrets are absent from workspace projections", async (t) => {
  const h = await harness(t),
    lead = await h.client("lead@example.com"),
    member = await h.client("member@example.com", true);
  const response = await member.request("GET", "/api/workspace");
  assert.equal(response.statusCode, 200);
  assert.ok(!response.body.includes("password_hash"));
  assert.ok(!response.body.includes("csrf_hash"));
  assert.equal(
    response.json().members.find((m) => m.id === lead.user.id).email,
    undefined,
  );
});
