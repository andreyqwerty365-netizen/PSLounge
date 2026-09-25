"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const source = fs.readFileSync(path.join(root, "static", "app.js"), "utf8");

function activeAssetFor(constantName) {
  const match = source.match(new RegExp(`const ${constantName} = \\{[\\s\\S]*?active: '([^']+)'`));
  assert.ok(match, `${constantName}.active was not found`);
  return path.join(root, match[1].replace(/^\/static\//, "static/"));
}

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

const simulatorActive = activeAssetFor("ASSETS_SIM");
const switchActive = activeAssetFor("ASSETS_SWITCH");

assert.notEqual(
  sha256(simulatorActive),
  sha256(switchActive),
  "Racing simulator active image must not contain the Nintendo Switch artwork",
);

console.log("[ok] simulator and Nintendo Switch active images are distinct");
