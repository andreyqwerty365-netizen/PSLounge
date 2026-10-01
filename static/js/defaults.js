import { ACHIEVEMENT_DEFINITIONS } from "./achievement-definitions.js";

export function createDefaults() {
  return {
    ASSETS_PS: {
      idle: "/static/assets/dualsense_idle.png",
      active: "/static/assets/dualsense_active.png",
      hint: "dualsense_idle.png / dualsense_active.png",
    },
    ASSETS_SIM: {
      idle: "/static/assets/racing_idle.png",
      active: "/static/assets/racing_idle.png",
      hint: "racing_idle.png",
    },
    ASSETS_SWITCH: {
      idle: "/static/assets/switch_idle.png",
      active: "/static/assets/switch_active.png",
      hint: "switch_idle.png / switch_active.png",
    },
    STATION_TYPES: {
      ps: { id: "ps", label: "PlayStation" },
      simulator: { id: "simulator", label: "Симулятор" },
      switch: { id: "switch", label: "Nintendo Switch" },
    },
    STORAGE_KEY: "pslounge_stations_v7",
    SESSIONS_KEY: "pslounge_sessions_v7",
    SETTINGS_KEY: "pslounge_settings_v3",
    ACHIEVEMENTS_KEY: "pslounge_achievements_v1",
    META_KEY: "pslounge_meta_v1",
    AUTOSAVE_INTERVAL_MS: 15000,
    RECOVERY_WINDOW_MINUTES: 10,
    PIN_GUARD_KEY: "pslounge_pin_guard_v1",
    DEFAULT_SETTINGS_PIN: "4826",
    PIN_MAX_ATTEMPTS: 3,
    PIN_LOCK_MS: 10 * 60 * 1000,
    TIME_JUMP_WARN_MS: 30 * 1000,
    TIME_JUMP_TOAST_COOLDOWN_MS: 2 * 60 * 1000,
    HISTORY_RETENTION_DAYS: 30,
    ACTION_LOG_KEY: "pslounge_action_log_v1",
    ACTION_LOG_MAX: 500,
    ACTION_GUARD_MS: 650,
    DEFAULT_GRACE_MINUTES: 10,
    DEFAULT_AUTO_CLOSE_OVERDUE_MINUTES: 10,
    DEFAULT_TARIFFS_PS: [
      { id: "ps_t1", label: "1 час", minutes: 60, price: 300 },
      { id: "ps_t2", label: "2 часа", minutes: 120, price: 600 },
      { id: "ps_t3", label: "3 часа", minutes: 180, price: 900 },
      { id: "ps_t4", label: "4 часа", minutes: 240, price: 1200 },
      { id: "ps_t5", label: "5 часов", minutes: 300, price: 1500 },
    ],
    DEFAULT_TARIFFS_SIMULATOR: [
      { id: "sim_t1", label: "30 минут", minutes: 30, price: 250 },
      { id: "sim_t2", label: "1 час", minutes: 60, price: 400 },
      { id: "sim_t3", label: "2 часа", minutes: 120, price: 750 },
    ],
    DEFAULT_TARIFFS_SWITCH: [
      { id: "sw_t1", label: "30 минут", minutes: 30, price: 200 },
      { id: "sw_t2", label: "1 час", minutes: 60, price: 300 },
      { id: "sw_t3", label: "2 часа", minutes: 120, price: 550 },
      { id: "sw_t4", label: "3 часа", minutes: 180, price: 750 },
    ],
    DEFAULT_CUSTOM_RATES: {
      ps: 300,
      simulator: 400,
      switch: 300,
    },
    DEFAULT_STATION_DEFINITIONS: [
      { id: 1, name: "PS1", type: "ps" },
      { id: 2, name: "PS2", type: "ps" },
      { id: 3, name: "PS3", type: "ps" },
      { id: 4, name: "PS4", type: "ps" },
      { id: 5, name: "Симулятор гонок", type: "simulator" },
      { id: 6, name: "Nintendo Switch", type: "switch" },
    ],
    PAYMENT_METHODS: [
      { id: "cash", label: "Наличные" },
      { id: "card", label: "Карта" },
      { id: "transfer", label: "Перевод" },
    ],
    ACHIEVEMENTS_BACKFILL_VERSION: 3,
    ACHIEVEMENT_BREAK_ACTIONS: new Set(["Отмена", "Восстановление"]),
    ACHIEVEMENT_DEFINITIONS: ACHIEVEMENT_DEFINITIONS,
  };
}
