import test from "node:test";
import assert from "node:assert/strict";
import { harness, password } from "./helpers.js";
import { resetPassword } from "../../server/auth.js";
test("password change requires current password and revokes all sessions; operator reset also revokes", async (t) => {
  const h = await harness(t),
    lead = await h.client("lead@example.com"),
    other = await h.client("lead@example.com");
  assert.equal(
    (
      await lead.request("POST", "/api/auth/password", {
        currentPassword: "wrong",
        nextPassword: "new-password-12345",
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await lead.request("POST", "/api/auth/password", {
        currentPassword: password,
        nextPassword: "new-password-12345",
      })
    ).statusCode,
    200,
  );
  assert.equal((await other.request("GET", "/api/workspace")).statusCode, 401);
  assert.equal(
    (
      await h.app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: {
          origin: h.config.origin,
          "content-type": "application/json",
        },
        payload: { email: "lead@example.com", password },
      })
    ).statusCode,
    401,
  );
  await resetPassword(h.pool, "lead@example.com", password);
  const fresh = await h.client("lead@example.com");
  await resetPassword(h.pool, "lead@example.com", "another-password-12345");
  assert.equal((await fresh.request("GET", "/api/workspace")).statusCode, 401);
});
