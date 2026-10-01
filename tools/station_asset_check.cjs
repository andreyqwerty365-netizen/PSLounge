"use strict";
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { initialize } = require("./frontend_test_context.cjs");
(async () => {
  await initialize();
  const { assetsForStation } = await import("../static/js/stations.js");
  const hash = (type) => {
    const file = assetsForStation({ stationType: type }).active;
    return crypto
      .createHash("sha256")
      .update(fs.readFileSync(path.join(__dirname, "..", file)))
      .digest("hex");
  };
  assert.notEqual(hash("simulator"), hash("switch"));
  console.log("[ok] simulator and Nintendo Switch active images are distinct");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
