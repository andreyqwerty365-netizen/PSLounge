import { rejectAction } from "./journal.js";
import { saveSessions } from "./persistence.js";
import { getSelectedStationType, getTariffs } from "./settings-model.js";
import { state as appState } from "./state.js";
import { getStationType, normalizeStationName } from "./stations.js";
import { fmt, hhmm } from "./ui-utils.js";

export function todayKey(ts = Date.now()) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function getTariffById(tariffId, stationType = null) {
  if (!tariffId) return null;
  const types = stationType ? [stationType] : ["ps", "simulator", "switch"];
  for (const type of types) {
    const found = getTariffs(type).find((t) => t.id === tariffId);
    if (found) return found;
  }
  return null;
}

export function priceForMinutes(minutes, stationType = null) {
  const safe = Math.max(0, Number(minutes) || 0);
  const type = stationType || getSelectedStationType();
  const rate = Number(appState.settings.customRates?.[type]);
  const perHour = Number.isFinite(rate)
    ? rate
    : appState.DEFAULT_CUSTOM_RATES[type] || appState.DEFAULT_CUSTOM_RATES.ps;
  return Math.round((perHour * safe) / 60);
}

export function money(value) {
  const safe = Number.isFinite(Number(value)) ? Math.round(Number(value)) : 0;
  return `${safe.toLocaleString("ru-RU")} ${appState.settings.currencySymbol || "₽"}`;
}

export function paymentLabel(methodId) {
  const item = appState.PAYMENT_METHODS.find((x) => x.id === methodId);
  return item ? item.label : "Не указано";
}

export function tariffPriceLabel(tariffId, stationType = null) {
  if (!tariffId) return "—";
  const type = stationType || getSelectedStationType();
  const tariff = getTariffById(tariffId, type);
  if (tariff) return money(tariff.price);
  if (String(tariffId).startsWith("custom:")) {
    const mins = parseInt(String(tariffId).split(":")[1], 10);
    return Number.isFinite(mins) ? money(priceForMinutes(mins, type)) : "—";
  }
  return "—";
}

export function addSessionRecord(station, startTime, extra = {}) {
  const key = todayKey(startTime);
  if (!appState.sessions[key]) appState.sessions[key] = [];
  const id = `${station.id}-${startTime}-${Math.random().toString(16).slice(2)}`;
  appState.sessions[key].push({
    id,
    stationId: station.id,
    stationType: getStationType(station),
    stationName: normalizeStationName(station.name),
    startTime,
    endTime: null,
    tariffId: station.tariffId,
    extraMinutes: 0,
    mode: "started",
    totalAmount: 0,
    paymentMethod: appState.selectedPaymentMethod || "cash",
    sales: [],
    ...extra,
  });
  saveSessions(true);
  return id;
}

export function getSessionRecordById(station, sid = null) {
  const key = station?.startTime ? todayKey(station.startTime) : todayKey();
  const list = appState.sessions[key] || [];
  return list.find((x) => x.id === (sid || station?.activeSessionId)) || null;
}

export function finalizeSession(station, endTime, mode) {
  const rec = getSessionRecordById(station);
  if (!rec) return;
  rec.endTime = endTime;
  rec.mode = mode;
  saveSessions(true);
}

