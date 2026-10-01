import { addActionLog, rejectAction } from "./journal.js";
import { saveSessions, saveStations } from "./persistence.js";
import { renderSessions } from "./reports.js";
import { getActiveSessionRecord, todayKey } from "./sessions.js";
import { state as appState } from "./state.js";
import { getStationType, normalizeStationName } from "./stations.js";
import { renderStations, syncControl } from "./ui-rendering.js";
import { hhmm, toast } from "./ui-utils.js";

export function cloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

export function normalizeRecoverySnapshot(raw) {
  if (!raw || typeof raw !== "object") return null;
  const stationState =
    raw.stationState && typeof raw.stationState === "object"
      ? raw.stationState
      : null;
  const sessionRecord =
    raw.sessionRecord && typeof raw.sessionRecord === "object"
      ? raw.sessionRecord
      : null;
  const expiresAt = Number(raw.expiresAt);
  if (!stationState || !sessionRecord || !Number.isFinite(expiresAt))
    return null;
  return {
    version: 1,
    storedAt: Number.isFinite(Number(raw.storedAt))
      ? Number(raw.storedAt)
      : Date.now(),
    expiresAt,
    sessionDayKey:
      typeof raw.sessionDayKey === "string" ? raw.sessionDayKey : todayKey(),
    stationState: {
      status: ["running", "grace", "overdue"].includes(stationState.status)
        ? stationState.status
        : "running",
      startTime: Number.isFinite(stationState.startTime)
        ? stationState.startTime
        : null,
      endTime: Number.isFinite(stationState.endTime)
        ? stationState.endTime
        : null,
      tariffId:
        typeof stationState.tariffId === "string"
          ? stationState.tariffId
          : null,
      activeSessionId:
        typeof stationState.activeSessionId === "string"
          ? stationState.activeSessionId
          : null,
    },
    sessionRecord: cloneJson(sessionRecord),
  };
}

export function getRecoverySnapshot(station) {
  const snap = normalizeRecoverySnapshot(station?.lastClosedSnapshot);
  if (!snap) return null;
  if (Date.now() > snap.expiresAt) {
    station.lastClosedSnapshot = null;
    saveStations(true);
    return null;
  }
  return snap;
}

export function buildRecoverySnapshot(station) {
  const rec = getActiveSessionRecord(station);
  if (!rec || !station?.activeSessionId) return null;
  return {
    version: 1,
    storedAt: Date.now(),
    expiresAt: Date.now() + appState.RECOVERY_WINDOW_MINUTES * 60 * 1000,
    sessionDayKey: station.startTime ? todayKey(station.startTime) : todayKey(),
    stationState: {
      status: station.status,
      startTime: station.startTime,
      endTime: station.endTime,
      tariffId: station.tariffId,
      activeSessionId: station.activeSessionId,
    },
    sessionRecord: cloneJson(rec),
  };
}

export function clearRecoverySnapshot(station, persist = true) {
  if (!station) return;
  station.lastClosedSnapshot = null;
  if (persist) saveStations(true);
}

export function validateRecoverySnapshotForRestore(station, snap) {
  if (!station || !snap) {
    return {
      ok: false,
      clearSnapshot: false,
      reason: "Нет доступной сессии для восстановления.",
    };
  }
  const sessionId = snap.stationState.activeSessionId || snap.sessionRecord?.id;
  if (!sessionId) {
    return {
      ok: false,
      clearSnapshot: true,
      reason: `${station.name}: данные восстановления повреждены.`,
    };
  }
  const snapshotStationId = Number(snap.sessionRecord?.stationId);
  if (Number.isFinite(snapshotStationId) && snapshotStationId !== station.id) {
    return {
      ok: false,
      clearSnapshot: true,
      reason: `${station.name}: восстановление относится к другой станции.`,
    };
  }
  if (
    !Number.isFinite(snap.stationState.startTime) ||
    !Number.isFinite(snap.stationState.endTime) ||
    snap.stationState.endTime <= snap.stationState.startTime
  ) {
    return {
      ok: false,
      clearSnapshot: true,
      reason: `${station.name}: данные времени в восстановлении повреждены.`,
    };
  }
  const owner = appState.stations.find(
    (item) =>
      item.id !== station.id &&
      item.status !== "idle" &&
      item.activeSessionId === sessionId,
  );
  if (owner) {
    return {
      ok: false,
      clearSnapshot: false,
      reason: `${station.name}: эта сессия уже занята станцией ${owner.name}.`,
    };
  }
  return { ok: true, sessionId };
}

export function confirmStartOverridesRecovery(station) {
  const recovery = getRecoverySnapshot(station);
  if (!recovery) return true;
  const ok = confirm(
    `${station.name}: у станции ещё доступно восстановление последней закрытой сессии до ${hhmm(recovery.expiresAt)}.\n\nНачать новую сессию и удалить возможность восстановления?`,
  );
  if (!ok) return false;
  clearRecoverySnapshot(station, false);
  return true;
}

