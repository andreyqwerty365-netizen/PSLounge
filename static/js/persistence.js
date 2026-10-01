import { storage } from "./storage.js";
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

const PENDING_KEY = 'pslounge_pending_backup_v1';
const RECOVERY_KEY = 'pslounge_recovery_draft_v1';

export async function recoverBrowserDraft(snapshot) {
  if (!appState.meta?.dirty || !snapshot?.stations) return { snapshot, unresolved: false };
  // Preserve evidence before any server-authoritative replacement of browser state.
  storage.setItem(RECOVERY_KEY, JSON.stringify({ savedAt: Date.now(), meta: appState.meta,
    stations: appState.stations, sessions: appState.sessions, settings: appState.settings,
    achievements: appState.achievements }));
  let pending;
  try { pending = JSON.parse(storage.getItem(PENDING_KEY)); } catch {}
  if (!pending || pending.userId !== appState.user?.id) {
    appState.dirtySinceFlush = true;
    appState.saveConflict = true;
    appState.saveFailed = true;
    saveStatus('Найдены несохранённые изменения. Скачайте копию и загрузите состояние базы.', true);
    return { snapshot, unresolved: true };
  }
  appState.pendingBackup = pending;
  appState.dirtySinceFlush = true;
  if (!(await flushBackupNow())) return { snapshot, unresolved: true };
  const response = await fetch('/api/backup', { cache: 'no-store' });
  if (!response.ok) {
    appState.saveFailed = true;
    saveStatus('Не удалось загрузить состояние после восстановления сохранения.', true);
    return { snapshot, unresolved: true };
  }
  return { snapshot: await response.json(), unresolved: false };
}

export function loadMeta() {
  try {
    const raw = storage.getItem(appState.META_KEY);
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
    storage.setItem(appState.META_KEY, JSON.stringify(meta));
  } catch {}
}

export function saveStatus(message, failed = false) {
  const label = typeof document !== 'undefined' ? document.getElementById('saveStatus') : null;
  if (label) { label.textContent = message; label.classList.toggle('is-error', failed); }
  if (typeof document !== 'undefined') {
    for (const id of ['btnRetrySave', 'btnDownloadUnsaved']) {
      const button = document.getElementById(id); if (button) button.hidden = !failed;
    }
    const reload = document.getElementById('btnReloadState'); if (reload) reload.hidden = !appState.saveConflict;
  }
}

export function applyServerState(snapshot) {
  appState.serverRevision = Number(snapshot?.revision) || 0;
  if (Array.isArray(snapshot?.stations) && snapshot?.sessions) {
    appState.settings = normalizeSettings(snapshot.settings || appState.settings);
    appState.stations = syncStationsWithDefinitions(snapshot.stations, getStationDefinitions(appState.settings));
    appState.sessions = snapshot.sessions;
    if (snapshot.achievements) appState.achievements = snapshot.achievements;
    appState.lastModified = Number(snapshot.lastModified) || 0;
    for (const [key, value] of [[appState.STORAGE_KEY, appState.stations],
      [appState.SESSIONS_KEY, appState.sessions], [appState.SETTINGS_KEY, appState.settings],
      [appState.ACHIEVEMENTS_KEY, appState.achievements]]) storage.setItem(key, JSON.stringify(value));
    saveMeta({ lastModified: appState.lastModified, dirty: false, revision: appState.serverRevision });
  }
  appState.dirtySinceFlush = false;
  appState.saveConflict = false;
  appState.saveFailed = false;
  appState.pendingBackup = null;
  storage.removeItem(PENDING_KEY);
  saveStatus('Сохранено на компьютере');
}

