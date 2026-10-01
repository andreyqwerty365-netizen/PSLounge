"use strict";
const assert = require("node:assert/strict");
const { initialize } = require("./frontend_test_context.cjs");
(async () => {
  await initialize();
  const { normalizeStationDefinitions } =
    await import("../static/js/stations.js");
  const saved = [
    { id: 3, name: "PS3", type: "ps" },
    { id: 1, name: "PS1", type: "ps" },
    { id: 6, name: "Nintendo Switch", type: "switch" },
  ];
  assert.deepEqual(
    normalizeStationDefinitions(saved).map((item) => item.id),
    [3, 1, 6],
  );
  console.log("[ok] saved station order is preserved");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
