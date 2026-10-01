import { syncAchievementsState } from "./achievements.js";
import {
  closeReportDatePickers,
  syncReportDateLabels,
  syncReportPresetButtons,
} from "./report-calendar.js";
import {
  labelTariff,
  money,
  paymentLabel,
  paymentTotalsFromSessions,
  salesTotal,
  todayKey,
} from "./sessions.js";
import { stationTypeLabel } from "./settings-editor.js";
import { state as appState } from "./state.js";
import { defaultStationName, getStationType } from "./stations.js";
import { closeAllCustomSelects } from "./ui-events.js";
import { escapeHtml, formatDateRU, hhmm } from "./ui-utils.js";

export function todaySessionsList() {
  const key = todayKey();
  return appState.sessions[key] || [];
}

export function clearSessionsForDay(dayKey) {
  // Financial history is retained; a shift is closed through the cash desk.
  const list = appState.sessions[dayKey] || [];
  return { removed: 0, keptActive: list.length };
}

export function openSessions() {
  appState.$sessionsModal.classList.add("modal--open");
  appState.$sessionsModal.setAttribute("aria-hidden", "false");
  renderSessions();
}

export function closeSessions() {
  appState.$sessionsModal.classList.remove("modal--open");
  appState.$sessionsModal.setAttribute("aria-hidden", "true");
}

export function renderSessions() {
  const key = todayKey();
  const list = appState.sessions[key] || [];
  const closedList = list.filter((r) => r && r.endTime);
  const totalRevenue = salesTotal(list);
  const avgCheck = list.length ? Math.round(totalRevenue / list.length) : 0;
  const paymentTotals = paymentTotalsFromSessions(list);
  const paymentSummary = appState.PAYMENT_METHODS.map((method) =>
    paymentTotals[method.id] > 0
      ? `${method.label}: ${money(paymentTotals[method.id])}`
      : null,
  )
    .filter(Boolean)
    .join(" • ");

  appState.$sessionsSub.textContent = `${formatDateRU(key)} • сессий: ${list.length}`;
  if (appState.$summaryRevenue)
    appState.$summaryRevenue.textContent = money(totalRevenue);
  if (appState.$summarySessions)
    appState.$summarySessions.textContent = String(closedList.length);
  if (appState.$summaryAvgCheck)
    appState.$summaryAvgCheck.textContent = list.length ? money(avgCheck) : "—";
  if (appState.$summaryPaid)
    appState.$summaryPaid.textContent = paymentSummary || "—";

  if (list.length === 0) {
    appState.$sessionsList.innerHTML = `<div class="sessionRow"><div class="sessionRow__left"><div class="sessionRow__title">Пусто</div><div class="sessionRow__meta">Сегодня сессий ещё нет.</div></div></div>`;
    return;
  }

  const items = [...list].sort(
    (a, b) => (b.startTime || 0) - (a.startTime || 0),
  );
  appState.$sessionsList.innerHTML = "";

  for (const r of items) {
    const start = r.startTime ? hhmm(r.startTime) : "—";
    const end = r.endTime ? hhmm(r.endTime) : "—";
    const durMin =
      r.startTime && r.endTime
        ? Math.max(0, Math.round((r.endTime - r.startTime) / 60000))
        : null;
    const tariffLabel =
      r.tariffLabel || (r.tariffId ? labelTariff(r.tariffId) : "—");
    const modeLabel = r.endTime
      ? r.mode === "auto"
        ? "авто"
        : "вручную"
      : "идёт";
    const amountText = money(r.totalAmount || 0);
    const payLabel = paymentLabel(r.paymentMethod || "cash");
    const salesCount = Array.isArray(r.sales) ? r.sales.length : 0;

    const row = document.createElement("div");
    row.className = "sessionRow";
    row.innerHTML = `
      <div class="sessionRow__left">
        <div class="sessionRow__title">${escapeHtml(r.stationName || `PS${r.stationId}`)}</div>
        <div class="sessionRow__meta">Тариф: ${escapeHtml(tariffLabel)}<br>Время: ${start} → ${end}<br>Оплата: ${escapeHtml(payLabel)}<br>Продаж: ${salesCount}</div>
      </div>
      <div class="sessionRow__right">
        ${durMin != null ? `<div><b>${durMin} мин</b></div>` : "<div><b>Активна</b></div>"}
        <div><b>${escapeHtml(amountText)}</b></div>
        <div>${escapeHtml(modeLabel)}</div>
      </div>
    `;
    appState.$sessionsList.appendChild(row);
  }
}

