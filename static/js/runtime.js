import {
  renderAchievementsButton,
  syncAchievementsState,
} from "./achievements.js";
import { renderJournalStationOptions } from "./journal.js";
import {
  bindNotificationAudioUnlock,
  handleStationTransition,
} from "./notifications.js";
import { saveStations, scheduleFlush, startAutoSave } from "./persistence.js";
import { renderSessions } from "./reports.js";
import { stopStation } from "./session-actions.js";
import { state as appState } from "./state.js";
import { normalizeStationName } from "./stations.js";
import { bindUI } from "./ui-events.js";
import {
  renderPaymentMethods,
  renderStations,
  renderTariffs,
  syncControl,
} from "./ui-rendering.js";
import { toast } from "./ui-utils.js";

export function init() {
  if (appState.appInitialized) return;
  appState.appInitialized = true;
  // migrate legacy station names
  for (const s of appState.stations) {
    if (s && s.name) s.name = normalizeStationName(s.name);
  }
  // migrate legacy sessions stationName
  try {
    for (const k of Object.keys(appState.sessions || {})) {
      const list = appState.sessions[k];
      if (!Array.isArray(list)) continue;
      for (const rec of list) {
        if (rec && rec.stationName)
          rec.stationName = normalizeStationName(rec.stationName);
      }
    }
  } catch {}

  renderTariffs();
  renderPaymentMethods();
  renderStations(true);
  syncAchievementsState();
  renderAchievementsButton();
  startTicking();
  startClock();
  bindNotificationAudioUnlock();
  renderJournalStationOptions();
  bindUI();
  if (appState.$journalSub)
    appState.$journalSub.textContent =
      "Последние действия администратора и защитные срабатывания.";
  syncControl();
  startAutoSave();

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden" && appState.dirtySinceFlush)
      scheduleFlush(true);
  });

  // warn on closing tab/window when there are active stations
  window.addEventListener("beforeunload", (e) => {
    try {
      const hasActive = appState.stations.some(
        (s) => s && s.status && s.status !== "idle",
      );
      if (!hasActive && !appState.dirtySinceFlush) return;
      e.preventDefault();
      e.returnValue = "";
    } catch {}
  });
}

export function startClock() {
  const update = () => {
    const d = new Date();
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    appState.$nowClock.textContent = `${hh}:${mm}`;
  };
  update();
  setInterval(update, 1000);
}

export function startTicking() {
  if (appState.tickTimer) clearInterval(appState.tickTimer);
  appState.lastTickWallClock = Date.now();
  appState.tickTimer = setInterval(() => {
    if (!appState.user || appState.saveConflict) return;
    const now = Date.now();
    const delta = now - appState.lastTickWallClock;
    if (Math.abs(delta - 250) > appState.TIME_JUMP_WARN_MS) {
      const canShowJumpToast =
        !document.hidden &&
        now - appState.lastTimeJumpToastAt >
          appState.TIME_JUMP_TOAST_COOLDOWN_MS;
      if (canShowJumpToast) {
        appState.lastTimeJumpToastAt = now;
        toast(
          "Обнаружен скачок системного времени. Таймеры пересчитаны.",
          3200,
        );
      }
      saveStations(true);
      if (appState.$sessionsModal.classList.contains("modal--open"))
        renderSessions();
    }
    appState.lastTickWallClock = now;

    let changed = false;
    const autoStopIds = [];

    for (const s of appState.stations) {
      if (s.status === "idle" || !Number.isFinite(s.endTime)) continue;

      const prevStatus = s.status;
      const graceEnd = s.endTime + appState.settings.graceMinutes * 60 * 1000;

      if (now < s.endTime) {
        if (s.status !== "running") {
          s.status = "running";
          changed = true;
        }
      } else if (now >= s.endTime && now < graceEnd) {
        if (s.status !== "grace") {
          s.status = "grace";
          changed = true;
        }
      } else if (now >= graceEnd) {
        if (s.status !== "overdue") {
          s.status = "overdue";
          changed = true;
        }
        const autoEnd =
          s.endTime +
          ((appState.settings.graceMinutes || 0) +
            (appState.settings.overdueMinutes || 0)) *
            60 *
            1000;
        if (now >= autoEnd) autoStopIds.push(s.id);
      }

      if (prevStatus !== s.status) {
        handleStationTransition(s, prevStatus, s.status);
      }
    }

    if (autoStopIds.length) {
      for (const id of autoStopIds) stopStation(id, "auto");
      changed = true;
    }

    if (changed) saveStations(true);

    renderStations(false);
    syncControl();
  }, 250);
}
