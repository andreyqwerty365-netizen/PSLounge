import {
  renderAchievementsButton,
  syncAchievementsState,
} from "./achievements.js";
import { renderJournalStationOptions } from "./journal.js";
import { saveStations } from "./persistence.js";
import { renderSessions } from "./reports.js";
import { cloneJson } from "./session-recovery.js";
import {
  clearSettingsPinFields,
  getSettingsPinHash,
} from "./settings-access.js";
import {
  defaultSettings,
  ensureSelectedTariffs,
  getSelectedStationType,
  makeTariffId,
  normalizeSettings,
  normalizeTariff,
  saveSettings,
  sortTariffs,
} from "./settings-model.js";
import { state as appState } from "./state.js";
import {
  getStationDefinitions,
  makeDefaultStationName,
  nextStationId,
  normalizeStationDefinition,
  syncStationsWithDefinitions,
} from "./stations.js";
import { initCustomSelects } from "./ui-events.js";
import {
  renderStations,
  renderTariffs,
  syncControl,
  updateSubtitle,
} from "./ui-rendering.js";
import { escapeHtml, toast } from "./ui-utils.js";

export function openSettings() {
  appState.settingsEditorType = getSelectedStationType();
  appState.settingsDraft = cloneJson(appState.settings);
  renderSettingsModal();
  clearSettingsPinFields();
  appState.$settingsModal.classList.add("modal--open");
  appState.$settingsModal.setAttribute("aria-hidden", "false");
  rememberSettingsBaseline();
}

export function closeSettings() {
  if (!confirmSettingsClose()) return;
  appState.settingsDraft = null;
  appState.settingsModalUnlocked = false;
  appState.settingsBaselineSignature = "";
  setSettingsDirty(false);
  clearSettingsPinFields();
  appState.$settingsModal.classList.remove("modal--open");
  appState.$settingsModal.setAttribute("aria-hidden", "true");
}

export function getSettingsSource() {
  return appState.settingsDraft || appState.settings;
}

export function captureSettingsTabDraft() {
  if (!appState.settingsDraft || !appState.$settingsTariffs) return true;
  const stationRows = [...document.querySelectorAll(".stationDefRow")];
  const stationDefinitions = [];
  for (const row of stationRows) {
    const id = Number(row.dataset.stationId);
    const name = row.querySelector('[data-role="station-name"]')?.value?.trim();
    const type = String(
      row.querySelector('[data-role="station-type"]')?.value || "",
    )
      .trim()
      .toLowerCase();
    if (
      !Number.isFinite(id) ||
      id <= 0 ||
      !name ||
      !appState.STATION_TYPES[type]
    )
      return false;
    stationDefinitions.push(
      normalizeStationDefinition({ id, name, type }, stationDefinitions.length),
    );
  }
  if (!stationDefinitions.length) return false;
  appState.settingsDraft.stationDefinitions = stationDefinitions;
  const rows = [...document.querySelectorAll(".tariffRow")];
  const tariffs = [];
  for (const row of rows) {
    const label = row.querySelector('[data-role="label"]')?.value?.trim();
    const minutes = Number(row.querySelector('[data-role="minutes"]')?.value);
    const price = Number(row.querySelector('[data-role="price"]')?.value);
    if (
      !label ||
      !Number.isFinite(minutes) ||
      minutes < 10 ||
      !Number.isFinite(price) ||
      price < 0
    ) {
      return false;
    }
    tariffs.push(
      normalizeTariff(
        {
          id: row.dataset.tariffId || makeTariffId(appState.settingsEditorType),
          label,
          minutes,
          price,
        },
        tariffs.length,
        appState.settingsEditorType,
      ),
    );
  }
  if (!tariffs.length) return false;
  appState.settingsDraft.tariffGroups[appState.settingsEditorType] =
    sortTariffs(tariffs);
  const customRate = Number(appState.$settingsCustomRate?.value);
  const graceMinutes = Number(appState.$settingsGraceMinutes?.value);
  const overdueMinutes = Number(appState.$settingsOverdueMinutes?.value);
  if (
    !Number.isFinite(customRate) ||
    customRate < 0 ||
    !Number.isFinite(graceMinutes) ||
    graceMinutes < 0 ||
    !Number.isFinite(overdueMinutes) ||
    overdueMinutes < 0
  ) {
    return false;
  }
  appState.settingsDraft.customRates[appState.settingsEditorType] =
    Math.round(customRate);
  appState.settingsDraft.graceMinutes = Math.round(graceMinutes);
  appState.settingsDraft.overdueMinutes = Math.round(overdueMinutes);
  appState.settingsDraft.notificationSound =
    !!appState.$settingsNotificationSound?.checked;
  return true;
}

