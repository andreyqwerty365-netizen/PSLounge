import { storage } from "./storage.js";
import {
  recordAchievementBreakEvent,
  syncAchievementsState,
} from "./achievements.js";
import { downloadText } from "./report-export.js";
import { todayKey } from "./sessions.js";
import { stationTypeLabel } from "./settings-editor.js";
import { state as appState } from "./state.js";
import {
  getStationDefinitions,
  getStationType,
  normalizeStationName,
} from "./stations.js";
import { closeAllCustomSelects } from "./ui-events.js";
import {
  escapeHtml,
  formatDateRU,
  hhmm,
  sanitizeFilenamePart,
  toast,
} from "./ui-utils.js";

export function canRunGuardedAction(key, ms = appState.ACTION_GUARD_MS) {
  const now = Date.now();
  const last = appState._actionGuardMap.get(key) || 0;
  if (now - last < ms) return false;
  appState._actionGuardMap.set(key, now);
  return true;
}

export function withActionGuard(key, fn, ms = appState.ACTION_GUARD_MS) {
  return (...args) => {
    if (!canRunGuardedAction(key, ms)) return;
    return fn(...args);
  };
}

export function withButtonGuard(
  button,
  key,
  fn,
  ms = appState.ACTION_GUARD_MS,
) {
  return (...args) => {
    if (!canRunGuardedAction(key, ms)) return;
    if (button) {
      button.disabled = true;
      setTimeout(() => {
        try {
          button.disabled = false;
        } catch {}
      }, ms);
    }
    return fn(...args);
  };
}

