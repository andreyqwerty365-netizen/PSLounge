import {
  renderAchievements,
  renderAchievementsButton,
  syncAchievementsState,
} from "./achievements.js";
import { renderJournal, renderJournalStationOptions } from "./journal.js";
import { applyServerState, flushBackupNow, recoverBrowserDraft, scheduleFlush } from "./persistence.js";
import { ensureAuthentication } from "./business-auth.js";
import { initBusinessUI, refreshBusiness } from "./business-ui.js";
import { renderReports, renderSessions } from "./reports.js";
import { init } from "./runtime.js";
import { ensureSelectedTariffs } from "./settings-model.js";
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
  setLicenseGateVisible(false);
  await ensureAuthentication();
  const response = await fetch("/api/backup", { cache: "no-store", credentials: "same-origin" });
  if (!response.ok) throw new Error("state_load_failed");
  let snapshot = await response.json();
  appState.serverRevision = Number(snapshot?.revision) || 0;
  const recovered = await recoverBrowserDraft(snapshot);
  snapshot = recovered.snapshot;
  if (recovered.unresolved) {
    // Keep the cached draft visible and block new sales until recovery completes.
  } else if (snapshot?.stations && snapshot?.sessions) {
    applyServerState(snapshot);
  } else {
    // First installation: preserve any existing browser state during migration.
    appState.stations = syncStationsWithDefinitions(
      appState.stations, getStationDefinitions(appState.settings),
    );
    scheduleFlush(true);
    if (!(await flushBackupNow())) throw new Error("state_save_failed");
  }
  await refreshBusiness();
  renderJournalStationOptions();
  appState.$appShell?.classList.remove("app--shell-hidden");
  if (!appState.appInitialized) init();
  else {
    updateSubtitle();
    ensureSelectedTariffs();
    renderTariffs();
    renderStations(true);
    syncControl();
    syncAchievementsState({ silent: true });
    renderAchievementsButton();
    if (appState.$sessionsModal.classList.contains("modal--open")) renderSessions();
    if (appState.$achievementsModal?.classList.contains("modal--open")) renderAchievements();
    if (appState.$reportsModal.classList.contains("modal--open")) renderReports();
    if (appState.$journalModal.classList.contains("modal--open")) renderJournal();
  }
  initBusinessUI();
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