export function stationTypeFromRecord(rec) {
  if (rec?.stationType && appState.STATION_TYPES[rec.stationType])
    return rec.stationType;
  return getStationType(rec?.stationId || 1);
}

export function allSessionRecords() {
  const out = [];
  for (const [key, list] of Object.entries(appState.sessions || {})) {
    if (!Array.isArray(list)) continue;
    for (const rec of list) {
      if (!rec || typeof rec !== "object") continue;
      out.push({
        ...rec,
        dateKey: key,
        stationType: stationTypeFromRecord(rec),
      });
    }
  }
  return out.sort((a, b) => (b.startTime || 0) - (a.startTime || 0));
}

export function sessionMatchesPayment(rec, paymentFilter) {
  if (!paymentFilter || paymentFilter === "all") return true;
  const sales = Array.isArray(rec?.sales) ? rec.sales : [];
  if (sales.length)
    return sales.some(
      (sale) => (sale?.paymentMethod || "cash") === paymentFilter,
    );
  return (rec?.paymentMethod || "cash") === paymentFilter;
}

export function getReportFilters() {
  return {
    from: appState.$reportDateFrom?.value || todayKey(),
    to:
      appState.$reportDateTo?.value ||
      appState.$reportDateFrom?.value ||
      todayKey(),
    stationType: appState.$reportStationType?.value || "all",
    payment: appState.$reportPayment?.value || "all",
    view: appState.$reportView?.value || "sessions",
  };
}

export function getReportDatePickerParts(kind) {
  if (kind === "from") {
    return {
      input: appState.$reportDateFrom,
      trigger: appState.$reportDateFromTrigger,
      picker: appState.$reportDateFromPicker,
      peer: appState.$reportDateTo,
      label: appState.$reportDateFromLabel,
    };
  }
  return {
    input: appState.$reportDateTo,
    trigger: appState.$reportDateToTrigger,
    picker: appState.$reportDateToPicker,
    peer: appState.$reportDateFrom,
    label: appState.$reportDateToLabel,
  };
}

export function getFilteredReportData() {
  const filters = getReportFilters();
  const all = allSessionRecords();
  const fromTs = Date.parse(`${filters.from}T00:00:00`) || Date.now();
  const toTs = Date.parse(`${filters.to}T23:59:59`) || fromTs;
  const sessionRows = all.filter((rec) => {
    const startTs =
      Number(rec?.startTime) || Date.parse(`${rec.dateKey}T00:00:00`) || 0;
    if (startTs < fromTs || startTs > toTs) return false;
    if (
      filters.stationType !== "all" &&
      stationTypeFromRecord(rec) !== filters.stationType
    )
      return false;
    if (!sessionMatchesPayment(rec, filters.payment)) return false;
    return true;
  });
  const salesRows = [];
  for (const rec of sessionRows) {
    const sales = Array.isArray(rec?.sales) ? rec.sales : [];
    if (!sales.length && Number(rec?.totalAmount || 0) > 0) {
      salesRows.push({
        dateKey: rec.dateKey,
        stationId: rec.stationId,
        stationName: rec.stationName,
        stationType: stationTypeFromRecord(rec),
        time:
          rec.startTime || Date.parse(`${rec.dateKey}T00:00:00`) || Date.now(),
        type: "legacy",
        label: "Продажа",
        minutes: 0,
        amount: Number(rec.totalAmount) || 0,
        paymentMethod: rec.paymentMethod || "cash",
      });
      continue;
    }
    for (const sale of sales) {
      const pm = sale?.paymentMethod || rec.paymentMethod || "cash";
      if (filters.payment !== "all" && pm !== filters.payment) continue;
      salesRows.push({
        dateKey: rec.dateKey,
        stationId: rec.stationId,
        stationName: rec.stationName,
        stationType: stationTypeFromRecord(rec),
        time: Number(sale?.time) || rec.startTime || Date.now(),
        type: sale?.type || "sale",
        label: sale?.label || "Начисление",
        minutes: Number(sale?.minutes) || 0,
        amount: Number(sale?.amount) || 0,
        paymentMethod: pm,
      });
    }
  }
  salesRows.sort((a, b) => (b.time || 0) - (a.time || 0));
  return { filters, sessionRows, salesRows };
}