export function recordSale(station, sale) {
  try {
    const rec = getSessionRecordById(station);
    if (!rec) {
      rejectAction(
        station,
        `${station?.name || "Станция"}: продажа без активной сессии отклонена`,
      );
      return;
    }
    if (!Array.isArray(rec.sales)) rec.sales = [];
    const rawAmount = Number(sale?.amount);
    if (!Number.isFinite(rawAmount) || rawAmount < 0) {
      rejectAction(
        station,
        `${station?.name || "Станция"}: сумма продажи некорректна`,
      );
      return;
    }
    const amount = Math.max(0, Math.round(rawAmount || 0));
    const rawMinutes = Number(sale?.minutes);
    if (Number.isFinite(rawMinutes) && rawMinutes < 0) {
      rejectAction(
        station,
        `${station?.name || "Станция"}: минуты продажи не могут быть отрицательными`,
      );
      return;
    }
    if (!amount && !(Number.isFinite(rawMinutes) && rawMinutes > 0)) {
      rejectAction(
        station,
        `${station?.name || "Станция"}: пустая продажа отклонена`,
      );
      return;
    }
    const entry = {
      id: `sale_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
      time: Date.now(),
      type: typeof sale?.type === "string" ? sale.type : "sale",
      label: typeof sale?.label === "string" ? sale.label : "Продажа",
      minutes: Number.isFinite(Number(sale?.minutes))
        ? Math.round(Number(sale.minutes))
        : 0,
      amount,
      paymentMethod:
        typeof sale?.paymentMethod === "string"
          ? sale.paymentMethod
          : rec.paymentMethod || appState.selectedPaymentMethod || "cash",
    };
    rec.sales.push(entry);
    rec.totalAmount = rec.sales.reduce(
      (sum, x) => sum + (Number(x.amount) || 0),
      0,
    );
    rec.paymentMethod = entry.paymentMethod;
    saveSessions(true);
  } catch {}
}

export function bumpSessionExtension(station, deltaMinutes) {
  try {
    const dm = Number(deltaMinutes);
    if (!Number.isFinite(dm) || dm === 0) return;
    const rec = getSessionRecordById(station);
    if (!rec) {
      rejectAction(
        station,
        `${station?.name || "Станция"}: продажа без активной сессии отклонена`,
      );
      return;
    }
    const current = Number(rec.extraMinutes || 0);
    rec.extraMinutes = (Number.isFinite(current) ? current : 0) + dm;
    saveSessions(true);
  } catch {}
}

export function setSessionPaymentMethod(station, methodId) {
  try {
    const rec = getSessionRecordById(station);
    if (!rec) {
      rejectAction(
        station,
        `${station?.name || "Станция"}: продажа без активной сессии отклонена`,
      );
      return;
    }
    rec.paymentMethod = methodId;
    saveSessions(true);
  } catch {}
}

export function salesTotal(list) {
  return (Array.isArray(list) ? list : []).reduce(
    (sum, rec) => sum + (Number(rec?.totalAmount) || 0),
    0,
  );
}

export function paymentTotalsFromSessions(list) {
  const totals = Object.fromEntries(
    appState.PAYMENT_METHODS.map((m) => [m.id, 0]),
  );
  for (const rec of Array.isArray(list) ? list : []) {
    const sales = Array.isArray(rec?.sales) ? rec.sales : [];
    if (sales.length) {
      for (const sale of sales) {
        const pm =
          totals[sale.paymentMethod] != null ? sale.paymentMethod : "cash";
        totals[pm] += Number(sale.amount) || 0;
      }
    } else {
      const pm =
        totals[rec?.paymentMethod] != null ? rec.paymentMethod : "cash";
      totals[pm] += Number(rec?.totalAmount) || 0;
    }
  }
  return totals;
}

export function computeState(station, now) {
  if (station.status === "idle" || !Number.isFinite(station.endTime)) {
    return {
      timerLabel: "Осталось",
      remainingText: "00:00:00",
      untilText: "—",
      tone: "normal",
    };
  }

  const end = station.endTime;
  const graceEnd = end + appState.settings.graceMinutes * 60 * 1000;

  // Running
  if (now < end) {
    const remainingMs = end - now;
    const tone = remainingMs <= 10 * 60 * 1000 ? "warn" : "normal";
    return {
      timerLabel: "Осталось",
      remainingText: fmt(remainingMs),
      untilText: hhmm(end),
      tone,
    };
  }

  // Grace countdown (доигровка): show remaining grace time
  if (now >= end && now < graceEnd) {
    return {
      timerLabel: "Доигровка",
      remainingText: fmt(graceEnd - now),
      untilText: hhmm(end),
      tone: "danger",
    };
  }

  // Overdue after grace: show time since grace ended
  return {
    timerLabel: "Просрочено",
    remainingText: fmt(now - graceEnd),
    untilText: hhmm(end),
    tone: "danger",
  };
}

export function labelTariff(tariffId, stationType = null) {
  const t = getTariffById(tariffId, stationType);
  if (t) return t.label.split("•")[0].trim();
  if (tariffId?.startsWith("custom:"))
    return `Свои минуты (${tariffId.split(":")[1]} мин)`;
  return "Тариф";
}

export function getSelectedTariff() {
  const stationType = getSelectedStationType();
  return (
    getTariffs(stationType).find(
      (t) => t.id === appState.selectedTariffIds[stationType],
    ) ?? getTariffs(stationType)[0]
  );
}

export function getActiveSessionRecord(station) {
  if (!station || !station.activeSessionId) return null;
  const key = station.startTime ? todayKey(station.startTime) : todayKey();
  const list = appState.sessions[key] || [];
  return list.find((x) => x.id === station.activeSessionId) || null;
}

export function getActiveSessionIdsForDay(dayKey) {
  const ids = new Set();
  for (const station of appState.stations) {
    if (
      !station ||
      station.status === "idle" ||
      !station.activeSessionId ||
      !station.startTime
    )
      continue;
    if (todayKey(station.startTime) !== dayKey) continue;
    ids.add(station.activeSessionId);
  }
  return ids;
}
