import test from "node:test";
import assert from "node:assert/strict";
import { harness, waitFor } from "./helpers.js";
import { EventHub } from "../../server/event-hub.js";

test("shared notifications deliver a lower event ID that commits later and stay bounded", async (t) => {
  const h = await harness(t),
    hub = new EventHub(h.pool);
  await hub.start();
  h.cleanup.push(() => hub.close());
  const s = hub.subscribe(),
    c = await h.pool.connect();
  try {
    await c.query("BEGIN");
    const low = (
      await c.query(
        "INSERT INTO cr_events(actor_type,actor_id,type) VALUES('system','synthetic','first') RETURNING id",
      )
    ).rows[0].id;
    const high = (
      await h.pool.query(
        "INSERT INTO cr_events(actor_type,actor_id,type) VALUES('system','synthetic','second') RETURNING id",
      )
    ).rows[0].id;
    await waitFor(() => s.ids.has(high), Boolean);
    assert.equal(s.ids.has(low), false);
    hub.drain(s);
    await c.query("COMMIT");
    await waitFor(() => s.ids.has(low), Boolean);
    assert.deepEqual(hub.drain(s), [low]);
    await h.pool.query(
      "INSERT INTO cr_events(actor_type,actor_id,type) SELECT 'system','synthetic','burst' FROM generate_series(1,600)",
    );
    await waitFor(() => s.ids.size === 256, Boolean);
    assert.equal(hub.drain(s).length, 256);
  } finally {
    await c.query("ROLLBACK");
    c.release();
  }
});

test("listener reconnect changes epoch and resubscribes without treating notifications as durable state", async (t) => {
  const h = await harness(t),
    hub = new EventHub(h.pool);
  await hub.start();
  h.cleanup.push(() => hub.close());
  const initial = hub.epoch,
    s = hub.subscribe(),
    pid = (await hub.client.query("SELECT pg_backend_pid() AS pid")).rows[0]
      .pid;
  await h.pool.query("SELECT pg_terminate_backend($1)", [pid]);
  await waitFor(() => hub.epoch > initial && hub.client, Boolean, 7000);
  const id = (
    await h.pool.query(
      "INSERT INTO cr_events(actor_type,actor_id,type) VALUES('system','synthetic','after-reconnect') RETURNING id",
    )
  ).rows[0].id;
  await waitFor(() => s.ids.has(id), Boolean);
  hub.unsubscribe(s);
  assert.equal(hub.subscribers.size, 0);
});
