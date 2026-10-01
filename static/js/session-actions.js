import { canTakePayment } from "./business-ui.js";
import { addActionLog, rejectAction } from "./journal.js";
import { saveStations } from "./persistence.js";
import { renderSessions } from "./reports.js";
import {
  buildManualStopPrompt,
  buildRecoverySnapshot,
  getRecoverySnapshot,
} from "./session-recovery.js";
import {
  addSessionRecord,
  bumpSessionExtension,
  finalizeSession,
  getSelectedTariff,
  money,
  paymentLabel,
  priceForMinutes,
  recordSale,
} from "./sessions.js";
import { state as appState } from "./state.js";
import { getStationType } from "./stations.js";
import { renderStations, syncControl } from "./ui-rendering.js";
import { toast } from "./ui-utils.js";

export function requestStopStation(stationId) {
  if (stationId == null) return;
  const s = appState.stations.find((x) => x.id === stationId);
  if (!s || s.status === "idle") {
    rejectAction(s, `${s?.name || "Станция"}: завершать нечего`);
    return;
  }
  if (!confirm(buildManualStopPrompt(s))) return;
  const recoverySnapshot = buildRecoverySnapshot(s);
  snapshot(s, "Завершить");

  const now = Date.now();
  finalizeSession(s, now, "manual");

  s.status = "idle";
  s.startTime = null;
  s.endTime = null;
  s.tariffId = null;
  s.activeSessionId = null;
  s.lastClosedSnapshot = recoverySnapshot;

  saveStations(true);
  renderStations(true);
  syncControl();
  if (appState.$sessionsModal.classList.contains("modal--open"))
    renderSessions();
  addActionLog(
    "Ручное завершение",
    s,
    "Сессия завершена администратором",
    "info",
  );
  toast(`${s.name}: завершено`);
}

export function snapshot(station, label) {
  const snap = {
    label,
    status: station.status,
    startTime: station.startTime,
    endTime: station.endTime,
    tariffId: station.tariffId,
    extraMinutes: 0,
    activeSessionId: station.activeSessionId,
  };
  station.history = Array.isArray(station.history) ? station.history : [];
  station.history.push(snap);
  if (station.history.length > 12) station.history.shift();
}

export function undoLast(stationId) {
  const s = appState.stations.find((x) => x.id === stationId);
  if (!s || !Array.isArray(s.history) || s.history.length === 0) {
    rejectAction(s, `${s?.name || "Станция"}: нечего отменять`);
    return;
  }

  const last = s.history.pop();
  s.status = last.status;
  s.startTime = last.startTime;
  s.endTime = last.endTime;
  s.tariffId = last.tariffId;
  s.activeSessionId = last.activeSessionId;

  saveStations(true);
  renderStations(true);
  syncControl();
  addActionLog("Отмена", s, "Последнее изменение отменено");
  toast(`${s.name}: отменено`);
}

