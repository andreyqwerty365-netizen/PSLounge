import {
  normalizeAchievementsState,
  renderAchievements,
  renderAchievementsButton,
  syncAchievementsState,
} from "./achievements.js";
import { renderJournal, renderJournalStationOptions } from "./journal.js";
import { saveMeta, scheduleFlush } from "./persistence.js";
import { renderReports, renderSessions } from "./reports.js";
import { init } from "./runtime.js";
import { ensureSelectedTariffs, normalizeSettings } from "./settings-model.js";
import { state as appState } from "./state.js";
import {
  getStationDefinitions,
  syncStationsWithDefinitions,
} from "./stations.js";
import {
  renderStations,
  renderTariffs,
  syncControl,
  updateSubtitle,
} from "./ui-rendering.js";
import { toast } from "./ui-utils.js";

export function setLicenseGateVisible(visible) {
  if (appState.$licenseGate) {
    appState.$licenseGate.hidden = !visible;
    appState.$licenseGate.classList.toggle("licenseGate--visible", !!visible);
  }
  appState.$appShell?.classList.toggle("app--shell-hidden", !!visible);
}

export function renderLicenseStatus(status, message = "") {
  const state = status || {};
  const label =
    state.machineFingerprintLabel || state.machineFingerprint || "—";
  if (appState.$licenseFingerprint)
    appState.$licenseFingerprint.textContent = label;
  if (appState.$licenseLead) {
    appState.$licenseLead.textContent = state.licensed
      ? `Лицензия активна${state.customer ? ` для ${state.customer}` : ""}.`
      : "Для работы программы требуется лицензия, привязанная к этому устройству.";
  }
  if (appState.$licenseNote) {
    if (message) {
      appState.$licenseNote.textContent = message;
    } else if (!state.licensed) {
      const reason =
        state.status === "device_mismatch"
          ? "Ключ выпущен для другого устройства."
          : state.status === "invalid"
            ? "Ключ не прошёл локальную проверку."
            : state.status === "corrupt"
              ? "Файл лицензии повреждён. Повторите активацию."
              : "Лицензия проверяется локально и сохраняется на этом компьютере.";
      appState.$licenseNote.textContent = reason;
    } else {
      appState.$licenseNote.textContent =
        "Проверка лицензии выполнена локально.";
    }
  }
}

export async function fetchLicenseStatus() {
  const res = await fetch("/api/license/status", { cache: "no-store" });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(payload?.error || "license_status_failed");
  appState.licenseStatusCache = payload;
  renderLicenseStatus(payload);
  return payload;
}

export async function startLicensedApp() {
  try {
    const res = await fetch("/api/backup", { cache: "no-store" });
    if (res.ok) {
      const b = await res.json();
      const bLM = Number.isFinite(b?.lastModified) ? b.lastModified : 0;
      if (b?.source === "backup" || b?.source === "snapshot") {
        setTimeout(
          () => toast("Состояние восстановлено из резервной копии"),
          300,
        );
      }
      if (bLM > appState.lastModified && b?.stations && b?.sessions) {
        appState.settings =
          b?.settings && typeof b.settings === "object"
            ? normalizeSettings(b.settings)
            : appState.settings;
        appState.stations = syncStationsWithDefinitions(
          b.stations,
          getStationDefinitions(appState.settings),
        );
        appState.sessions = b.sessions;
        appState.achievements = normalizeAchievementsState(b?.achievements);
        appState.lastModified = bLM;
        saveMeta({ lastModified: appState.lastModified });
        localStorage.setItem(
          appState.STORAGE_KEY,
          JSON.stringify(appState.stations),
        );
        localStorage.setItem(
          appState.SESSIONS_KEY,
          JSON.stringify(appState.sessions),
        );
        localStorage.setItem(
          appState.SETTINGS_KEY,
          JSON.stringify(appState.settings),
        );
        localStorage.setItem(
          appState.ACHIEVEMENTS_KEY,
          JSON.stringify(appState.achievements),
        );
      } else if (appState.lastModified > bLM) {
        appState.stations = syncStationsWithDefinitions(
          appState.stations,
          getStationDefinitions(appState.settings),
        );
        scheduleFlush(true);
      }
    }
  } catch {}
  appState.stations = syncStationsWithDefinitions(
    appState.stations,
    getStationDefinitions(appState.settings),
  );
  renderJournalStationOptions();
  setLicenseGateVisible(false);
  if (!appState.appInitialized) {
    init();
    return;
  }
  updateSubtitle();
  ensureSelectedTariffs();
  renderTariffs();
  renderStations(true);
  syncControl();
  syncAchievementsState({ silent: true });
  renderAchievementsButton();
  if (appState.$sessionsModal.classList.contains("modal--open"))
    renderSessions();
  if (appState.$achievementsModal?.classList.contains("modal--open"))
    renderAchievements();
  if (appState.$reportsModal.classList.contains("modal--open")) renderReports();
  if (appState.$journalModal.classList.contains("modal--open")) renderJournal();
}

export async function activateLicense() {
  const token = String(appState.$licenseKeyInput?.value || "").trim();
  if (!token) {
    renderLicenseStatus(
      appState.licenseStatusCache,
      "Вставьте лицензионный ключ.",
    );
    return;
  }
  if (appState.$btnLicenseActivate)
    appState.$btnLicenseActivate.disabled = true;
  try {
    const res = await fetch("/api/license/activate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok || !payload?.licensed) {
      renderLicenseStatus(
        payload,
        `Активация не удалась: ${payload?.detail || payload?.error || "activation_failed"}`,
      );
      return;
    }
    appState.licenseStatusCache = payload;
    renderLicenseStatus(payload, "Лицензия активирована.");
    await startLicensedApp();
  } catch {
    renderLicenseStatus(
      appState.licenseStatusCache,
      "Не удалось связаться с сервером лицензии.",
    );
  } finally {
    if (appState.$btnLicenseActivate)
      appState.$btnLicenseActivate.disabled = false;
  }
}

export function initLicenseGate() {
  appState.$btnLicenseActivate?.addEventListener("click", activateLicense);
  appState.$btnLicenseRetry?.addEventListener("click", () => boot());
}

export async function boot() {
  try {
    const status = await fetchLicenseStatus();
    if (!status?.licensed) {
      setLicenseGateVisible(true);
      return;
    }
    await startLicensedApp();
  } catch {
    setLicenseGateVisible(true);
    renderLicenseStatus(
      appState.licenseStatusCache,
      "Не удалось проверить состояние лицензии.",
    );
  }
}
