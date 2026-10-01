import assert from "node:assert/strict";
import { test, beforeEach } from "node:test";
import { createRequire } from "node:module";
import { state } from "../static/js/state.js";
import {
  loadStations,
  flushBackupNow,
  touchModified,
  recoverBrowserDraft,
  saveStations,
} from "../static/js/persistence.js";
import { getStationDefinitions } from "../static/js/stations.js";
const require = createRequire(import.meta.url);
const { initialize } = require("../tools/frontend_test_context.cjs");

beforeEach(async () => {
  await initialize();
});

test("custom station count and active session survive local reload", () => {
  state.settings.stationDefinitions = [
    { id: 7, name: "Custom", type: "switch" },
  ];
  localStorage.setItem(
    state.STORAGE_KEY,
    JSON.stringify([
      {
        id: 7,
        status: "running",
        startTime: 100,
        endTime: 200,
        activeSessionId: "session-7",
        tariffId: "sw_t1",
      },
    ]),
  );
  const stations = loadStations();
  assert.equal(stations.length, 1);
  assert.equal(stations[0].status, "running");
  assert.equal(stations[0].activeSessionId, "session-7");
  assert.equal(stations[0].stationType, "switch");
  assert.equal(getStationDefinitions()[0].name, "Custom");
});

test("acknowledgement keeps newer changes dirty until a second revision is accepted", async () => {
  state.lastModified = 10; state.dirtySinceFlush = true;
  const resolvers = []; const bodies = [];
  global.fetch = (_, options) => { bodies.push(JSON.parse(options.body)); return new Promise(done => resolvers.push(done)); };
  const operation = flushBackupNow();
  await Promise.resolve();
  state.lastModified = 11;
  resolvers[0]({ ok: true, json: async () => ({ ok: true, revision: 1 }) });
  while (resolvers.length < 2) await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.dirtySinceFlush, true);
  assert.equal(bodies[1].baseRevision, 1);
  assert.equal(bodies[1].lastModified, 11);
  resolvers[1]({ ok: true, json: async () => ({ ok: true, revision: 2 }) });
  assert.equal(await operation, true);
  assert.equal(state.dirtySinceFlush, false);
});

test("server-skipped backup stays dirty", async () => {
  state.dirtySinceFlush = true;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ ok: true, skipped: true }),
  });
  await flushBackupNow();
  assert.equal(state.dirtySinceFlush, true);
});

test("accepted current backup clears dirty state", async () => {
  state.dirtySinceFlush = true;
  global.fetch = async () => ({ ok: true, json: async () => ({ ok: true, revision: 1 }) });
  await flushBackupNow();
  assert.equal(state.dirtySinceFlush, false);
});

test("timestamps remain increasing when the system clock moves backwards", () => {
  state.lastModified = Date.now() + 100000;
  const previous = state.lastModified;
  touchModified();
  clearTimeout(state._flushTimer);
  state._flushTimer = null;
  assert.equal(state.lastModified, previous + 1);
});


test("lost response retries the same idempotency key before sending newer data", async () => {
  state.lastModified = 1; state.dirtySinceFlush = true;
  let sent;
  global.fetch = async (_, options) => { sent = options; throw new Error('lost response'); };
  assert.equal(await flushBackupNow(), false);
  const retryKeys = []; const values = [];
  state.lastModified = 2;
  global.fetch = async (_, options) => {
    retryKeys.push(options.headers['X-Idempotency-Key']); values.push(JSON.parse(options.body));
    return { ok: true, json: async () => ({ ok: true, revision: retryKeys.length }) };
  };
  assert.equal(await flushBackupNow(), true);
  assert.equal(retryKeys[0], sent.headers['X-Idempotency-Key']);
  assert.equal(values[0].lastModified, 1);
  assert.equal(values[1].lastModified, 2);
  assert.equal(state.serverRevision, 2);
});

test("revision conflict preserves unsaved changes and blocks further writes", async () => {
  state.dirtySinceFlush = true;
  let calls = 0;
  global.fetch = async () => { calls++; return { ok: false, status: 409, json: async () => ({ error: 'revision_conflict' }) }; };
  assert.equal(await flushBackupNow(), false);
  assert.equal(state.saveConflict, true);
  assert.equal(state.dirtySinceFlush, true);
  assert.equal(await flushBackupNow(), false);
  assert.equal(calls, 1);
});


test("after reload an uncertain snapshot reuses the original key and loads authoritative state", async () => {
  state.lastModified = 10; state.meta = { dirty: true, lastModified: 10 };
  const original = { key: 'original-request-key', userId: state.user.id, body: JSON.stringify({ baseRevision: 0, lastModified: 10 }), timestamp: 10 };
  localStorage.setItem('pslounge_pending_backup_v1', JSON.stringify(original));
  const snapshot = { revision: 1, stations: state.stations, sessions: state.sessions };
  let postKey;
  global.fetch = async (_, options = {}) => {
    if (options.method === 'POST') { postKey = options.headers['X-Idempotency-Key']; return { ok: true, json: async () => ({ ok: true, revision: 1 }) }; }
    return { ok: true, json: async () => snapshot };
  };
  const result = await recoverBrowserDraft(snapshot);
  assert.equal(result.unresolved, false);
  assert.equal(postKey, original.key);
  assert.equal(result.snapshot.revision, 1);
  assert.ok(localStorage.getItem('pslounge_recovery_draft_v1'));
});

test("cache quota failure does not prevent a server save", async () => {
  localStorage.setItem = () => { throw new Error('quota'); };
  assert.doesNotThrow(() => saveStations());
  clearTimeout(state._flushTimer); state._flushTimer = null;
  global.fetch = async () => ({ ok: true, json: async () => ({ ok: true, revision: 1 }) });
  assert.equal(await flushBackupNow(), true);
  assert.equal(state.dirtySinceFlush, false);
});
