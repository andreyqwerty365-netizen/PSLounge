"use strict";
const assert = require("node:assert/strict");
const { initialize } = require("./frontend_test_context.cjs");
(async () => {
  const state = await initialize();
  assert.ok(state.ACHIEVEMENT_BREAK_ACTIONS.has("Отмена"));
  assert.ok(state.ACHIEVEMENT_BREAK_ACTIONS.has("Восстановление"));
  assert.equal(state.ACHIEVEMENT_BREAK_ACTIONS.size, 2);
  console.log(
    "[ok] achievement break actions are encoded and matched correctly",
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
