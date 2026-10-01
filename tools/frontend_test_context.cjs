"use strict";

exports.initialize = async function initialize() {
  const values = new Map();
  global.localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
  global.document = { getElementById: () => null, querySelectorAll: () => [] };
  const { initializeState, state } = await import("../static/js/state.js");
  initializeState();
  return state;
};
