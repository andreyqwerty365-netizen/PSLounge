import { storage } from "./storage.js";
import { touchModified } from "./persistence.js";
import { hashPin } from "./settings-access.js";
import { state as appState } from "./state.js";
import {
  defaultStationDefinitions,
  getStationDefinitions,
  getStationType,
  normalizeStationDefinitions,
} from "./stations.js";

export function makeTariffId(prefix = "tariff") {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
}

export function normalizeTariff(raw, fallbackIndex = 0, prefix = "tariff") {
  const item = raw && typeof raw === "object" ? raw : {};
  const minutes = Math.max(10, Math.round(Number(item.minutes) || 0));
  const price = Math.max(0, Math.round(Number(item.price) || 0));
  const label =
    typeof item.label === "string" && item.label.trim()
      ? item.label.trim()
      : `${Math.max(1, Math.round(minutes / 60))} ч`;
  return {
    id:
      typeof item.id === "string" && item.id.trim()
        ? item.id.trim()
        : `${prefix}_${fallbackIndex + 1}`,
    label,
    minutes,
    price,
  };
}

export function sortTariffs(list) {
  return [...list].sort((a, b) => {
    const minDiff = (a.minutes || 0) - (b.minutes || 0);
    if (minDiff !== 0) return minDiff;
    const priceDiff = (a.price || 0) - (b.price || 0);
    if (priceDiff !== 0) return priceDiff;
    const labelA = String(a.label || "")
      .trim()
      .toLocaleLowerCase("ru");
    const labelB = String(b.label || "")
      .trim()
      .toLocaleLowerCase("ru");
    return labelA.localeCompare(labelB, "ru");
  });
}

export function defaultTariffGroups() {
  return {
    ps: appState.DEFAULT_TARIFFS_PS.map((t, idx) =>
      normalizeTariff(t, idx, "ps"),
    ),
    simulator: appState.DEFAULT_TARIFFS_SIMULATOR.map((t, idx) =>
      normalizeTariff(t, idx, "sim"),
    ),
    switch: appState.DEFAULT_TARIFFS_SWITCH.map((t, idx) =>
      normalizeTariff(t, idx, "sw"),
    ),
  };
}

export function normalizeSettings(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const base = {
    tariffGroups: defaultTariffGroups(),
    customRates: { ...appState.DEFAULT_CUSTOM_RATES },
    stationDefinitions: defaultStationDefinitions(),
    graceMinutes: appState.DEFAULT_GRACE_MINUTES,
    overdueMinutes: appState.DEFAULT_AUTO_CLOSE_OVERDUE_MINUTES,
    currency: "RUB",
    currencySymbol: "₽",
    pinHash: hashPin(appState.DEFAULT_SETTINGS_PIN),
    notificationSound: false,
  };

  if (Array.isArray(src.tariffs)) {
    const migrated = sortTariffs(
      src.tariffs
        .map((t, idx) => normalizeTariff(t, idx, "ps"))
        .filter((t) => Number.isFinite(t.minutes) && t.minutes >= 10),
    );
    if (migrated.length) {
      base.tariffGroups.ps = migrated.map((t, idx) =>
        normalizeTariff({ ...t, id: `ps_${idx + 1}` }, idx, "ps"),
      );
      base.tariffGroups.simulator = migrated.map((t, idx) =>
        normalizeTariff({ ...t, id: `sim_${idx + 1}` }, idx, "sim"),
      );
      base.tariffGroups.switch = migrated.map((t, idx) =>
        normalizeTariff({ ...t, id: `sw_${idx + 1}` }, idx, "sw"),
      );
    }
  }
  if (src.tariffGroups && typeof src.tariffGroups === "object") {
    for (const type of ["ps", "simulator", "switch"]) {
      const rawList = Array.isArray(src.tariffGroups[type])
        ? src.tariffGroups[type]
        : null;
      if (rawList && rawList.length) {
        base.tariffGroups[type] = sortTariffs(
          rawList
            .map((t, idx) => normalizeTariff(t, idx, type))
            .filter((t) => Number.isFinite(t.minutes) && t.minutes >= 10),
        );
      }
    }
  }

  if (Array.isArray(src.stationDefinitions)) {
    base.stationDefinitions = normalizeStationDefinitions(
      src.stationDefinitions,
    );
  }

  const legacyRate = Number(src.customRatePerHour);
  if (Number.isFinite(legacyRate) && legacyRate >= 0) {
    base.customRates.ps = Math.round(legacyRate);
    base.customRates.simulator = Math.round(legacyRate);
    base.customRates.switch = Math.round(legacyRate);
  }
  if (src.customRates && typeof src.customRates === "object") {
    for (const type of ["ps", "simulator", "switch"]) {
      const rate = Number(src.customRates[type]);
      if (Number.isFinite(rate) && rate >= 0)
        base.customRates[type] = Math.round(rate);
    }
  }

  const graceMinutes = Number(src.graceMinutes);
  if (Number.isFinite(graceMinutes) && graceMinutes >= 0)
    base.graceMinutes = Math.round(graceMinutes);
  const overdueMinutes = Number(src.overdueMinutes);
  if (Number.isFinite(overdueMinutes) && overdueMinutes >= 0)
    base.overdueMinutes = Math.round(overdueMinutes);

  const pinHash =
    typeof src.pinHash === "string" && src.pinHash.trim()
      ? src.pinHash.trim()
      : "";
  if (pinHash) base.pinHash = pinHash;
  else if (
    src.security &&
    typeof src.security === "object" &&
    typeof src.security.pinHash === "string" &&
    src.security.pinHash.trim()
  )
    base.pinHash = src.security.pinHash.trim();

  if (typeof src.notificationSound === "boolean")
    base.notificationSound = src.notificationSound;
  else if (
    src.notifications &&
    typeof src.notifications === "object" &&
    typeof src.notifications.sound === "boolean"
  )
    base.notificationSound = src.notifications.sound;

  return base;
}

export function defaultSettings() {
  return normalizeSettings({});
}

export function loadSettings() {
  try {
    const raw = storage.getItem(appState.SETTINGS_KEY);
    if (raw) return normalizeSettings(JSON.parse(raw));
  } catch {}
  try {
    const legacyRaw = storage.getItem("pslounge_settings_v1");
    if (legacyRaw) return normalizeSettings(JSON.parse(legacyRaw));
  } catch {}
  return defaultSettings();
}

export function saveSettings(immediate = false) {
  appState.settings = normalizeSettings(appState.settings);
  storage.setItem(
    appState.SETTINGS_KEY,
    JSON.stringify(appState.settings),
  );
  touchModified(immediate);
}

export function ensureSelectedTariffs() {
  if (
    !appState.selectedTariffIds ||
    typeof appState.selectedTariffIds !== "object"
  )
    appState.selectedTariffIds = {};
  for (const type of ["ps", "simulator", "switch"]) {
    const list = appState.settings.tariffGroups?.[type] || [];
    if (!list.length) {
      appState.selectedTariffIds[type] = null;
      continue;
    }
    if (!list.find((t) => t.id === appState.selectedTariffIds[type]))
      appState.selectedTariffIds[type] = list[0].id;
  }
}

export function getTariffs(stationType = "ps") {
  return appState.settings.tariffGroups?.[stationType] || [];
}

export function getSelectedStationType() {
  if (appState.selectedStationId != null) {
    const s = appState.stations.find(
      (x) => x.id === appState.selectedStationId,
    );
    if (s) return getStationType(s);
  }
  return getStationDefinitions()[0]?.type || "ps";
}

export function getCurrentTariffs() {
  return getTariffs(getSelectedStationType());
}
