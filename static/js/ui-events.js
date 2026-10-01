import {
  closeAchievements,
  openAchievements,
  renderAchievements,
} from "./achievements.js";
import {
  canRunGuardedAction,
  closeJournal,
  closeJournalSelects,
  exportJournalTXT,
  openJournal,
  renderJournal,
  resetJournalFilters,
  saveActionLog,
  setJournalSelectValue,
  toggleJournalSelect,
  updateJournalFilterInfo,
  withButtonGuard,
} from "./journal.js";
import {
  playNotificationTone,
  unlockNotificationAudio,
} from "./notifications.js";
import {
  applyReportPreset,
  closeReportDatePickers,
  commitReportDateText,
  toggleReportDatePicker,
} from "./report-calendar.js";
import {
  exportReportsXLSX,
  exportTodayJSON,
  exportTodayXLSX,
} from "./report-export.js";
import {
  closeReports,
  closeSessions,
  openReports,
  openSessions,
  renderReports,
  renderSessions,
  todaySessionsList,
} from "./reports.js";
import {
  addPaidMinutes,
  adjustMinutes,
  applyCustom,
  applyTariff,
  stopStation,
  undoLast,
} from "./session-actions.js";
import { restoreLastClosedSession } from "./session-recovery.js";
import {
  changeSettingsPin,
  closePinModal,
  requestSettingsAccess,
  submitPinAccess,
} from "./settings-access.js";
import {
  addStationDefinition,
  addTariffRow,
  closeSettings,
  resetSettings,
  saveSettingsFromModal,
  syncSettingsDirtyState,
} from "./settings-editor.js";
import { state as appState } from "./state.js";
import { updateSubtitle } from "./ui-rendering.js";
import { toast } from "./ui-utils.js";
import { openBusiness } from "./business-ui.js";