export function loadActionLog() {
  try {
    const raw = storage.getItem(appState.ACTION_LOG_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveActionLog() {
  try {
    storage.setItem(
      appState.ACTION_LOG_KEY,
      JSON.stringify(appState.actionLog.slice(0, appState.ACTION_LOG_MAX)),
    );
  } catch {}
}

export function addActionLog(
  action,
  station = null,
  details = "",
  level = "info",
  options = {},
) {
  const entry = {
    id: `log_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
    ts: Date.now(),
    action: String(action || "Действие"),
    level: level === "warn" ? "warn" : "info",
    stationId: station?.id ?? null,
    stationName: station?.name ? normalizeStationName(station.name) : "",
    stationType: station ? getStationType(station) : "",
    details: String(details || "").trim(),
  };
  appState.actionLog.unshift(entry);
  if (appState.actionLog.length > appState.ACTION_LOG_MAX)
    appState.actionLog.length = appState.ACTION_LOG_MAX;
  saveActionLog();
  if (appState.$journalModal?.classList.contains("modal--open"))
    renderJournal();
  if (appState.ACHIEVEMENT_BREAK_ACTIONS.has(entry.action))
    recordAchievementBreakEvent(entry.ts);
  if (!options?.suppressAchievementSync) syncAchievementsState();
  return entry;
}

export function rejectAction(station, reason) {
  addActionLog("Отклонено", station, reason, "warn");
  toast(reason);
}

export function getJournalEntryStationName(item) {
  const stationId = String(item?.stationId || "").trim();
  if (stationId) {
    const station = getStationDefinitions().find(
      (entry) => String(entry.id) === stationId,
    );
    if (station?.name) return station.name;
  }
  return item?.stationName || "—";
}

export function exportJournalTXT() {
  const rows = getFilteredJournalEntries();
  const lines = rows.map((item) => {
    const station = getJournalEntryStationName(item);
    const level = item.level === "warn" ? "WARNING" : "INFO";
    const details = item.details ? ` | ${item.details}` : "";
    return `[${formatDateRU(item.ts)} ${hhmm(item.ts)}] ${level} | ${station} | ${item.action}${details}`;
  });
  const stationFilter = appState.$journalStationFilter?.value || "all";
  const levelFilter = appState.$journalLevelFilter?.value || "all";
  const search = String(appState.$journalSearch?.value || "").trim();
  const suffixParts = [];
  if (stationFilter !== "all")
    suffixParts.push(sanitizeFilenamePart(journalStationLabel(stationFilter)));
  if (levelFilter !== "all") suffixParts.push(levelFilter);
  if (search) suffixParts.push(sanitizeFilenamePart(search).slice(0, 24));
  const suffix = suffixParts.length ? `_${suffixParts.join("_")}` : "";
  downloadText(
    `PS_Lounge_Journal_${todayKey()}${suffix}.txt`,
    lines.join("\n") || "Журнал пуст",
    "text/plain;charset=utf-8",
  );
}

export function getFilteredJournalEntries() {
  const stationFilter = appState.$journalStationFilter?.value || "all";
  const levelFilter = appState.$journalLevelFilter?.value || "all";
  const search = String(appState.$journalSearch?.value || "")
    .trim()
    .toLocaleLowerCase("ru");
  return appState.actionLog.filter((item) => {
    if (
      stationFilter !== "all" &&
      String(item.stationId || "") !== stationFilter
    )
      return false;
    if (levelFilter !== "all" && item.level !== levelFilter) return false;
    if (search) {
      const hay = [
        item.action,
        item.stationName,
        item.stationType ? stationTypeLabel(item.stationType) : "",
        item.details,
        item.level === "warn" ? "предупреждение" : "событие",
      ]
        .join(" ")
        .toLocaleLowerCase("ru");
      if (!hay.includes(search)) return false;
    }
    return true;
  });
}

export function renderJournal() {
  if (!appState.$journalList) return;
  const rows = getFilteredJournalEntries();
  if (appState.$journalCount)
    appState.$journalCount.textContent = String(rows.length);
  if (appState.$journalStats) {
    const warns = rows.filter((x) => x.level === "warn").length;
    const info = rows.length - warns;
    appState.$journalStats.textContent = `Обычные: ${info} • Предупреждения: ${warns}`;
  }
  if (appState.$journalResultsInfo) {
    appState.$journalResultsInfo.textContent = `Показано ${rows.length} из ${appState.actionLog.length}`;
  }
  updateJournalFilterInfo();
  if (!rows.length) {
    appState.$journalList.innerHTML =
      '<div class="sessionRow"><div class="sessionRow__left"><div class="sessionRow__title">Пусто</div><div class="sessionRow__meta">Записей журнала пока нет.</div></div></div>';
    return;
  }
  appState.$journalList.innerHTML = "";
  rows.forEach((item, idx) => {
    const row = document.createElement("div");
    row.className = "journalRow journalRow--enter";
    row.style.animationDelay = `${Math.min(idx, 8) * 35}ms`;
    const stationText = getJournalEntryStationName(item);
    const typeText = item.stationType
      ? stationTypeLabel(item.stationType)
      : "—";
    const isWarn = item.level === "warn";
    row.innerHTML = `
      <div class="journalRow__left">
        <div class="journalRow__title"><span class="journalIcon" aria-hidden="true">${isWarn ? "⚠" : "ℹ"}</span>${escapeHtml(item.action)}</div>
        <div class="journalRow__meta">${escapeHtml(stationText)} • ${escapeHtml(typeText)}<br>${escapeHtml(item.details || "Без деталей")}</div>
      </div>
      <div class="journalRow__right">
        <div><span class="journalTag journalTag--${isWarn ? "warn" : "info"}">${isWarn ? "ПРЕДУПРЕЖДЕНИЕ" : "СОБЫТИЕ"}</span></div>
        <div>${formatDateRU(item.ts)} • ${hhmm(item.ts)}</div>
      </div>
    `;
    appState.$journalList.appendChild(row);
    requestAnimationFrame(() => row.classList.remove("journalRow--enter"));
  });
}

export function openJournal() {
  appState.$journalModal.classList.add("modal--open");
  appState.$journalModal.setAttribute("aria-hidden", "false");
  renderJournalStationOptions();
  syncJournalSelect("station");
  syncJournalSelect("level");
  renderJournal();
  updateJournalFilterInfo();
}

export function closeJournal() {
  closeJournalSelects();
  closeAllCustomSelects();
  appState.$journalModal.classList.remove("modal--open");
  appState.$journalModal.setAttribute("aria-hidden", "true");
}

export function journalStationLabel(value) {
  const normalized = String(value || "all");
  if (normalized === "all") return "Все станции";
  const station = getStationDefinitions().find(
    (item) => String(item.id) === normalized,
  );
  return station?.name || "Все станции";
}

export function journalLevelLabel(value) {
  if (value === "info") return "Обычные";
  if (value === "warn") return "Предупреждения";
  return "Все";
}

export function getJournalSelectRoot(kind) {
  return document.querySelector(`[data-journal-select="${kind}"]`);
}

export function syncJournalSelect(kind) {
  const root = getJournalSelectRoot(kind);
  const input =
    kind === "station"
      ? appState.$journalStationFilter
      : appState.$journalLevelFilter;
  if (!root || !input) return;
  const label = root.querySelector(`[data-journal-select-label="${kind}"]`);
  const menu = root.querySelector(`[data-journal-select-menu="${kind}"]`);
  const value = String(input.value || "all");
  const text =
    kind === "station" ? journalStationLabel(value) : journalLevelLabel(value);
  if (label) label.textContent = text;
  menu?.querySelectorAll(".cselect__option").forEach((btn) => {
    btn.classList.toggle(
      "is-active",
      String(btn.dataset.value || "") === value,
    );
  });
}

export function closeJournalSelects() {
  document.querySelectorAll("[data-journal-select].is-open").forEach((root) => {
    root.classList.remove("is-open");
    root
      .querySelector("[data-journal-select-toggle]")
      ?.setAttribute("aria-expanded", "false");
  });
}

export function toggleJournalSelect(kind) {
  const root = getJournalSelectRoot(kind);
  const toggle = root?.querySelector(`[data-journal-select-toggle="${kind}"]`);
  if (!root || !toggle) return;
  const open = !root.classList.contains("is-open");
  closeJournalSelects();
  root.classList.toggle("is-open", open);
  toggle.setAttribute("aria-expanded", open ? "true" : "false");
}

export function setJournalSelectValue(kind, value) {
  const input =
    kind === "station"
      ? appState.$journalStationFilter
      : appState.$journalLevelFilter;
  if (!input) return;
  const nextValue = String(value || "all");
  if (String(input.value || "all") !== nextValue) {
    input.value = nextValue;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }
  syncJournalSelect(kind);
  closeJournalSelects();
}

export function applyJournalFilterVisualState() {
  const stationActive =
    (appState.$journalStationFilter?.value || "all") !== "all";
  const levelActive = (appState.$journalLevelFilter?.value || "all") !== "all";
  const searchActive =
    String(appState.$journalSearch?.value || "").trim() !== "";
  const stationWrap =
    appState.$journalStationFilter?.closest(".cselect, .field");
  const levelWrap = appState.$journalLevelFilter?.closest(".cselect, .field");
  const searchWrap = appState.$journalSearch?.closest(".field");
  stationWrap?.classList.toggle("is-filter-active", stationActive);
  levelWrap?.classList.toggle("is-filter-active", levelActive);
  searchWrap?.classList.toggle("is-filter-active", searchActive);
}

export function updateJournalFilterInfo() {
  const st = appState.$journalStationFilter?.value || "all";
  const lv = appState.$journalLevelFilter?.value || "all";
  const search = String(appState.$journalSearch?.value || "").trim();
  if (appState.$journalSub) {
    appState.$journalSub.textContent =
      "Последние действия администратора и защитные срабатывания.";
  }
  if (appState.$journalActiveFilters) {
    const parts = [];
    if (st !== "all") parts.push(journalStationLabel(st));
    if (lv !== "all") parts.push(journalLevelLabel(lv));
    if (search) parts.push(`поиск: ${search}`);
    if (!parts.length) {
      appState.$journalActiveFilters.textContent = "Активные фильтры: нет";
      appState.$journalActiveFilters.classList.remove("is-active");
    } else {
      appState.$journalActiveFilters.textContent = `Активные фильтры: ${parts.join(" • ")}`;
      appState.$journalActiveFilters.classList.add("is-active");
    }
  }
  applyJournalFilterVisualState();
}

export function resetJournalFilters() {
  if (appState.$journalStationFilter) {
    appState.$journalStationFilter.value = "all";
  }
  if (appState.$journalSearch) appState.$journalSearch.value = "";
  if (appState.$journalLevelFilter) {
    appState.$journalLevelFilter.value = "all";
  }
  syncJournalSelect("station");
  syncJournalSelect("level");
  closeJournalSelects();
  renderJournal();
}

export function renderJournalStationOptions() {
  if (!appState.$journalStationFilter) return;
  const defs = getStationDefinitions();
  const menu = document.querySelector('[data-journal-select-menu="station"]');
  const current = String(appState.$journalStationFilter.value || "all");
  const nextValue =
    current !== "all" && defs.find((item) => String(item.id) === current)
      ? current
      : "all";
  appState.$journalStationFilter.value = nextValue;
  if (menu) {
    menu.innerHTML = [
      '<button class="cselect__option" type="button" data-value="all">Все станции</button>',
      ...defs.map(
        (item) =>
          `<button class="cselect__option" type="button" data-value="${escapeHtml(String(item.id))}">${escapeHtml(item.name)}</button>`,
      ),
    ].join("");
  }
  syncJournalSelect("station");
  syncJournalSelect("level");
}
