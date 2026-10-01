import { openSettings } from "./settings-editor.js";
import { saveSettings } from "./settings-model.js";
import { state as appState } from "./state.js";
import { toast } from "./ui-utils.js";

export function hashPin(pin) {
  const text = String(pin || "").trim();
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a_${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function loadPinGuard() {
  try {
    const raw = localStorage.getItem(appState.PIN_GUARD_KEY);
    if (!raw) return { attempts: 0, lockUntil: 0 };
    const parsed = JSON.parse(raw);
    return {
      attempts: Math.max(0, Math.round(Number(parsed?.attempts) || 0)),
      lockUntil: Math.max(0, Number(parsed?.lockUntil) || 0),
    };
  } catch {
    return { attempts: 0, lockUntil: 0 };
  }
}

export function savePinGuard(state) {
  try {
    localStorage.setItem(
      appState.PIN_GUARD_KEY,
      JSON.stringify({
        attempts: Math.max(0, Math.round(Number(state?.attempts) || 0)),
        lockUntil: Math.max(0, Number(state?.lockUntil) || 0),
      }),
    );
  } catch {}
}

export function clearPinGuard() {
  savePinGuard({ attempts: 0, lockUntil: 0 });
}

export function getSettingsPinHash() {
  return String(
    appState.settings?.pinHash || hashPin(appState.DEFAULT_SETTINGS_PIN),
  );
}

export function formatPinLockRemaining(ms) {
  const totalSec = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  if (minutes > 0)
    return `${minutes} мин ${String(seconds).padStart(2, "0")} сек`;
  return `${seconds} сек`;
}

export function updatePinNote(text = "", isError = false) {
  if (!appState.$pinNote) return;
  appState.$pinNote.textContent =
    text || "PIN нужен только для открытия настроек.";
  appState.$pinNote.classList.toggle("pinNote--error", !!isError);
}

export function openPinModal() {
  const guard = loadPinGuard();
  const now = Date.now();
  if (guard.lockUntil > now) {
    updatePinNote(
      `Слишком много неверных попыток. Повторите через ${formatPinLockRemaining(guard.lockUntil - now)}.`,
      true,
    );
  } else {
    updatePinNote("PIN нужен только для открытия настроек.", false);
  }
  if (appState.$pinInput) appState.$pinInput.value = "";
  appState.$pinModal.classList.add("modal--open");
  appState.$pinModal.setAttribute("aria-hidden", "false");
  setTimeout(() => {
    try {
      appState.$pinInput?.focus();
    } catch {}
  }, 0);
}

export function closePinModal() {
  if (!appState.$pinModal) return;
  appState.$pinModal.classList.remove("modal--open");
  appState.$pinModal.setAttribute("aria-hidden", "true");
  updatePinNote("PIN нужен только для открытия настроек.", false);
}

export function requestSettingsAccess() {
  if (appState.settingsModalUnlocked) {
    openSettings();
    return;
  }
  openPinModal();
}

export function submitPinAccess() {
  const guard = loadPinGuard();
  const now = Date.now();
  if (guard.lockUntil > now) {
    updatePinNote(
      `Слишком много неверных попыток. Повторите через ${formatPinLockRemaining(guard.lockUntil - now)}.`,
      true,
    );
    toast("Доступ временно заблокирован");
    return;
  }

  const pin = String(appState.$pinInput?.value || "").trim();
  if (!pin) {
    updatePinNote("Введи PIN-код.", true);
    return;
  }

  const ok = hashPin(pin) === getSettingsPinHash();
  if (ok) {
    clearPinGuard();
    appState.settingsModalUnlocked = true;
    closePinModal();
    openSettings();
    return;
  }

  const attempts = guard.attempts + 1;
  const next = { attempts, lockUntil: 0 };
  if (attempts >= appState.PIN_MAX_ATTEMPTS) {
    next.attempts = 0;
    next.lockUntil = now + appState.PIN_LOCK_MS;
    updatePinNote(
      `Слишком много неверных попыток. Повторите через ${formatPinLockRemaining(appState.PIN_LOCK_MS)}.`,
      true,
    );
    toast("PIN временно заблокирован на 10 минут");
  } else {
    updatePinNote(
      `Неверный PIN. Осталось попыток: ${appState.PIN_MAX_ATTEMPTS - attempts}.`,
      true,
    );
    toast("Неверный PIN");
  }
  savePinGuard(next);
  if (appState.$pinInput) {
    appState.$pinInput.value = "";
    appState.$pinInput.focus();
  }
}

export function clearSettingsPinFields() {
  if (appState.$settingsPinCurrent) appState.$settingsPinCurrent.value = "";
  if (appState.$settingsPinNew) appState.$settingsPinNew.value = "";
  if (appState.$settingsPinRepeat) appState.$settingsPinRepeat.value = "";
}

export function changeSettingsPin() {
  const current = String(appState.$settingsPinCurrent?.value || "").trim();
  const next = String(appState.$settingsPinNew?.value || "").trim();
  const repeat = String(appState.$settingsPinRepeat?.value || "").trim();
  if (!current || !next || !repeat) {
    toast("Заполни все поля PIN");
    return;
  }
  if (hashPin(current) !== getSettingsPinHash()) {
    toast("Текущий PIN неверный");
    return;
  }
  if (!/^\d{4,8}$/.test(next)) {
    toast("Новый PIN должен состоять из 4–8 цифр");
    return;
  }
  if (next !== repeat) {
    toast("Новый PIN и повтор не совпадают");
    return;
  }
  appState.settings.pinHash = hashPin(next);
  if (appState.settingsDraft)
    appState.settingsDraft.pinHash = appState.settings.pinHash;
  saveSettings(true);
  clearSettingsPinFields();
  toast("PIN обновлён");
}