export function stationTypeLabel(type) {
  return appState.STATION_TYPES[type]?.label || "Тип";
}

export function renderStationDefinitionRows() {
  if (!appState.$settingsStations || !appState.settingsDraft) return;
  appState.$settingsStations.innerHTML = "";
  const defs = getStationDefinitions(appState.settingsDraft);
  defs.forEach((item, idx) => {
    const row = document.createElement("div");
    row.className = "stationDefRow";
    row.dataset.stationId = String(item.id);
    row.innerHTML = `
      <label class="field stationDefRow__field stationDefRow__field--name">
        <span class="field__label">Название</span>
        <input class="field__input field__input--compact" data-role="station-name" type="text" value="${escapeHtml(item.name)}" />
      </label>
      <label class="field stationDefRow__field">
        <span class="field__label">Тип</span>
        <select class="field__input field__input--compact" data-role="station-type">
          ${Object.values(appState.STATION_TYPES)
            .map(
              (type) =>
                `<option value="${type.id}"${type.id === item.type ? " selected" : ""}>${escapeHtml(type.label)}</option>`,
            )
            .join("")}
        </select>
      </label>
      <div class="stationDefRow__actions">
        <button class="btn btn--ghost btn--mini" data-role="move-up" type="button" ${idx === 0 ? "disabled" : ""}>↑</button>
        <button class="btn btn--ghost btn--mini" data-role="move-down" type="button" ${idx === defs.length - 1 ? "disabled" : ""}>↓</button>
        <button class="btn btn--ghost btn--mini" data-role="remove" type="button" ${defs.length <= 1 ? "disabled" : ""}>Удалить</button>
      </div>
    `;
    row
      .querySelector('[data-role="move-up"]')
      ?.addEventListener("click", () => moveStationDefinition(item.id, -1));
    row
      .querySelector('[data-role="move-down"]')
      ?.addEventListener("click", () => moveStationDefinition(item.id, 1));
    row
      .querySelector('[data-role="remove"]')
      ?.addEventListener("click", () => removeStationDefinition(item.id));
    appState.$settingsStations.appendChild(row);
  });
  appState.$settingsStations
    .querySelectorAll('select[data-role="station-type"]')
    .forEach((select) => {
      const value = String(select.value || "");
      const options = [...select.options].map((option) => ({
        value: option.value,
        label: option.textContent || option.value,
        active: option.value === value,
      }));
      const wrapper = document.createElement("div");
      wrapper.className = "cselect cselect--compact";
      wrapper.setAttribute("data-cselect", "");
      wrapper.innerHTML = `
      <input data-role="station-type" type="hidden" value="${escapeHtml(value)}" />
      <button class="cselect__toggle field__input field__input--compact" type="button" data-cselect-toggle aria-haspopup="listbox" aria-expanded="false">
        <span data-cselect-label>${escapeHtml(stationTypeLabel(value))}</span>
        <span class="cselect__chevron">▾</span>
      </button>
      <div class="cselect__menu" data-cselect-menu role="listbox">
        ${options.map((option) => `<button class="cselect__option${option.active ? " is-active" : ""}" type="button" data-value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</button>`).join("")}
      </div>
    `;
      select.replaceWith(wrapper);
    });
  initCustomSelects();
}

export function addStationDefinition() {
  if (!appState.settingsDraft) return;
  const defs = getStationDefinitions(appState.settingsDraft);
  const type = "ps";
  appState.settingsDraft.stationDefinitions = [
    ...defs,
    normalizeStationDefinition(
      {
        id: nextStationId(defs),
        type,
        name: makeDefaultStationName(type, defs),
      },
      defs.length,
    ),
  ];
  renderStationDefinitionRows();
  syncSettingsDirtyState();
}

export function moveStationDefinition(stationId, delta) {
  if (!appState.settingsDraft) return;
  const defs = [...getStationDefinitions(appState.settingsDraft)];
  const idx = defs.findIndex((item) => item.id === stationId);
  if (idx < 0) return;
  const nextIdx = idx + delta;
  if (nextIdx < 0 || nextIdx >= defs.length) return;
  const [item] = defs.splice(idx, 1);
  defs.splice(nextIdx, 0, item);
  appState.settingsDraft.stationDefinitions = defs;
  renderStationDefinitionRows();
  syncSettingsDirtyState();
}

