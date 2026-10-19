// NOTIFY is a wake-up signal, never an authorization decision or durable cursor.
// A single listener serves all browsers; bounded ID batches are reauthorized by SQL.
export class EventHub {
  constructor(pool) {
    this.pool = pool;
    this.subscribers = new Set();
    this.epoch = 0;
    this.stopped = false;
    this.retry = null;
    this.client = null;
    this.starting = null;
  }
  async start() {
    if (this.stopped || this.client || this.starting) return this.starting;
    this.starting = (async () => {
      let client;
      try {
        client = await this.pool.connect();
        const schema = (await client.query("SELECT current_schema() AS name"))
          .rows[0].name;
        client.on("error", () => this.disconnect(client));
        client.on("end", () => this.disconnect(client));
        client.on("notification", (n) => {
          if (this.stopped || this.client !== client) return;
          try {
            const p = JSON.parse(n.payload);
            if (p.schema !== schema || !/^[1-9]\d*$/.test(p.id)) return;
            for (const s of this.subscribers) {
              s.ids.add(p.id);
              if (s.ids.size > 256) s.ids.delete(s.ids.values().next().value);
            }
          } catch {}
        });
        await client.query("LISTEN crewroom_events_v1");
        if (this.stopped) {
          client.release(true);
          return;
        }
        this.client = client;
        this.epoch++;
      } catch {
        if (client) client.release(true);
        this.reconnect();
      } finally {
        this.starting = null;
      }
    })();
    return this.starting;
  }
  disconnect(client) {
    if (this.client !== client) return;
    this.client = null;
    this.epoch++;
    client.release(true);
    this.reconnect();
  }
  reconnect() {
    if (this.stopped || this.retry) return;
    this.retry = setTimeout(() => {
      this.retry = null;
      this.start();
    }, 1000);
    this.retry.unref();
  }
  subscribe() {
    const s = { ids: new Set() };
    this.subscribers.add(s);
    return s;
  }
  unsubscribe(s) {
    this.subscribers.delete(s);
  }
  drain(s) {
    const ids = [...s.ids];
    s.ids.clear();
    return ids;
  }
  async close() {
    this.stopped = true;
    clearTimeout(this.retry);
    await this.starting;
    const c = this.client;
    this.client = null;
    if (c) {
      await c.query("UNLISTEN crewroom_events_v1").catch(() => {});
      c.release();
    }
    this.subscribers.clear();
  }
}
