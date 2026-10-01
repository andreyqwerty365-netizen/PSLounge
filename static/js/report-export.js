import { flushBackupNow } from "./persistence.js";
import {
  getFilteredReportData,
  getReportFilters,
  todaySessionsList,
} from "./reports.js";
import { labelTariff, paymentLabel, todayKey } from "./sessions.js";
import { stationTypeLabel } from "./settings-editor.js";
import { defaultStationName } from "./stations.js";
import { formatDateRU, hhmm, toast } from "./ui-utils.js";

export function csvEscape(v) {
  const s = String(v ?? "");
  if (/[;"\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function downloadBlob(filename, blob) {
  const a = document.createElement("a");
  const url = URL.createObjectURL(blob);
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadText(filename, text, mime) {
  const blob = new Blob([text], { type: mime || "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function getAttachmentFilename(response, fallback) {
  const cd =
    response.headers.get("Content-Disposition") ||
    response.headers.get("content-disposition") ||
    "";
  const utf8 = cd.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8 && utf8[1]) {
    try {
      return decodeURIComponent(utf8[1]);
    } catch (_) {}
  }
  const plain = cd.match(/filename="?([^";]+)"?/i);
  if (plain && plain[1]) return plain[1];
  return fallback;
}

export async function exportTodayXLSX() {
  if (document.body?.dataset.demo === 'true') { toast('В демонстрации экспорт рабочих файлов недоступен'); return false; }
  if (!(await flushBackupNow())) { toast('Экспорт остановлен: изменения не сохранены'); return false; }
  const key = todayKey();
  try {
    const response = await fetch(`/api/export/today.xlsx?date=${encodeURIComponent(key)}`);
    if (!response.ok) throw new Error('export_failed');
    downloadBlob(getAttachmentFilename(response, `PS_Lounge_${key}.xlsx`), await response.blob());
    toast('Файл XLSX подготовлен');
    return true;
  } catch { toast('Не удалось экспортировать XLSX'); return false; }
}

export async function exportReportsXLSX() {
  if (document.body?.dataset.demo === 'true') { toast('В демонстрации экспорт рабочих файлов недоступен'); return false; }
  if (!(await flushBackupNow())) { toast('Экспорт остановлен: изменения не сохранены'); return false; }
  const filters = getReportFilters();
  const from = filters.from || todayKey();
  const to = filters.to || from;
  const stationType = filters.stationType || "all";
  const payment = filters.payment || "all";
  const qs = new URLSearchParams({ from, to });
  if (stationType && stationType !== "all") qs.set("stationType", stationType);
  if (payment && payment !== "all") qs.set("payment", payment);
  const suffixParts = [];
  if (stationType && stationType !== "all") suffixParts.push(stationType);
  if (payment && payment !== "all") suffixParts.push(payment);
  if (filters.view && filters.view !== "sessions")
    suffixParts.push(filters.view);
  const suffix = suffixParts.length ? `_${suffixParts.join("_")}` : "";
  const fallback =
    from === to
      ? `PS_Lounge_Report_${formatDateRU(from).replaceAll(".", "-")}${suffix}.xlsx`
      : `PS_Lounge_Report_${formatDateRU(from).replaceAll(".", "-")}_${formatDateRU(to).replaceAll(".", "-")}${suffix}.xlsx`;
  return fetch(`/api/export/report.xlsx?${qs.toString()}`)
    .then((r) => {
      if (!r.ok) throw new Error("export failed");
      const filename = getAttachmentFilename(r, fallback);
      return r.blob().then((blob) => ({ blob, filename }));
    })
    .then(({ blob, filename }) => { downloadBlob(filename, blob); toast("Файл XLSX подготовлен"); return true; })
    .catch(() => { toast("Не удалось экспортировать отчёт XLSX"); return false; });
}

export function exportTodayJSON() {
  const list = todaySessionsList();
  const key = todayKey();
  downloadText(
    `PS_Lounge_${key}_sessions.json`,
    JSON.stringify(list, null, 2),
    "application/json;charset=utf-8",
  );
}

export function exportReportsCSV() {
  const { filters, sessionRows, salesRows } = getFilteredReportData();
  const rows = [];
  if (filters.view === "sales") {
    rows.push([
      "Дата",
      "Время",
      "Станция",
      "Тип станции",
      "Тип начисления",
      "Минуты",
      "Сумма",
      "Оплата",
    ]);
    for (const sale of salesRows) {
      rows.push([
        formatDateRU(todayKey(sale.time)),
        hhmm(sale.time),
        sale.stationName || defaultStationName(sale.stationId),
        stationTypeLabel(sale.stationType),
        sale.label || sale.type || "Продажа",
        sale.minutes || 0,
        Math.round(Number(sale.amount) || 0),
        paymentLabel(sale.paymentMethod || "cash"),
      ]);
    }
  } else {
    rows.push([
      "Дата",
      "Станция",
      "Тип станции",
      "Тариф",
      "Старт",
      "Финиш",
      "Сумма",
      "Оплата",
      "Завершение",
    ]);
    for (const rec of sessionRows) {
      rows.push([
        formatDateRU(todayKey(rec.startTime || Date.now())),
        rec.stationName || defaultStationName(rec.stationId),
        stationTypeLabel(rec.stationType),
        rec.tariffLabel ||
          (rec.tariffId ? labelTariff(rec.tariffId, rec.stationType) : "—"),
        rec.startTime ? hhmm(rec.startTime) : "",
        rec.endTime ? hhmm(rec.endTime) : "",
        Math.round(Number(rec.totalAmount) || 0),
        paymentLabel(rec.paymentMethod || "cash"),
        rec.endTime ? (rec.mode === "auto" ? "авто" : "вручную") : "идёт",
      ]);
    }
  }
  const csv = rows
    .map((row) =>
      row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(";"),
    )
    .join("\n");
  const blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `PS_Lounge_reports_${formatDateRU(filters.from).replaceAll(".", "-")}_${formatDateRU(filters.to).replaceAll(".", "-")}_${filters.view}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
