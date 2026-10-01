import assert from "node:assert/strict";
import { test, beforeEach } from "node:test";
import { createRequire } from "node:module";
import { state } from "../static/js/state.js";
import {
  loadStations,
  flushBackupNow,
  touchModified,
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

test("HTTP acknowledgement of an older request does not clear new unsaved changes", async () => {
  state.lastModified = 10;
  state.dirtySinceFlush = true;
  let resolve;
  global.fetch = () =>
    new Promise((done) => {
      resolve = done;
    });
  const operation = flushBackupNow();
  state.lastModified = 11;
  resolve({ ok: true, json: async () => ({ ok: true }) });
  await operation;
  assert.equal(state.dirtySinceFlush, true);
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
  global.fetch = async () => ({ ok: true, json: async () => ({ ok: true }) });
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
