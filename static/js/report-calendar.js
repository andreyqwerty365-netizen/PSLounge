import {
  getReportDatePickerParts,
  getReportFilters,
  renderReports,
} from "./reports.js";
import { todayKey } from "./sessions.js";
import { state as appState } from "./state.js";
import { closeAllCustomSelects } from "./ui-events.js";
import { escapeHtml, formatDateRU, toast } from "./ui-utils.js";

export function toDateInputValue(ts = Date.now()) {
  return todayKey(ts);
}

export function shiftDateKey(dateKey, deltaDays) {
  const base = new Date(`${dateKey}T00:00:00`);
  base.setDate(base.getDate() + deltaDays);
  return todayKey(base.getTime());
}

export function monthKey(dateKey) {
  const safe = String(dateKey || todayKey());
  return safe.slice(0, 7);
}

export function startOfMonthKey(dateKey) {
  const base = new Date(`${dateKey}T00:00:00`);
  base.setDate(1);
  return todayKey(base.getTime());
}

export function shiftMonthKey(key, deltaMonths) {
  const [year, month] = String(key || monthKey(todayKey()))
    .split("-")
    .map(Number);
  const base = new Date(year, (month || 1) - 1, 1);
  base.setMonth(base.getMonth() + deltaMonths);
  return `${base.getFullYear()}-${String(base.getMonth() + 1).padStart(2, "0")}`;
}

export function formatMonthRU(key) {
  const [year, month] = String(key || monthKey(todayKey()))
    .split("-")
    .map(Number);
  const base = new Date(year, (month || 1) - 1, 1);
  const label = new Intl.DateTimeFormat("ru-RU", {
    month: "long",
    year: "numeric",
  }).format(base);
  return label.charAt(0).toUpperCase() + label.slice(1);
}

export function formatDateInputRU(value) {
  const key = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return "";
  const [year, month, day] = key.split("-");
  return `${day}.${month}.${year}`;
}

export function parseDateInputRU(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const normalized = raw.replace(/\s+/g, "");
  const match = normalized.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (!match) return "";
  const [, day, month, year] = match;
  const key = `${year}-${month}-${day}`;
  const date = new Date(`${key}T00:00:00`);
  if (Number.isNaN(date.getTime())) return "";
  if (todayKey(date.getTime()) !== key) return "";
  return key;
}

export function syncReportDateLabels() {
  if (appState.$reportDateFromLabel)
    appState.$reportDateFromLabel.textContent = formatDateRU(
      appState.$reportDateFrom?.value || todayKey(),
    );
  if (appState.$reportDateToLabel)
    appState.$reportDateToLabel.textContent = formatDateRU(
      appState.$reportDateTo?.value ||
        appState.$reportDateFrom?.value ||
        todayKey(),
    );
  if (appState.$reportDateFromText)
    appState.$reportDateFromText.value = formatDateInputRU(
      appState.$reportDateFrom?.value || todayKey(),
    );
  if (appState.$reportDateToText)
    appState.$reportDateToText.value = formatDateInputRU(
      appState.$reportDateTo?.value ||
        appState.$reportDateFrom?.value ||
        todayKey(),
    );
}

export function closeReportDatePickers() {
  appState.reportDatePickerOpen = "";
  [
    [appState.$reportDateFromTrigger, appState.$reportDateFromPicker],
    [appState.$reportDateToTrigger, appState.$reportDateToPicker],
  ].forEach(([trigger, picker]) => {
    trigger?.setAttribute("aria-expanded", "false");
    picker?.setAttribute("hidden", "");
  });
}