export function formatDurationMinutes(totalMinutes) {
  const n = Math.max(0, Math.round(Number(totalMinutes) || 0));
  const h = Math.floor(n / 60);
  const m = n % 60;
  if (h && m) return `${h} ч ${m} мин`;
  if (h) return `${h} ч`;
  return `${m} мин`;
}

export function renderReports() {
  if (!appState.$reportsList) return;
  const { filters, sessionRows, salesRows } = getFilteredReportData();
  syncReportDateLabels();
  const revenue = salesRows.reduce(
    (sum, sale) => sum + (Number(sale.amount) || 0),
    0,
  );
  const avgCheck = sessionRows.length
    ? Math.round(revenue / sessionRows.length)
    : 0;
  const closed = sessionRows.filter((rec) => rec.endTime && rec.startTime);
  const avgDuration = closed.length
    ? Math.round(
        closed.reduce(
          (sum, rec) =>
            sum +
            Math.max(
              0,
              Math.round(((rec.endTime || 0) - (rec.startTime || 0)) / 60000),
            ),
          0,
        ) / closed.length,
      )
    : 0;

  const typeTotals = { ps: 0, simulator: 0, switch: 0 };
  for (const sale of salesRows)
    typeTotals[sale.stationType] += Number(sale.amount) || 0;
  const paymentTotals = Object.fromEntries(
    appState.PAYMENT_METHODS.map((m) => [m.id, 0]),
  );
  for (const sale of salesRows)
    paymentTotals[sale.paymentMethod] += Number(sale.amount) || 0;

  if (appState.$reportsSub)
    appState.$reportsSub.textContent = `${formatDateRU(filters.from)} → ${formatDateRU(filters.to)} • ${filters.view === "sales" ? "начислений" : "сессий"}: ${filters.view === "sales" ? salesRows.length : sessionRows.length}`;
  if (appState.$reportRevenue)
    appState.$reportRevenue.textContent = money(revenue);
  if (appState.$reportSessionsCount)
    appState.$reportSessionsCount.textContent = String(sessionRows.length);
  if (appState.$reportAvgCheck)
    appState.$reportAvgCheck.textContent = sessionRows.length
      ? money(avgCheck)
      : "—";
  if (appState.$reportAvgDuration)
    appState.$reportAvgDuration.textContent = closed.length
      ? formatDurationMinutes(avgDuration)
      : "—";
  if (appState.$reportTypeTotals)
    appState.$reportTypeTotals.textContent = ["ps", "simulator", "switch"]
      .map((type) => `${stationTypeLabel(type)}: ${money(typeTotals[type])}`)
      .join(" • ");
  if (appState.$reportPaymentTotals)
    appState.$reportPaymentTotals.textContent = appState.PAYMENT_METHODS.map(
      (method) => `${method.label}: ${money(paymentTotals[method.id])}`,
    ).join(" • ");
  syncReportPresetButtons(filters);

  renderReportChart(salesRows, filters);

  const rows = filters.view === "sales" ? salesRows : sessionRows;
  if (!rows.length) {
    appState.$reportsList.innerHTML =
      '<div class="sessionRow"><div class="sessionRow__left"><div class="sessionRow__title">Пусто</div><div class="sessionRow__meta">Нет записей за выбранный период.</div></div></div>';
    return;
  }
  appState.$reportsList.innerHTML = "";
  for (const rowData of rows) {
    const row = document.createElement("div");
    row.className = "reportRow";
    if (filters.view === "sales") {
      row.innerHTML = `
        <div>
          <div class="reportRow__title">${escapeHtml(rowData.stationName || defaultStationName(rowData.stationId))} • ${escapeHtml(stationTypeLabel(rowData.stationType))}</div>
          <div class="reportRow__meta">${escapeHtml(rowData.label || "Начисление")} • ${rowData.minutes ? `${rowData.minutes} мин` : "без минут"}<br>${formatDateRU(todayKey(rowData.time))} • ${hhmm(rowData.time)} • ${escapeHtml(paymentLabel(rowData.paymentMethod || "cash"))}</div>
        </div>
        <div class="reportRow__right">
          <div><b>${escapeHtml(money(rowData.amount || 0))}</b></div>
          <div>${escapeHtml(String(rowData.type || "sale"))}</div>
        </div>
      `;
    } else {
      const start = rowData.startTime ? hhmm(rowData.startTime) : "—";
      const end = rowData.endTime ? hhmm(rowData.endTime) : "—";
      const duration =
        rowData.startTime && rowData.endTime
          ? formatDurationMinutes(
              Math.round(
                ((rowData.endTime || 0) - (rowData.startTime || 0)) / 60000,
              ),
            )
          : "Активна";
      const tariff =
        rowData.tariffLabel ||
        (rowData.tariffId
          ? labelTariff(rowData.tariffId, rowData.stationType)
          : "—");
      row.innerHTML = `
        <div>
          <div class="reportRow__title">${escapeHtml(rowData.stationName || defaultStationName(rowData.stationId))} • ${escapeHtml(stationTypeLabel(rowData.stationType))}</div>
          <div class="reportRow__meta">${formatDateRU(todayKey(rowData.startTime || Date.now()))} • ${start} → ${end}<br>Тариф: ${escapeHtml(tariff)} • Оплата: ${escapeHtml(paymentLabel(rowData.paymentMethod || "cash"))}</div>
        </div>
        <div class="reportRow__right">
          <div><b>${escapeHtml(duration)}</b></div>
          <div><b>${escapeHtml(money(rowData.totalAmount || 0))}</b></div>
          <div>${escapeHtml(rowData.endTime ? (rowData.mode === "auto" ? "авто" : "вручную") : "идёт")}</div>
        </div>
      `;
    }
    appState.$reportsList.appendChild(row);
  }
}

