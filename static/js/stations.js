import { normalizeRecoverySnapshot } from "./session-recovery.js";
import { stationTypeLabel } from "./settings-editor.js";
import { state as appState } from "./state.js";

export function getStationType(stationOrId) {
  if (stationOrId && typeof stationOrId === "object") {
    const direct = String(stationOrId.stationType || stationOrId.type || "")
      .trim()
      .toLowerCase();
    if (appState.STATION_TYPES[direct]) return direct;
  }
  const id =
    typeof stationOrId === "object"
      ? Number(stationOrId?.id)
      : Number(stationOrId);
  const fromSettings = getStationDefinitionById(id);
  if (fromSettings?.type && appState.STATION_TYPES[fromSettings.type])
    return fromSettings.type;
  if (id === 5) return "simulator";
  if (id === 6) return "switch";
  return "ps";
}

export function assetsForStation(stationOrId) {
  const type = getStationType(stationOrId);
  if (type === "switch")
    return {
      ...appState.ASSETS_SWITCH,
      fallbackIdle: appState.ASSETS_PS.idle,
      fallbackActive: appState.ASSETS_PS.active,
    };
  if (type === "simulator")
    return {
      ...appState.ASSETS_SIM,
      fallbackIdle: appState.ASSETS_PS.idle,
      fallbackActive: appState.ASSETS_PS.active,
    };
  return { ...appState.ASSETS_PS, fallbackIdle: null, fallbackActive: null };
}

export function defaultStationDefinitions() {
  return appState.DEFAULT_STATION_DEFINITIONS.map((item) => ({ ...item }));
}

export function normalizeStationDefinition(raw, fallbackIndex = 0) {
  const item = raw && typeof raw === "object" ? raw : {};
  const id = Number.isFinite(Number(item.id))
    ? Math.max(1, Math.round(Number(item.id)))
    : fallbackIndex + 1;
  const requestedType = String(item.type || item.stationType || "")
    .trim()
    .toLowerCase();
  const type = appState.STATION_TYPES[requestedType]
    ? requestedType
    : id === 5
      ? "simulator"
      : id === 6
        ? "switch"
        : "ps";
  const fallbackName =
    defaultStationDefinitions().find((x) => x.id === id)?.name ||
    `${stationTypeLabel(type)} ${fallbackIndex + 1}`;
  const name = normalizeStationName(
    typeof item.name === "string" && item.name.trim()
      ? item.name.trim()
      : fallbackName,
  );
  return { id, name, type };
}

export function sortStationDefinitions(list) {
  return [...list].sort((a, b) => {
    const idDiff = (Number(a.id) || 0) - (Number(b.id) || 0);
    if (idDiff !== 0) return idDiff;
    return String(a.name || "").localeCompare(String(b.name || ""), "ru");
  });
}

export function normalizeStationDefinitions(list) {
  const src = Array.isArray(list) ? list : [];
  const out = [];
  const seen = new Set();
  for (const [idx, item] of src.entries()) {
    const normalized = normalizeStationDefinition(item, idx);
    if (seen.has(normalized.id)) continue;
    seen.add(normalized.id);
    out.push(normalized);
  }
  return out.length ? out : defaultStationDefinitions();
}

export function getStationDefinitions(source = appState.settings) {
  return normalizeStationDefinitions(source?.stationDefinitions);
}

export function getStationDefinitionById(id, source = appState.settings) {
  const stationId = Number(id);
  return (
    getStationDefinitions(source).find(
      (item) => Number(item.id) === stationId,
    ) || null
  );
}

export function nextStationId(defs = getStationDefinitions()) {
  return (
    defs.reduce((maxId, item) => Math.max(maxId, Number(item.id) || 0), 0) + 1
  );
}

export function makeDefaultStationName(type, defs = getStationDefinitions()) {
  if (type === "ps") {
    const count = defs.filter((item) => item.type === "ps").length + 1;
    return `PS${count}`;
  }
  if (type === "simulator") {
    const count = defs.filter((item) => item.type === "simulator").length + 1;
    return count > 1 ? `Симулятор ${count}` : "Симулятор гонок";
  }
  const count = defs.filter((item) => item.type === "switch").length + 1;
  return count > 1 ? `Nintendo Switch ${count}` : "Nintendo Switch";
}

export function createStationState(definition) {
  return {
    id: definition.id,
    name: definition.name,
    stationType: definition.type,
    status: "idle",
    startTime: null,
    endTime: null,
    tariffId: null,
    history: [],
    activeSessionId: null,
    lastClosedSnapshot: null,
  };
}

export function syncStationsWithDefinitions(
  rawStations,
  defs = getStationDefinitions(),
) {
  const source = Array.isArray(rawStations) ? rawStations : [];
  const byId = new Map(source.map((item) => [Number(item?.id), item]));
  return defs.map((definition) => {
    const raw = byId.get(Number(definition.id)) || {};
    return {
      ...createStationState(definition),
      status: ["idle", "running", "grace", "overdue"].includes(raw?.status)
        ? raw.status
        : "idle",
      startTime: Number.isFinite(raw?.startTime) ? raw.startTime : null,
      endTime: Number.isFinite(raw?.endTime) ? raw.endTime : null,
      tariffId: typeof raw?.tariffId === "string" ? raw.tariffId : null,
      history: Array.isArray(raw?.history) ? raw.history : [],
      activeSessionId:
        typeof raw?.activeSessionId === "string" ? raw.activeSessionId : null,
      lastClosedSnapshot: normalizeRecoverySnapshot(raw?.lastClosedSnapshot),
      name: definition.name,
      stationType: definition.type,
    };
  });
}

export function defaultStationName(id) {
  return getStationDefinitionById(id)?.name || `PS${id}`;
}

export function defaultStations() {
  return syncStationsWithDefinitions([], getStationDefinitions());
}

export function normalizeStationName(name) {
  if (!name) return name;
  if (name === "PS23") return "PS3";
  return name;
}