export function bindUI() {
  appState.$btnSessions.addEventListener("click", openSessions);
  appState.$btnAchievements?.addEventListener("click", openAchievements);
  appState.$btnCloseSessions?.addEventListener("click", closeSessions);
  appState.$btnCloseAchievements?.addEventListener("click", closeAchievements);
  appState.$sessionsModal.addEventListener("click", (e) => {
    if (e.target === appState.$sessionsModal) closeSessions();
  });
  appState.$achievementsModal?.addEventListener("click", (e) => {
    if (e.target === appState.$achievementsModal) closeAchievements();
  });
  appState.$achievementFilters?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-achievement-filter]");
    if (!btn) return;
    appState.achievementFilter =
      btn.getAttribute("data-achievement-filter") || "all";
    renderAchievements();
  });
  // Financial history is retained; closing a shift never deletes sessions.
  if (appState.$btnClearToday) appState.$btnClearToday.hidden = true;
  if (appState.$btnExportToday) {
    appState.$btnExportToday.addEventListener(
      "click",
      withButtonGuard(appState.$btnExportToday, "export_today", async () => {
        const list = todaySessionsList();
        if (!list || list.length === 0) { toast("Сессий за сегодня нет"); return; }
        if (await exportTodayXLSX()) {
          exportTodayJSON();
          toast("Файлы подготовлены к скачиванию");
        }
      }),
    );
  }
  appState.$btnCloseShift?.addEventListener("click", () => void openBusiness("shift"));

  appState.$btnStart.addEventListener(
    "click",
    withButtonGuard(appState.$btnStart, "start", () => applyTariff("set")),
  );
  appState.$btnExtend.addEventListener(
    "click",
    withButtonGuard(appState.$btnExtend, "extend", () => applyTariff("add")),
  );
  appState.$btnStop.addEventListener(
    "click",
    withButtonGuard(appState.$btnStop, "stop", () =>
      stopStation(appState.selectedStationId, "manual"),
    ),
  );
  appState.$btnUndo.addEventListener(
    "click",
    withButtonGuard(appState.$btnUndo, "undo", () =>
      undoLast(appState.selectedStationId),
    ),
  );
  appState.$btnRestoreLast?.addEventListener(
    "click",
    withButtonGuard(appState.$btnRestoreLast, "restore", () =>
      restoreLastClosedSession(appState.selectedStationId),
    ),
  );

  document.addEventListener("click", (e) => {
    const btn = e.target?.closest?.("[data-adjust]");
    if (!btn) return;
    const v = btn.getAttribute("data-adjust");
    const mins = parseInt(v, 10);
    if (!Number.isFinite(mins)) return;
    if (!canRunGuardedAction(`adjust_${mins}`)) return;
    adjustMinutes(appState.selectedStationId, mins);
  });

  appState.$btnToggleCustom.addEventListener("click", () => {
    appState.$customRow.hidden = !appState.$customRow.hidden;
  });
  appState.$btnCustomSet.addEventListener(
    "click",
    withButtonGuard(appState.$btnCustomSet, "custom_set", () =>
      applyCustom("set"),
    ),
  );
  appState.$btnCustomAdd.addEventListener(
    "click",
    withButtonGuard(appState.$btnCustomAdd, "custom_add", () =>
      applyCustom("add"),
    ),
  );
  appState.$btnPaidAdd30?.addEventListener(
    "click",
    withButtonGuard(appState.$btnPaidAdd30, "paid30", () => addPaidMinutes(30)),
  );
  appState.$btnPaidAdd60?.addEventListener(
    "click",
    withButtonGuard(appState.$btnPaidAdd60, "paid60", () => addPaidMinutes(60)),
  );

  appState.$btnJournal?.addEventListener("click", openJournal);
  appState.$btnCloseJournal?.addEventListener("click", closeJournal);
  appState.$journalModal?.addEventListener("click", (e) => {
    const toggle = e.target.closest("[data-journal-select-toggle]");
    if (toggle) {
      e.preventDefault();
      e.stopPropagation();
      toggleJournalSelect(toggle.dataset.journalSelectToggle || "");
      return;
    }
    const option = e.target.closest(
      "[data-journal-select-menu] .cselect__option",
    );
    if (option) {
      e.preventDefault();
      e.stopPropagation();
      const menu = option.closest("[data-journal-select-menu]");
      const kind = menu?.dataset.journalSelectMenu || "";
      if (kind) setJournalSelectValue(kind, option.dataset.value || "all");
      return;
    }
    if (e.target.closest("[data-journal-select]")) return;
    if (e.target === appState.$journalModal) closeJournal();
    else closeJournalSelects();
  });
  appState.$btnClearJournal?.addEventListener(
    "click",
    withButtonGuard(appState.$btnClearJournal, "clear_journal", () => {
      if (!confirm("Очистить журнал действий?")) return;
      appState.actionLog = [];
      saveActionLog();
      renderJournal();
      toast("Журнал очищен");
    }),
  );
  appState.$btnExportJournal?.addEventListener(
    "click",
    withButtonGuard(
      appState.$btnExportJournal,
      "export_journal",
      exportJournalTXT,
    ),
  );
  appState.$btnResetJournalFilters?.addEventListener(
    "click",
    withButtonGuard(
      appState.$btnResetJournalFilters,
      "reset_journal_filters",
      resetJournalFilters,
    ),
  );
  appState.$journalStationFilter?.addEventListener(
    "change",
    updateJournalFilterInfo,
  );
  appState.$journalLevelFilter?.addEventListener(
    "change",
    updateJournalFilterInfo,
  );
  appState.$journalSearch?.addEventListener("input", renderJournal);
  [appState.$journalStationFilter, appState.$journalLevelFilter].forEach(
    (el) => {
      el?.addEventListener("input", renderJournal);
      el?.addEventListener("change", renderJournal);
    },
  );
  appState.$btnReports?.addEventListener("click", openReports);
  appState.$btnCloseReports?.addEventListener("click", closeReports);
  appState.$reportsModal?.addEventListener("click", (e) => {
    if (e.target === appState.$reportsModal) closeReports();
  });
  [
    appState.$reportDateFrom,
    appState.$reportDateTo,
    appState.$reportStationType,
    appState.$reportPayment,
    appState.$reportView,
  ].forEach((el) => {
    el?.addEventListener("input", renderReports);
    el?.addEventListener("change", renderReports);
  });
  appState.$reportDateFromTrigger?.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleReportDatePicker("from");
  });
  appState.$reportDateToTrigger?.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleReportDatePicker("to");
  });
  appState.$reportDateFromText?.addEventListener("blur", () =>
    commitReportDateText("from"),
  );
  appState.$reportDateToText?.addEventListener("blur", () =>
    commitReportDateText("to"),
  );
  appState.$reportDateFromText?.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    commitReportDateText("from");
  });
  appState.$reportDateToText?.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    commitReportDateText("to");
  });
  appState.$reportPresetButtons.forEach((btn) => {
    btn.addEventListener("click", () =>
      applyReportPreset(btn.dataset.reportPreset || "today"),
    );
  });
  appState.$btnExportReports?.addEventListener(
    "click",
    withButtonGuard(
      appState.$btnExportReports,
      "export_reports",
      exportReportsXLSX,
    ),
  );

  initCustomSelects();

  appState.$btnSettings?.addEventListener("click", requestSettingsAccess);
  appState.$btnCloseSettings?.addEventListener("click", closeSettings);
  appState.$btnSaveSettings?.addEventListener("click", saveSettingsFromModal);
  appState.$btnResetSettings?.addEventListener("click", resetSettings);
  appState.$settingsNotificationSound?.addEventListener("change", () => {
    const enabled = !!appState.$settingsNotificationSound.checked;
    if (appState.settingsDraft)
      appState.settingsDraft.notificationSound = enabled;
    appState.settings.notificationSound = enabled;
    unlockNotificationAudio();
    if (enabled) setTimeout(() => playNotificationTone(true), 0);
  });
  appState.$btnTestNotificationSound?.addEventListener("click", async () => {
    unlockNotificationAudio();
    if (!appState.$settingsNotificationSound?.checked) {
      toast("Сначала включи звук уведомлений");
      return;
    }
    const ok = await playNotificationTone(true);
    if (!ok)
      toast(
        "Браузер всё ещё блокирует звук. Кликни по странице и попробуй снова.",
      );
  });
  appState.$btnAddStation?.addEventListener("click", addStationDefinition);
  appState.$btnAddTariff?.addEventListener("click", () => {
    addTariffRow(null, appState.settingsEditorType);
    syncSettingsDirtyState();
  });
  appState.$btnChangePin?.addEventListener("click", changeSettingsPin);
  appState.$btnPinSubmit?.addEventListener("click", submitPinAccess);
  appState.$btnPinCancel?.addEventListener("click", closePinModal);
  appState.$btnClosePin?.addEventListener("click", closePinModal);
  appState.$pinInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submitPinAccess();
  });
  updateSubtitle();
  appState.$settingsModal?.addEventListener("click", (e) => {
    if (e.target === appState.$settingsModal) closeSettings();
  });
  appState.$settingsModal?.addEventListener("input", (e) => {
    if (
      !appState.settingsModalUnlocked ||
      !appState.$settingsModal.classList.contains("modal--open")
    )
      return;
    if (appState.settingsRenderInProgress) return;
    if (e.target.closest(".settingsGrid")) syncSettingsDirtyState();
  });
  appState.$settingsModal?.addEventListener("change", (e) => {
    if (
      !appState.settingsModalUnlocked ||
      !appState.$settingsModal.classList.contains("modal--open")
    )
      return;
    if (appState.settingsRenderInProgress) return;
    if (e.target.closest(".settingsGrid")) syncSettingsDirtyState();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeAllCustomSelects();
      closeReportDatePickers();
      if (appState.$pinModal.classList.contains("modal--open")) closePinModal();
      if (appState.$settingsModal.classList.contains("modal--open"))
        closeSettings();
      if (appState.$sessionsModal.classList.contains("modal--open"))
        closeSessions();
      if (appState.$journalModal.classList.contains("modal--open"))
        closeJournal();
      if (appState.$reportsModal.classList.contains("modal--open"))
        closeReports();
    }
  });
  document.addEventListener("click", (e) => {
    if (e.target.closest(".reportDateField")) return;
    closeReportDatePickers();
  });
}

