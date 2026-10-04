/* ALEX_CODEX_COMPACTION_V1 */
// This module is embedded in the desktop main bundle by patch.py.
function alexCreateCompactionQueue({ file, fs, client, report = console.error }) {
  let records = {};
  const running = new Map();
  const subscriptions = new Map();
  if (fs.existsSync(file)) records = JSON.parse(fs.readFileSync(file, "utf8"));
  const save = () => {
    fs.mkdirSync(require("node:path").dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file + ".tmp", JSON.stringify(records, null, 2), { mode: 0o600 });
    fs.renameSync(file + ".tmp", file);
  };
  const update = (id, state, error) => {
    records[id] = { ...records[id], state, updatedAt: new Date().toISOString(), ...(error ? { error } : {}) };
    save();
  };
  // An accepted request may have executed before a crash. Never replay it blindly.
  for (const [id, record] of Object.entries(records)) {
    if (record.state === "started") update(id, "interrupted", "Desktop exited before completion was observed; inspect the rollout before retrying.");
  }
  function subscribe(connection) {
    if (subscriptions.has(connection)) return;
    subscriptions.set(connection, connection.registerInternalNotificationHandler((event) => {
      const id = event.params?.threadId;
      if (!id || !records[id]) return;
      if (event.method === "item/completed" && event.params.item?.type === "contextCompaction" && records[id].state === "started") update(id, "completed");
      if (event.method === "turn/completed" && records[id].state === "started" && event.params.turn?.status !== "completed") update(id, "failed", event.params.turn?.error?.message ?? "Compaction turn did not complete");
      if (records[id].state === "queued" && ["turn/completed", "thread/status/changed"].includes(event.method)) {
        setImmediate(() => drain(id).catch(report));
      }
    }));
  }
  async function execute(id) {
    const record = records[id];
    const connection = client();
    subscribe(connection);
    let thread = await connection.readThread(id, { includeTurns: false });
    if (!thread) throw Error("Thread was not found");
    if (thread.status?.type === "notLoaded") {
      await connection.resumeThread(id);
      thread = await connection.readThread(id, { includeTurns: false });
    }
    if (thread.status?.type === "active") return { threadId: id, state: "queued" };
    if (thread.status?.type !== "idle") throw Error("Thread is not idle: " + thread.status?.type);
    // Record before admission so a restart cannot silently repeat an accepted RPC.
    update(id, "started");
    await connection.sendAppServerRequest("thread/compact/start", { threadId: id });
    return { threadId: id, state: "started", requestedAt: record.requestedAt };
  }
  function drain(id) {
    if (running.has(id)) return running.get(id);
    if (records[id]?.state !== "queued") return Promise.resolve({ threadId: id, state: records[id]?.state });
    const pending = execute(id).catch((error) => {
      update(id, "failed", String(error?.message ?? error));
      throw error;
    }).finally(() => running.delete(id));
    running.set(id, pending);
    return pending;
  }
  return {
    async request(id) {
      if (typeof id !== "string" || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) throw Error("A Codex thread UUID is required");
      if (["queued", "started"].includes(records[id]?.state)) return { threadId: id, state: records[id].state, duplicate: true };
      records[id] = { threadId: id, state: "queued", requestedAt: new Date().toISOString() };
      save();
      return drain(id);
    },
    restore() {
      for (const [id, record] of Object.entries(records)) if (record.state === "queued") drain(id).catch(report);
    },
  };
}
if (typeof module !== "undefined") module.exports = { alexCreateCompactionQueue };