export function removeStationDefinition(stationId) {
  if (!appState.settingsDraft) return;
  const defs = getStationDefinitions(appState.settingsDraft);
  if (defs.length <= 1) {
    toast("Нужна хотя бы одна станция");
    return;
  }
  const station = appState.stations.find((item) => item.id === stationId);
  if (station && station.status !== "idle") {
    toast("Нельзя удалить активную станцию");
    return;
  }
  appState.settingsDraft.stationDefinitions = defs.filter(
    (item) => item.id !== stationId,
  );
  renderStationDefinitionRows();
  syncSettingsDirtyState();
}

export function renderSettingsTypeTabs() {
  if (!appState.$settingsTypeTabs) return;
  appState.$settingsTypeTabs.innerHTML = "";
  for (const type of ["ps", "simulator", "switch"]) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `chip chip--ghost chip--small${appState.settingsEditorType === type ? " chip--active" : ""}`;
    btn.textContent = stationTypeLabel(type);
    btn.addEventListener("click", () => {
      if (!captureSettingsTabDraft()) {
        toast("Сначала исправь текущие значения");
        return;
      }
      appState.settingsEditorType = type;
      renderSettingsModal();
    });
    appState.$settingsTypeTabs.appendChild(btn);
  }
}

export function renderSettingsModal() {
  if (
    !appState.$settingsTariffs ||
    !appState.$settingsCustomRate ||
    !appState.$settingsGraceMinutes ||
    !appState.$settingsOverdueMinutes
  )
    return;
  appState.settingsRenderInProgress = true;
  try {
    renderSettingsTypeTabs();
    renderStationDefinitionRows();
    appState.$settingsTariffs.innerHTML = "";
    const type = appState.settingsEditorType;
    if (appState.$settingsTypeTitle)
      appState.$settingsTypeTitle.textContent = `Тарифы: ${stationTypeLabel(type)}`;
    const source = getSettingsSource();
    for (const t of sortTariffs(source.tariffGroups?.[type] || []))
      addTariffRow(t, type);
    appState.$settingsCustomRate.value = String(
      Math.max(0, Math.round(source.customRates?.[type] || 0)),
    );
    appState.$settingsGraceMinutes.value = String(
      Math.max(0, Math.round(source.graceMinutes || 0)),
    );
    appState.$settingsOverdueMinutes.value = String(
      Math.max(0, Math.round(source.overdueMinutes || 0)),
    );
    if (appState.$settingsNotificationSound)
      appState.$settingsNotificationSound.checked = !!source.notificationSound;
  } finally {
    appState.settingsRenderInProgress = false;
  }
}

export function addTariffRow(
  tariff = null,
  type = appState.settingsEditorType,
) {
  if (!appState.$settingsTariffs) return;
  const source = getSettingsSource();
  const item = tariff
    ? normalizeTariff(tariff, 0, type)
    : {
        id: makeTariffId(type),
        label: "Новый тариф",
        minutes: 60,
        price:
          source.customRates?.[type] ||
          appState.DEFAULT_CUSTOM_RATES[type] ||
          appState.DEFAULT_CUSTOM_RATES.ps,
      };
  const row = document.createElement("div");
  row.className = "tariffRow";
  row.dataset.tariffId = item.id;
  row.dataset.tariffType = type;
  row.innerHTML = `
    <label class="field tariffRow__field tariffRow__field--label"><span class="field__label">Название</span><input class="field__input field__input--compact" data-role="label" type="text" value="${escapeHtml(item.label)}" /></label>
    <label class="field tariffRow__field"><span class="field__label">Минуты</span><input class="field__input field__input--compact" data-role="minutes" type="number" min="10" step="10" value="${String(item.minutes)}" /></label>
    <label class="field tariffRow__field"><span class="field__label">Цена</span><input class="field__input field__input--compact" data-role="price" type="number" min="0" step="10" value="${String(item.price)}" /></label>
    <div class="tariffRow__actions"><button class="btn btn--ghost btn--mini tariffRow__remove" type="button">Удалить</button></div>
  `;
  row.querySelector(".tariffRow__remove")?.addEventListener("click", () => {
    if (appState.$settingsTariffs.querySelectorAll(".tariffRow").length <= 1) {
      toast("Нужен хотя бы один тариф");
      return;
    }
    row.remove();
    syncSettingsDirtyState();
  });
  appState.$settingsTariffs.appendChild(row);
}