export function applyTariff(mode) {
  if (!canTakePayment()) return;
  if (appState.selectedStationId == null) return;
  const s = appState.stations.find((x) => x.id === appState.selectedStationId);
  if (!s) return;

  const t = getSelectedTariff();
  if (!t) {
    rejectAction(s, `${s.name}: для этого типа станции не настроены тарифы`);
    return;
  }
  const mins = t.minutes;
  const amount = t.price;

  if (mode === "set" && s.status !== "idle") {
    rejectAction(s, `${s.name}: станция уже занята`);
    return;
  }
  if (mode === "add" && s.status === "idle") {
    rejectAction(s, `${s.name}: нельзя продлить незапущенную станцию`);
    return;
  }

  const now = Date.now();

  if (mode === "set") {
    snapshot(s, `Старт: ${t.label}`);
    s.tariffId = t.id;
    s.status = "running";
    s.startTime = now;
    s.endTime = now + mins * 60 * 1000;
    s.activeSessionId = addSessionRecord(s, s.startTime, {
      tariffLabel: t.label,
      paymentMethod: appState.selectedPaymentMethod,
    });
    s.lastClosedSnapshot = null;
    recordSale(s, {
      type: "start_tariff",
      tariffId: t.id,
      label: `Старт: ${t.label}`,
      minutes: mins,
      amount,
      paymentMethod: appState.selectedPaymentMethod,
    });

    saveStations(true);
    renderStations(true);
    syncControl();
    if (appState.$sessionsModal.classList.contains("modal--open"))
      renderSessions();
    addActionLog(
      "Старт",
      s,
      `${t.label} • ${money(amount)} • ${paymentLabel(appState.selectedPaymentMethod)}`,
    );
    toast(`${s.name}: старт (${t.label})`);
    return;
  }

  snapshot(s, `Продлить: ${t.label}`);
  bumpSessionExtension(s, mins);
  recordSale(s, {
    type: "extend_tariff",
    tariffId: t.id,
    label: `Продление: ${t.label}`,
    minutes: mins,
    amount,
    paymentMethod: appState.selectedPaymentMethod,
  });
  s.endTime = Number.isFinite(s.endTime)
    ? s.endTime + mins * 60 * 1000
    : now + mins * 60 * 1000;
  s.status = "running";

  saveStations(true);
  renderStations(true);
  syncControl();
  if (appState.$sessionsModal.classList.contains("modal--open"))
    renderSessions();
  addActionLog(
    "Продление по тарифу",
    s,
    `${t.label} • ${money(amount)} • ${paymentLabel(appState.selectedPaymentMethod)}`,
  );
  toast(`${s.name}: продлено (${t.label})`);
}

export function applyCustom(mode) {
  if (!canTakePayment()) return;
  const mins = parseInt(appState.$customMinutes.value, 10);
  if (!Number.isFinite(mins) || mins < 10) {
    rejectAction(null, "Минуты: минимум 10");
    return;
  }
  if (appState.selectedStationId == null) return;
  const s = appState.stations.find((x) => x.id === appState.selectedStationId);
  if (!s) return;

  const now = Date.now();
  const amount = priceForMinutes(mins, getStationType(s));

  if (mode === "set") {
    if (s.status !== "idle") {
      rejectAction(s, `${s.name}: станция уже занята`);
      return;
    }
    snapshot(s, `Старт: ${mins} мин`);
    s.tariffId = `custom:${mins}`;
    s.status = "running";
    s.startTime = now;
    s.endTime = now + mins * 60 * 1000;
    s.activeSessionId = addSessionRecord(s, s.startTime, {
      tariffLabel: `Свои минуты (${mins} мин)`,
      paymentMethod: appState.selectedPaymentMethod,
    });
    s.lastClosedSnapshot = null;
    recordSale(s, {
      type: "start_custom",
      label: `Старт: ${mins} мин`,
      minutes: mins,
      amount,
      paymentMethod: appState.selectedPaymentMethod,
    });

    saveStations(true);
    renderStations(true);
    syncControl();
    if (appState.$sessionsModal.classList.contains("modal--open"))
      renderSessions();
    addActionLog(
      "Старт (свои минуты)",
      s,
      `${mins} мин • ${money(amount)} • ${paymentLabel(appState.selectedPaymentMethod)}`,
    );
    toast(`${s.name}: старт (${mins} мин)`);
    return;
  }

  if (s.status === "idle") {
    rejectAction(s, `${s.name}: нельзя продлить незапущенную станцию`);
    return;
  }

  snapshot(s, `Платно: +${mins} мин`);
  bumpSessionExtension(s, mins);
  recordSale(s, {
    type: "extend_custom",
    label: `Платно: +${mins} мин`,
    minutes: mins,
    amount,
    paymentMethod: appState.selectedPaymentMethod,
  });
  s.endTime = Number.isFinite(s.endTime)
    ? s.endTime + mins * 60 * 1000
    : now + mins * 60 * 1000;
  s.status = "running";

  saveStations(true);
  renderStations(true);
  syncControl();
  if (appState.$sessionsModal.classList.contains("modal--open"))
    renderSessions();
  addActionLog(
    "Платное продление",
    s,
    `+${mins} мин • ${money(amount)} • ${paymentLabel(appState.selectedPaymentMethod)}`,
  );
  toast(`${s.name}: куплено +${mins} мин`);
}

