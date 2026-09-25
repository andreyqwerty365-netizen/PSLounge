"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const appPath = path.join(__dirname, "..", "static", "app.js");
const source = fs.readFileSync(appPath, "utf8");
const match = source.match(/const ACHIEVEMENT_BREAK_ACTIONS = new Set\((\[[^;]+\])\);/u);

assert.ok(match, "ACHIEVEMENT_BREAK_ACTIONS declaration was not found");
const actions = new Set(vm.runInNewContext(match[1]));

assert.ok(actions.has("Отмена"), "Undo must break the clean achievement streak");
assert.ok(actions.has("Восстановление"), "Session restore must break the clean achievement streak");
assert.equal(actions.size, 2, "Only undo and restore should break the clean achievement streak");

console.log("[ok] achievement break actions are encoded and matched correctly");
