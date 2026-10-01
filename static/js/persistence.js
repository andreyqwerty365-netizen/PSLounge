import { getRecoverySnapshot } from "./session-recovery.js";
import { normalizeSettings } from "./settings-model.js";
import { state as appState } from "./state.js";
import {
  defaultStationDefinitions,
  defaultStations,
  getStationDefinitions,
  normalizeStationDefinition,
  normalizeStationDefinitions,
  syncStationsWithDefinitions,
} from "./stations.js";

export function loadMeta() {
  try {
    const raw = localStorage.getItem(appState.META_KEY);
    if (!raw) return { lastModified: 0 };
    const m = JSON.parse(raw);
    return m && typeof m === "object" && Number.isFinite(m.lastModified)
      ? m
      : { lastModified: 0 };
  } catch {
    return { lastModified: 0 };
  }
}

export function saveMeta(meta) {
  try {
    localStorage.setItem(appState.META_KEY, JSON.stringify(meta));
  } catch {}
}

export async function flushBackupNow() {
  if (appState._flushInFlight) {
    appState._flushRequested = true;
    return;
  }
  appState._flushInFlight = true;
  const sentLastModified = appState.lastModified;
  try {
    const res = await fetch("/api/backup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        lastModified: appState.lastModified,
        stations: appState.stations,
        sessions: appState.sessions,
        settings: appState.settings,
        achievements: appState.achievements,
      }),
    });
    const result = await res.json().catch(() => ({}));
    if (res.ok && result.ok === true && result.skipped !== true) {
      appState.dirtySinceFlush = appState.lastModified !== sentLastModified;
      appState.lastFlushSucceededAt = Date.now();
    }
  } catch {
    // ignore, offline/blocked; localStorage remains source of truth
  } finally {
    appState._flushInFlight = false;
    if (appState._flushRequested) {
      appState._flushRequested = false;
      // fire again once
      flushBackupNow();
    }
  }
}

export function scheduleFlush(immediate = false) {
  if (immediate) {
    if (appState._flushTimer) {
      clearTimeout(appState._flushTimer);
      appState._flushTimer = null;
    }
    flushBackupNow();
    return;
  }
  if (appState._flushTimer) return;
  appState._flushTimer = setTimeout(() => {
    appState._flushTimer = null;
    flushBackupNow();
  }, 400);
}

export function touchModified(immediate = false) {
  appState.lastModified = Math.max(Date.now(), appState.lastModified + 1);
  appState.dirtySinceFlush = true;
  saveMeta({ lastModified: appState.lastModified });
  scheduleFlush(immediate);
}

export function loadStations() {
  try {
    const raw = localStorage.getItem(appState.STORAGE_KEY);
    if (!raw) return defaultStations();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return defaultStations();
    maybeMigrateStationDefinitionsFromLegacyStations(parsed);
    return syncStationsWithDefinitions(parsed, getStationDefinitions());
  } catch {
    return defaultStations();
  }
}

export function saveStations(immediate = false) {
  localStorage.setItem(appState.STORAGE_KEY, JSON.stringify(appState.stations));
  touchModified(immediate);
}

export function areDefaultStationDefinitions(defs) {
  const normalized = normalizeStationDefinitions(defs);
  const base = defaultStationDefinitions();
  if (normalized.length !== base.length) return false;
  return normalized.every(
    (item, idx) =>
      item.id === base[idx].id &&
      item.name === base[idx].name &&
      item.type === base[idx].type,
  );
}

export function maybeMigrateStationDefinitionsFromLegacyStations(parsed) {
  if (!Array.isArray(parsed) || !parsed.length) return;
  if (!areDefaultStationDefinitions(appState.settings?.stationDefinitions))
    return;
  const defs = parsed.map((item, idx) =>
    normalizeStationDefinition(
      {
        id: Number.isFinite(Number(item?.id)) ? Number(item.id) : idx + 1,
        name:
          typeof item?.name === "string"
            ? item.name
            : defaultStationDefinitions()[idx]?.name,
        type:
          String(item?.stationType || "")
            .trim()
            .toLowerCase() ||
          (Number(item?.id) === 5
            ? "simulator"
            : Number(item?.id) === 6
              ? "switch"
              : "ps"),
      },
      idx,
    ),
  );
  if (!defs.length) return;
  appState.settings.stationDefinitions = normalizeStationDefinitions(defs);
  localStorage.setItem(
    appState.SETTINGS_KEY,
    JSON.stringify(normalizeSettings(appState.settings)),
  );
}

export function loadSessions() {
  try {
    const raw = localStorage.getItem(appState.SESSIONS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};

    for (const key of Object.keys(parsed)) {
      const list = Array.isArray(parsed[key]) ? parsed[key] : [];
      parsed[key] = list.map((rec) => {
        const item = rec && typeof rec === "object" ? rec : {};
        const totalAmount = Number(item.totalAmount);
        const paymentMethod =
          typeof item.paymentMethod === "string" ? item.paymentMethod : "cash";
        const sales = Array.isArray(item.sales)
          ? item.sales.map((sale) => ({
              id:
                typeof sale?.id === "string"
                  ? sale.id
                  : `sale_${Math.random().toString(16).slice(2)}`,
              time: Number.isFinite(sale?.time)
                ? sale.time
                : Number.isFinite(item.startTime)
                  ? item.startTime
                  : Date.now(),
              type: typeof sale?.type === "string" ? sale.type : "sale",
              label: typeof sale?.label === "string" ? sale.label : "Продажа",
              minutes: Number.isFinite(Number(sale?.minutes))
                ? Math.round(Number(sale.minutes))
                : 0,
              amount: Math.max(0, Math.round(Number(sale?.amount) || 0)),
              paymentMethod:
                typeof sale?.paymentMethod === "string"
                  ? sale.paymentMethod
                  : paymentMethod,
            }))
          : [];
        const safeTotal = Number.isFinite(totalAmount)
          ? Math.max(0, Math.round(totalAmount))
          : 0;
        if (!sales.length && safeTotal > 0) {
          sales.push({
            id: `sale_legacy_${Math.random().toString(16).slice(2)}`,
            time: Number.isFinite(item.startTime) ? item.startTime : Date.now(),
            type: "legacy",
            label: "Продажа",
            minutes: 0,
            amount: safeTotal,
            paymentMethod,
          });
        }
        return {
          ...item,
          totalAmount: sales.reduce(
            (sum, sale) => sum + (Number(sale.amount) || 0),
            0,
          ),
          paymentMethod,
          sales,
        };
      });
    }
    return parsed;
  } catch {
    return {};
  }
}

export function saveSessions(immediate = false) {
  localStorage.setItem(
    appState.SESSIONS_KEY,
    JSON.stringify(appState.sessions),
  );
  touchModified(immediate);
}

export function startAutoSave() {
  if (startAutoSave._timer) return;
  startAutoSave._timer = setInterval(() => {
    if (appState.dirtySinceFlush) scheduleFlush(true);
    for (const station of appState.stations) getRecoverySnapshot(station);
  }, appState.AUTOSAVE_INTERVAL_MS);
}
