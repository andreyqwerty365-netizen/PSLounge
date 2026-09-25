"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const appPath = path.join(__dirname, "..", "static", "app.js");
const source = fs.readFileSync(appPath, "utf8");
const start = source.indexOf("function normalizeStationDefinitions(");
const end = source.indexOf("function getStationDefinitions(", start);

assert.ok(start >= 0 && end > start, "normalizeStationDefinitions was not found");

const context = {
  normalizeStationDefinition: (item) => ({ ...item }),
  sortStationDefinitions: (list) => [...list].sort((a, b) => a.id - b.id),
  defaultStationDefinitions: () => [],
};
vm.createContext(context);
vm.runInContext(source.slice(start, end), context);

const savedOrder = [
  { id: 3, name: "PS3", type: "ps" },
  { id: 1, name: "PS1", type: "ps" },
  { id: 6, name: "Nintendo Switch", type: "switch" },
];
const normalized = context.normalizeStationDefinitions(savedOrder);

assert.deepEqual(
  Array.from(normalized, (item) => item.id),
  [3, 1, 6],
  "Saved station order must be preserved",
);

console.log("[ok] saved station order is preserved");