export function renderReportDatePicker(kind) {
  const parts = getReportDatePickerParts(kind);
  if (!parts.input || !parts.picker) return;
  const selected = parts.input.value || todayKey();
  const month = appState.reportDatePickerMonth[kind] || monthKey(selected);
  appState.reportDatePickerMonth[kind] = month;
  const monthStart = new Date(`${month}-01T00:00:00`);
  const daysInMonth = new Date(
    monthStart.getFullYear(),
    monthStart.getMonth() + 1,
    0,
  ).getDate();
  const startOffset = (monthStart.getDay() + 6) % 7;
  const cells = [];
  for (let i = 0; i < startOffset; i += 1) {
    cells.push(
      '<span class="reportDatePicker__day reportDatePicker__day--empty"></span>',
    );
  }
  for (let day = 1; day <= daysInMonth; day += 1) {
    const date = new Date(monthStart.getFullYear(), monthStart.getMonth(), day);
    const key = todayKey(date.getTime());
    const classes = ["reportDatePicker__day"];
    if (key === selected) classes.push("is-selected");
    if (key === todayKey()) classes.push("is-today");
    cells.push(
      `<button class="${classes.join(" ")}" type="button" data-report-date="${key}" data-report-kind="${kind}">${day}</button>`,
    );
  }
  parts.picker.innerHTML = `
    <div class="reportDatePicker__head">
      <button class="reportDatePicker__nav" type="button" data-report-month-nav="${kind}:-1">‹</button>
      <div class="reportDatePicker__title">${escapeHtml(formatMonthRU(month))}</div>
      <button class="reportDatePicker__nav" type="button" data-report-month-nav="${kind}:1">›</button>
    </div>
    <div class="reportDatePicker__weekdays">
      <span>Пн</span><span>Вт</span><span>Ср</span><span>Чт</span><span>Пт</span><span>Сб</span><span>Вс</span>
    </div>
    <div class="reportDatePicker__grid">${cells.join("")}</div>
    <div class="reportDatePicker__foot">
      <button class="reportDatePicker__action" type="button" data-report-today="${kind}">Сегодня</button>
      <button class="reportDatePicker__action" type="button" data-report-close="${kind}">Закрыть</button>
    </div>
  `;
  parts.picker.querySelectorAll("[data-report-date]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      setReportDateValue(kind, btn.dataset.reportDate || todayKey());
    });
  });
  parts.picker.querySelectorAll("[data-report-month-nav]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const [, delta] = String(btn.dataset.reportMonthNav || "").split(":");
      appState.reportDatePickerMonth[kind] = shiftMonthKey(
        month,
        Number(delta) || 0,
      );
      renderReportDatePicker(kind);
    });
  });
  parts.picker
    .querySelector(`[data-report-today="${kind}"]`)
    ?.addEventListener("click", () => {
      setReportDateValue(kind, todayKey());
    });
  parts.picker
    .querySelector(`[data-report-today="${kind}"]`)
    ?.addEventListener("click", (e) => e.stopPropagation());
  parts.picker
    .querySelector(`[data-report-close="${kind}"]`)
    ?.addEventListener("click", (e) => {
      e.stopPropagation();
      closeReportDatePickers();
    });
}

export function toggleReportDatePicker(kind) {
  const parts = getReportDatePickerParts(kind);
  if (!parts.picker || !parts.trigger || !parts.input) return;
  const isOpen =
    appState.reportDatePickerOpen === kind &&
    !parts.picker.hasAttribute("hidden");
  closeAllCustomSelects();
  closeReportDatePickers();
  if (isOpen) return;
  appState.reportDatePickerMonth[kind] = monthKey(
    parts.input.value || todayKey(),
  );
  renderReportDatePicker(kind);
  appState.reportDatePickerOpen = kind;
  parts.trigger.setAttribute("aria-expanded", "true");
  parts.picker.removeAttribute("hidden");
}

export function setReportDateValue(kind, value) {
  const parts = getReportDatePickerParts(kind);
  if (!parts.input) return;
  parts.input.value = value;
  if (
    kind === "from" &&
    appState.$reportDateTo &&
    appState.$reportDateTo.value &&
    value > appState.$reportDateTo.value
  ) {
    appState.$reportDateTo.value = value;
  }
  if (
    kind === "to" &&
    appState.$reportDateFrom &&
    appState.$reportDateFrom.value &&
    value < appState.$reportDateFrom.value
  ) {
    appState.$reportDateFrom.value = value;
  }
  syncReportDateLabels();
  if (appState.reportDatePickerOpen === kind) renderReportDatePicker(kind);
  renderReports();
}

export function commitReportDateText(kind) {
  const input =
    kind === "from" ? appState.$reportDateFromText : appState.$reportDateToText;
  const fallback =
    kind === "from"
      ? appState.$reportDateFrom?.value || todayKey()
      : appState.$reportDateTo?.value ||
        appState.$reportDateFrom?.value ||
        todayKey();
  if (!input) return;
  const parsed = parseDateInputRU(input.value);
  if (!parsed) {
    input.value = formatDateInputRU(fallback);
    toast("Дата: формат ДД.ММ.ГГГГ");
    return;
  }
  setReportDateValue(kind, parsed);
}

export function applyReportPreset(preset) {
  const today = todayKey();
  let from = today;
  let to = today;
  if (preset === "yesterday") {
    from = shiftDateKey(today, -1);
    to = from;
  } else if (preset === "week") {
    from = shiftDateKey(today, -6);
  } else if (preset === "month") {
    from = startOfMonthKey(today);
  }
  if (appState.$reportDateFrom) appState.$reportDateFrom.value = from;
  if (appState.$reportDateTo) appState.$reportDateTo.value = to;
  syncReportDateLabels();
  closeReportDatePickers();
  renderReports();
}

export function activeReportPreset(filters = getReportFilters()) {
  const today = todayKey();
  const yesterday = shiftDateKey(today, -1);
  if (filters.from === today && filters.to === today) return "today";
  if (filters.from === yesterday && filters.to === yesterday)
    return "yesterday";
  if (filters.from === shiftDateKey(today, -6) && filters.to === today)
    return "week";
  if (filters.from === startOfMonthKey(today) && filters.to === today)
    return "month";
  return "";
}

export function syncReportPresetButtons(filters = getReportFilters()) {
  const active = activeReportPreset(filters);
  appState.$reportPresetButtons.forEach((btn) => {
    btn.classList.toggle("is-active", btn.dataset.reportPreset === active);
  });
}