export async function flushBackupNow() {
  if (appState._flushPromise) return appState._flushPromise;
  if (!appState.user || appState.saveConflict) return false;
  if (!appState.dirtySinceFlush && !appState.pendingBackup && !appState.saveFailed && appState.serverRevision > 0) return true;
  // Capture the complete action after all synchronous mutations finish.
  appState._flushPromise = Promise.resolve().then(async () => {
    appState._flushInFlight = true;
    try {
      do {
        if (!appState.pendingBackup) {
          const body = { baseRevision: appState.serverRevision, lastModified: appState.lastModified,
            stations: appState.stations, sessions: appState.sessions, settings: appState.settings,
            achievements: appState.achievements };
          appState.pendingBackup = { key: globalThis.crypto?.randomUUID?.() || `snapshot-${Date.now()}-${Math.random().toString(36).slice(2)}`, userId: appState.user.id,
            body: JSON.stringify(body), timestamp: appState.lastModified };
          storage.setItem(PENDING_KEY, JSON.stringify(appState.pendingBackup));
        }
        const pending = appState.pendingBackup;
        saveStatus('Сохранение…');
        const res = await fetch('/api/backup', { method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-PSLounge-CSRF': appState.csrf,
            'X-Idempotency-Key': pending.key }, body: pending.body });
        const result = await res.json().catch(() => ({}));
        if (!res.ok || !result.ok || result.skipped || !Number.isInteger(result.revision)) {
          appState.saveConflict = ['revision_conflict', 'payment_immutable', 'session_immutable', 'tariff_price_changed'].includes(result.error);
          appState.saveFailed = true;
          // Validation errors were not committed; ambiguous network/5xx retain their key.
          if (res.status && res.status < 500) { appState.pendingBackup = null; storage.removeItem(PENDING_KEY); }
          saveStatus(appState.saveConflict ? 'Конфликт данных. Скачайте несохранённые изменения и обновите страницу.' :
            'Не сохранено. Проверьте вход и соединение, затем повторите.', true);
          return false;
        }
        appState.serverRevision = result.revision;
        appState.pendingBackup = null;
        storage.removeItem(PENDING_KEY);
        appState.saveFailed = false;
        appState.dirtySinceFlush = appState.lastModified !== pending.timestamp;
        appState.lastFlushSucceededAt = Date.now();
        saveMeta({ lastModified: appState.lastModified, dirty: appState.dirtySinceFlush, revision: appState.serverRevision });
      } while (appState.dirtySinceFlush);
      saveStatus('Сохранено на компьютере');
      return true;
    } catch {
      appState.saveFailed = true;
      saveStatus('Не сохранено. Соединение недоступно — повторите сохранение.', true);
      return false;
    } finally {
      appState._flushInFlight = false;
      appState._flushPromise = null;
    }
  });
  return appState._flushPromise;
}

export function scheduleFlush(immediate = false) {
  if (!appState.user || appState.saveConflict) return;
  if (immediate && appState._flushTimer) { clearTimeout(appState._flushTimer); appState._flushTimer = null; }
  if (appState._flushTimer) return;
  appState._flushTimer = setTimeout(() => {
    appState._flushTimer = null;
    flushBackupNow();
  }, immediate ? 0 : 400);
}

export function touchModified(immediate = false) {
  appState.lastModified = Math.max(Date.now(), appState.lastModified + 1);
  appState.dirtySinceFlush = true;
  saveMeta({ lastModified: appState.lastModified, dirty: true, revision: appState.serverRevision });
  saveStatus("Есть несохранённые изменения");
  scheduleFlush(immediate);
}

export function loadStations() {
  try {
    const raw = storage.getItem(appState.STORAGE_KEY);
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
  storage.setItem(appState.STORAGE_KEY, JSON.stringify(appState.stations));
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
  storage.setItem(
    appState.SETTINGS_KEY,
    JSON.stringify(normalizeSettings(appState.settings)),
  );
}

export function loadSessions() {
  try {
    const raw = storage.getItem(appState.SESSIONS_KEY);
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
              ...sale,
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
              amount: Math.max(0, Math.round((Number(sale?.amount) || 0) * 100) / 100),
              paymentMethod:
                typeof sale?.paymentMethod === "string"
                  ? sale.paymentMethod
                  : paymentMethod,
            }))
          : [];
        const safeTotal = Number.isFinite(totalAmount)
          ? Math.max(0, Math.round(totalAmount * 100) / 100)
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
            (sum, sale) => sum + Math.round((Number(sale.amount) || 0) * 100),
            0,
          ) / 100,
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
  storage.setItem(
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