export function saveSettingsFromModal() {
  if (!captureSettingsTabDraft() || !appState.settingsDraft) {
    toast("Проверь тарифы и настройки");
    return;
  }
  const nextDefs = getStationDefinitions(appState.settingsDraft);
  const removedActive = appState.stations.filter(
    (item) =>
      item.status !== "idle" && !nextDefs.find((def) => def.id === item.id),
  );
  if (removedActive.length) {
    toast(
      "Сначала завершите или восстановите активные станции перед удалением",
    );
    return;
  }
  appState.settings = normalizeSettings(appState.settingsDraft);
  appState.stations = syncStationsWithDefinitions(
    appState.stations,
    getStationDefinitions(appState.settings),
  );
  if (
    appState.selectedStationId != null &&
    !appState.stations.find((item) => item.id === appState.selectedStationId)
  )
    appState.selectedStationId = null;
  ensureSelectedTariffs();
  saveSettings(true);
  saveStations(true);
  appState.settingsDraft = cloneJson(appState.settings);
  updateSubtitle();
  renderTariffs();
  renderJournalStationOptions();
  renderStations(true);
  syncControl();
  syncAchievementsState();
  renderAchievementsButton();
  renderSettingsModal();
  rememberSettingsBaseline();
  if (appState.$sessionsModal.classList.contains("modal--open"))
    renderSessions();
  toast("Настройки сохранены");
}

export function resetSettings() {
  const ok = confirm(
    "Сбросить тарифы, кастомные цены и настройки таймера к значениям по умолчанию?",
  );
  if (!ok) return;
  const currentPinHash = getSettingsPinHash();
  appState.settings = defaultSettings();
  appState.settings.pinHash = currentPinHash;
  appState.stations = syncStationsWithDefinitions(
    appState.stations,
    getStationDefinitions(appState.settings),
  );
  ensureSelectedTariffs();
  saveSettings(true);
  saveStations(true);
  updateSubtitle();
  renderJournalStationOptions();
  renderSettingsModal();
  renderTariffs();
  renderStations(true);
  syncControl();
  syncAchievementsState({ silent: true });
  renderAchievementsButton();
  rememberSettingsBaseline();
  toast("Настройки сброшены");
}

export function buildSettingsFormSignature() {
  const source = cloneJson(appState.settingsDraft || appState.settings || {});
  if (!appState.$settingsModal?.classList.contains("modal--open")) {
    return JSON.stringify(source);
  }

  if (Array.isArray(source.stationDefinitions)) {
    source.stationDefinitions = [
      ...document.querySelectorAll(".stationDefRow"),
    ].map((row, idx) => ({
      id: Number(row.dataset.stationId || 0),
      name: String(
        row.querySelector('[data-role="station-name"]')?.value || "",
      ),
      type: String(
        row.querySelector('[data-role="station-type"]')?.value || "",
      ),
      order: idx,
    }));
  }

  source.tariffGroups =
    source.tariffGroups && typeof source.tariffGroups === "object"
      ? source.tariffGroups
      : {};
  source.tariffGroups[appState.settingsEditorType] = [
    ...document.querySelectorAll(".tariffRow"),
  ].map((row, idx) => ({
    id: String(row.dataset.tariffId || ""),
    label: String(row.querySelector('[data-role="label"]')?.value || ""),
    minutes: String(row.querySelector('[data-role="minutes"]')?.value || ""),
    price: String(row.querySelector('[data-role="price"]')?.value || ""),
    order: idx,
  }));

  source.customRates =
    source.customRates && typeof source.customRates === "object"
      ? source.customRates
      : {};
  source.customRates[appState.settingsEditorType] = String(
    appState.$settingsCustomRate?.value || "",
  );
  source.graceMinutes = String(appState.$settingsGraceMinutes?.value || "");
  source.overdueMinutes = String(appState.$settingsOverdueMinutes?.value || "");
  source.notificationSound = !!appState.$settingsNotificationSound?.checked;

  return JSON.stringify(source);
}

export function syncSettingsDirtyState() {
  setSettingsDirty(
    buildSettingsFormSignature() !== appState.settingsBaselineSignature,
  );
}

export function rememberSettingsBaseline() {
  appState.settingsBaselineSignature = buildSettingsFormSignature();
  setSettingsDirty(false);
}

export function setSettingsDirty(dirty) {
  appState.settingsDraftDirty = !!dirty;
  if (appState.$settingsDirtyBadge) {
    appState.$settingsDirtyBadge.hidden = !appState.settingsDraftDirty;
    appState.$settingsDirtyBadge.style.display = appState.settingsDraftDirty
      ? "inline-flex"
      : "none";
  }
  if (appState.$btnSaveSettings) {
    appState.$btnSaveSettings.classList.toggle(
      "btn--glow",
      appState.settingsDraftDirty,
    );
  }
}

export function confirmSettingsClose() {
  if (!appState.settingsDraftDirty) return true;
  return confirm(
    "Есть несохранённые изменения. Закрыть настройки без сохранения?",
  );
}