export function initCustomSelects() {
  document.querySelectorAll("[data-cselect]").forEach((root) => {
    const input = root.querySelector('input[type="hidden"]');
    const toggle = root.querySelector("[data-cselect-toggle]");
    const label = root.querySelector("[data-cselect-label]");
    const menu = root.querySelector("[data-cselect-menu]");
    if (!input || !toggle || !label || !menu || root.dataset.bound === "1")
      return;
    root.dataset.bound = "1";

    const sync = () => {
      const active =
        menu.querySelector(
          `.cselect__option[data-value="${CSS.escape(input.value)}"]`,
        ) || menu.querySelector(".cselect__option");
      menu
        .querySelectorAll(".cselect__option")
        .forEach((btn) => btn.classList.toggle("is-active", btn === active));
      if (active) label.textContent = active.textContent.trim();
    };

    toggle.addEventListener("click", (e) => {
      e.stopPropagation();
      const open = !root.classList.contains("is-open");
      document.querySelectorAll("[data-cselect].is-open").forEach((other) => {
        if (other !== root) {
          other.classList.remove("is-open");
          other
            .querySelector("[data-cselect-toggle]")
            ?.setAttribute("aria-expanded", "false");
        }
      });
      root.classList.toggle("is-open", open);
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
    });

    menu.querySelectorAll(".cselect__option").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        const nextValue = btn.dataset.value || "";
        if (input.value !== nextValue) {
          input.value = nextValue;
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
        }
        sync();
        root.classList.remove("is-open");
        toggle.setAttribute("aria-expanded", "false");
      });
    });

    sync();
  });

  if (!document.body.dataset.cselectBound) {
    document.body.dataset.cselectBound = "1";
    document.addEventListener("click", (e) => {
      if (e.target.closest("[data-cselect]")) return;
      document.querySelectorAll("[data-cselect].is-open").forEach((root) => {
        root.classList.remove("is-open");
        root
          .querySelector("[data-cselect-toggle]")
          ?.setAttribute("aria-expanded", "false");
      });
    });
  }
}

export function closeAllCustomSelects() {
  document.querySelectorAll("[data-cselect].is-open").forEach((root) => {
    root.classList.remove("is-open");
    root
      .querySelector("[data-cselect-toggle]")
      ?.setAttribute("aria-expanded", "false");
  });
}