export function buildManualStopPrompt(station) {
  if (!station) return "Завершить активную сессию?";
  if (station.status === "overdue") {
    return `${station.name}: станция уже в просрочке. Завершить эту сессию вручную?\n\nПосле завершения её можно будет восстановить в течение ${appState.RECOVERY_WINDOW_MINUTES} минут, пока станция остаётся свободной.`;
  }
  if (station.status === "grace") {
    return `${station.name}: станция сейчас в доигровке. Завершить сессию вручную?\n\nПосле завершения её можно будет восстановить в течение ${appState.RECOVERY_WINDOW_MINUTES} минут, пока станция остаётся свободной.`;
  }
  return `${station.name}: завершить активную сессию?\n\nПосле завершения её можно будет восстановить в течение ${appState.RECOVERY_WINDOW_MINUTES} минут, пока станция остаётся свободной.`;
}

export function requestRestoreLastClosedSession(stationId) {
  if (stationId == null) return;
  const s = appState.stations.find((x) => x.id === stationId);
  if (!s || s.status !== "idle") return;
  const snap = getRecoverySnapshot(s);
  if (!snap) {
    toast("Нет доступной сессии для восстановления");
    return;
  }
  const validation = validateRecoverySnapshotForRestore(s, snap);
  if (!validation.ok) {
    if (validation.clearSnapshot) clearRecoverySnapshot(s);
    rejectAction(s, validation.reason);
    syncControl();
    return;
  }
  if (!confirm(`${s.name}: восстановить последнюю закрытую сессию?`)) return;

  const dayKey = snap.sessionDayKey || todayKey();
  if (!appState.sessions[dayKey]) appState.sessions[dayKey] = [];
  const list = appState.sessions[dayKey];
  const sessionId = validation.sessionId;
  const idx = list.findIndex((item) => item && item.id === sessionId);
  const restoredRec = cloneJson(snap.sessionRecord);
  restoredRec.stationId = s.id;
  restoredRec.stationName = normalizeStationName(s.name);
  restoredRec.stationType = getStationType(s);
  restoredRec.tariffId = snap.stationState.tariffId;
  restoredRec.endTime = null;
  restoredRec.mode = "started";
  if (!Array.isArray(restoredRec.sales)) restoredRec.sales = [];
  if (!Number.isFinite(Number(restoredRec.totalAmount)))
    restoredRec.totalAmount = 0;
  if (idx >= 0) list[idx] = restoredRec;
  else list.push(restoredRec);

  s.status = snap.stationState.status || "running";
  s.startTime = snap.stationState.startTime;
  s.endTime = snap.stationState.endTime;
  s.tariffId = snap.stationState.tariffId;
  s.activeSessionId = sessionId;
  s.lastClosedSnapshot = null;

  saveSessions(true);
  saveStations(true);
  renderStations(true);
  syncControl();
  if (appState.$sessionsModal.classList.contains("modal--open"))
    renderSessions();
  addActionLog("Восстановление", s, "Последняя закрытая сессия восстановлена");
  toast(`${s.name}: сессия восстановлена`);
}

export function restoreLastClosedSession(stationId) {
  if (stationId == null) return;
  const s = appState.stations.find((x) => x.id === stationId);
  if (!s || s.status !== "idle") return;
  const snap = getRecoverySnapshot(s);
  if (!snap) {
    toast("Нет доступной сессии для восстановления");
    return;
  }
  if (!confirm(`${s.name}: восстановить последнюю закрытую сессию?`)) return;

  const dayKey = snap.sessionDayKey || todayKey();
  if (!appState.sessions[dayKey]) appState.sessions[dayKey] = [];
  const list = appState.sessions[dayKey];
  const sessionId = snap.stationState.activeSessionId || snap.sessionRecord.id;
  const idx = list.findIndex((item) => item && item.id === sessionId);
  const restoredRec = cloneJson(snap.sessionRecord);
  restoredRec.endTime = null;
  restoredRec.mode = "started";
  if (idx >= 0) list[idx] = restoredRec;
  else list.push(restoredRec);

  s.status = snap.stationState.status || "running";
  s.startTime = snap.stationState.startTime;
  s.endTime = snap.stationState.endTime;
  s.tariffId = snap.stationState.tariffId;
  s.activeSessionId = sessionId;
  s.lastClosedSnapshot = null;

  saveSessions(true);
  saveStations(true);
  renderStations(true);
  syncControl();
  if (appState.$sessionsModal.classList.contains("modal--open"))
    renderSessions();
  addActionLog("Восстановление", s, "Последняя закрытая сессия восстановлена");
  toast(`${s.name}: сессия восстановлена`);
}