export function renderReportChart(salesRows, filters) {
  if (!appState.$reportChart) return;
  const fromTs = Date.parse(`${filters.from}T00:00:00`) || Date.now();
  const toTs = Date.parse(`${filters.to}T00:00:00`) || fromTs;
  const dayMap = new Map();
  for (let ts = fromTs; ts <= toTs; ts += 86400000) {
    dayMap.set(todayKey(ts), 0);
  }
  for (const sale of salesRows) {
    const key = todayKey(sale.time || Date.now());
    dayMap.set(key, (dayMap.get(key) || 0) + (Number(sale.amount) || 0));
  }
  const rows = Array.from(dayMap.entries()).sort((a, b) =>
    a[0].localeCompare(b[0]),
  );
  const maxValue = Math.max(0, ...rows.map(([, v]) => v));
  if (!rows.length) {
    appState.$reportChart.innerHTML =
      '<div class="reportChart__empty">Нет данных за выбранный период.</div>';
    return;
  }
  appState.$reportChart.innerHTML = rows
    .map(([dateKey, value]) => {
      const width =
        maxValue > 0 ? Math.max(4, Math.round((value / maxValue) * 100)) : 0;
      return `
      <div class="reportChart__row">
        <div class="reportChart__date">${escapeHtml(formatDateRU(dateKey))}</div>
        <div class="reportChart__track"><div class="reportChart__bar" style="width:${width}%;"></div></div>
        <div class="reportChart__value">${escapeHtml(money(value))}</div>
      </div>`;
    })
    .join("");
}

export function openReports() {
  const today = todayKey();
  if (appState.$reportDateFrom && !appState.$reportDateFrom.value)
    appState.$reportDateFrom.value = today;
  if (appState.$reportDateTo && !appState.$reportDateTo.value)
    appState.$reportDateTo.value = today;
  syncReportDateLabels();
  renderReports();
  appState.$reportsModal.classList.add("modal--open");
  appState.$reportsModal.setAttribute("aria-hidden", "false");
}

export function closeReports() {
  closeAllCustomSelects();
  closeReportDatePickers();
  appState.$reportsModal.classList.remove("modal--open");
  appState.$reportsModal.setAttribute("aria-hidden", "true");
}