export function addPaidMinutes(minutes) {
  if (!canTakePayment()) return;
  if (appState.selectedStationId == null) return;
  const s = appState.stations.find((x) => x.id === appState.selectedStationId);
  if (!s || s.status === "idle") {
    rejectAction(s, `${s?.name || "Станция"}: завершать нечего`);
    return;
  }
  const mins = Math.round(Number(minutes) || 0);
  if (mins <= 0) {
    rejectAction(s, `${s.name}: количество минут должно быть больше нуля`);
    return;
  }
  const amount = priceForMinutes(mins, getStationType(s));
  snapshot(s, `Платно: +${mins} мин`);
  bumpSessionExtension(s, mins);
  recordSale(s, {
    type: "extend_paid_minutes",
    label: `Платно: +${mins} мин`,
    minutes: mins,
    amount,
    paymentMethod: appState.selectedPaymentMethod,
  });
  s.endTime = Number.isFinite(s.endTime)
    ? s.endTime + mins * 60 * 1000
    : Date.now() + mins * 60 * 1000;
  s.status = "running";
  saveStations(true);
  renderStations(true);
  syncControl();
  if (appState.$sessionsModal.classList.contains("modal--open"))
    renderSessions();
  addActionLog(
    "Платное продление",
    s,
    `+${mins} мин • ${money(amount)} • ${paymentLabel(appState.selectedPaymentMethod)}`,
  );
  toast(`${s.name}: куплено +${mins} мин`);
}

export function adjustMinutes(stationId, deltaMins) {
  if (stationId == null) return;
  const s = appState.stations.find((x) => x.id === stationId);
  if (!s || s.status === "idle" || !Number.isFinite(s.endTime)) {
    rejectAction(s, `${s?.name || "Станция"}: корректировка недоступна`);
    return;
  }

  snapshot(s, `Корректировка: ${deltaMins > 0 ? "+" : ""}${deltaMins} мин`);
  bumpSessionExtension(s, deltaMins);

  const now = Date.now();
  const deltaMs = deltaMins * 60 * 1000;
  const newEnd = s.endTime + deltaMs;
  const minEnd = now + 60 * 1000;
  s.endTime = Math.max(minEnd, newEnd);
  s.status = "running";

  saveStations(true);
  renderStations(true);
  syncControl();
  addActionLog(
    "Служебная корректировка",
    s,
    `${deltaMins > 0 ? "+" : ""}${deltaMins} мин`,
  );
  toast(`${s.name}: ${deltaMins > 0 ? "+" : ""}${deltaMins} мин`);
}

export function stopStation(stationId, mode) {
  if (stationId == null) return;
  const s = appState.stations.find((x) => x.id === stationId);
  if (!s || s.status === "idle") {
    rejectAction(s, `${s?.name || "Станция"}: завершать нечего`);
    return;
  }

  if (mode === "manual" && s.status !== "overdue") {
    const recovery = getRecoverySnapshot(s);
    const promptText = `${s.name}: завершить активную сессию?\n\nПосле завершения её можно будет восстановить в течение ${appState.RECOVERY_WINDOW_MINUTES} минут, если станция останется свободной.`;
    if (!confirm(promptText)) return;
  }

  const recoverySnapshot = buildRecoverySnapshot(s);
  snapshot(s, "Завершить");

  const now = Date.now();
  finalizeSession(s, now, mode);

  s.status = "idle";
  s.startTime = null;
  s.endTime = null;
  s.tariffId = null;
  s.activeSessionId = null;
  s.lastClosedSnapshot = recoverySnapshot;

  saveStations(true);
  renderStations(true);
  syncControl();
  if (appState.$sessionsModal.classList.contains("modal--open"))
    renderSessions();
  addActionLog(
    mode === "auto" ? "Автозавершение" : "Ручное завершение",
    s,
    mode === "auto"
      ? "Сессия завершена после просрочки"
      : "Сессия завершена администратором",
    mode === "auto" ? "warn" : "info",
  );
  toast(
    mode === "auto"
      ? `${s.name}: автоматически завершено после просрочки`
      : `${s.name}: завершено`,
  );
}
