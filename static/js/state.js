import { createDefaults } from "./defaults.js";
import { loadAchievements } from "./achievements.js";
import { loadActionLog, saveActionLog } from "./journal.js";
import {
  loadMeta,
  loadSessions,
  loadStations,
  maybeMigrateStationDefinitionsFromLegacyStations,
} from "./persistence.js";
import { ensureSelectedTariffs, loadSettings } from "./settings-model.js";
import {
  defaultStationName,
  defaultStations,
  getStationDefinitionById,
  getStationDefinitions,
  syncStationsWithDefinitions,
} from "./stations.js";

export const state = {};
const appState = state;

export function initializeState() {
  Object.assign(appState, createDefaults());
  ("use strict");

  appState._actionGuardMap = new Map();
  appState.meta = loadMeta();
  appState.lastModified = Number.isFinite(appState.meta.lastModified)
    ? appState.meta.lastModified
    : 0;
  appState.dirtySinceFlush = false;
  appState.lastFlushSucceededAt = 0;
  appState._flushTimer = null;
  appState._flushInFlight = false;
  appState._flushRequested = false;
  appState.serverRevision = 0;
  appState.user = null;
  appState.csrf = '';
  appState.activeShift = null;
  appState.saveConflict = false;
  appState.saveFailed = false;
  appState.pendingBackup = null;

  appState.$grid = document.getElementById("stations");
  appState.$appShell = document.getElementById("appShell");
  appState.$nowClock = document.getElementById("nowClock");
  appState.$activeCount = document.getElementById("activeCount");
  appState.$toast = document.getElementById("toast");
  appState.$licenseGate = document.getElementById("licenseGate");
  appState.$licenseFingerprint = document.getElementById("licenseFingerprint");
  appState.$licenseLead = document.getElementById("licenseLead");
  appState.$licenseNote = document.getElementById("licenseNote");
  appState.$licenseKeyInput = document.getElementById("licenseKeyInput");
  appState.$btnLicenseActivate = document.getElementById("btnLicenseActivate");
  appState.$btnLicenseRetry = document.getElementById("btnLicenseRetry");
  appState.$ctlTitle = document.getElementById("ctlTitle");
  appState.$ctlPill = document.getElementById("ctlPill");
  appState.$ctlMeta = document.getElementById("ctlMeta");
  appState.$control = document.getElementById("control");
  appState.$ctlMetaMain = document.getElementById("ctlMetaMain");
  appState.$ctlMetaSub = document.getElementById("ctlMetaSub");
  appState.$ctlMetaStatusLabel = document.getElementById("ctlMetaStatusLabel");
  appState.$ctlMetaStatus = document.getElementById("ctlMetaStatus");
  appState.$ctlMetaUntilLabel = document.getElementById("ctlMetaUntilLabel");
  appState.$ctlMetaUntil = document.getElementById("ctlMetaUntil");
  appState.$tariffs = document.getElementById("tariffs");
  appState.$btnStart = document.getElementById("btnStart");
  appState.$btnExtend = document.getElementById("btnExtend");
  appState.$btnStop = document.getElementById("btnStop");
  appState.$btnUndo = document.getElementById("btnUndo");
  appState.$btnRestoreLast = document.getElementById("btnRestoreLast");
  appState.$undoNote = document.getElementById("undoNote");
  appState.$btnToggleCustom = document.getElementById("btnToggleCustom");
  appState.$customRow = document.getElementById("customRow");
  appState.$customMinutes = document.getElementById("customMinutes");
  appState.$btnCustomSet = document.getElementById("btnCustomSet");
  appState.$btnCustomAdd = document.getElementById("btnCustomAdd");
  appState.$btnPaidAdd30 = document.getElementById("btnPaidAdd30");
  appState.$btnPaidAdd60 = document.getElementById("btnPaidAdd60");
  appState.$paymentMethodButtons = document.getElementById(
    "paymentMethodButtons",
  );
  appState.$selectedTariffPrice = document.getElementById(
    "selectedTariffPrice",
  );
  appState.$btnSessions = document.getElementById("btnSessions");
  appState.$sessionsModal = document.getElementById("sessionsModal");
  appState.$btnCloseSessions = document.getElementById("btnCloseSessions");
  appState.$btnClearToday = document.getElementById("btnClearToday");
  appState.$btnExportToday = document.getElementById("btnExportToday");
  appState.$btnCloseShift = document.getElementById("btnCloseShift");
  appState.$sessionsList = document.getElementById("sessionsList");
  appState.$sessionsSub = document.getElementById("sessionsSub");
  appState.$summaryRevenue = document.getElementById("summaryRevenue");
  appState.$summarySessions = document.getElementById("summarySessions");
  appState.$summaryAvgCheck = document.getElementById("summaryAvgCheck");
  appState.$summaryPaid = document.getElementById("summaryPaid");
  appState.$btnReports = document.getElementById("btnReports");
  appState.$btnJournal = document.getElementById("btnJournal");
  appState.$btnAchievements = document.getElementById("btnAchievements");
  appState.$achievementsBadge = document.getElementById("achievementsBadge");
  appState.$achievementsModal = document.getElementById("achievementsModal");
  appState.$achievementsContent = appState.$achievementsModal?.querySelector(
    ".modal__content--achievements",
  );
  appState.$btnCloseAchievements = document.getElementById(
    "btnCloseAchievements",
  );
  appState.$achievementSummaryUnlocked = document.getElementById(
    "achievementSummaryUnlocked",
  );
  appState.$achievementSummaryInProgress = document.getElementById(
    "achievementSummaryInProgress",
  );
  appState.$achievementSummaryLatest = document.getElementById(
    "achievementSummaryLatest",
  );
  appState.$achievementHero =
    appState.$achievementsModal?.querySelector(".achievementHero");
  appState.$achievementHeroLead = document.getElementById(
    "achievementHeroLead",
  );
  appState.$achievementHeroCount = document.getElementById(
    "achievementHeroCount",
  );
  appState.$achievementHeroNext = document.getElementById(
    "achievementHeroNext",
  );
  appState.$achievementSpotlight = document.getElementById(
    "achievementSpotlight",
  );
  appState.$achievementFilters = document.getElementById("achievementFilters");
  appState.$achievementsList = document.getElementById("achievementsList");
  appState.$journalModal = document.getElementById("journalModal");
  appState.$btnCloseJournal = document.getElementById("btnCloseJournal");
  appState.$btnClearJournal = document.getElementById("btnClearJournal");
  appState.$btnExportJournal = document.getElementById("btnExportJournal");
  appState.$journalList = document.getElementById("journalList");
  appState.$journalSub = document.getElementById("journalSub");
  appState.$journalCount = document.getElementById("journalCount");
  appState.$journalStats = document.getElementById("journalStats");
  appState.$journalStationFilter = document.getElementById(
    "journalStationFilter",
  );
  appState.$journalLevelFilter = document.getElementById("journalLevelFilter");
  appState.$btnResetJournalFilters = document.getElementById(
    "btnResetJournalFilters",
  );
  appState.$journalActiveFilters = document.getElementById(
    "journalActiveFilters",
  );
  appState.$journalSearch = document.getElementById("journalSearch");
  appState.$journalResultsInfo = document.getElementById("journalResultsInfo");
  appState.$reportsModal = document.getElementById("reportsModal");
  appState.$btnCloseReports = document.getElementById("btnCloseReports");
  appState.$btnExportReports = document.getElementById("btnExportReports");
  appState.$reportDateFrom = document.getElementById("reportDateFrom");
  appState.$reportDateTo = document.getElementById("reportDateTo");
  appState.$reportDateFromText = document.getElementById("reportDateFromText");
  appState.$reportDateToText = document.getElementById("reportDateToText");
  appState.$reportDateFromTrigger = document.getElementById(
    "reportDateFromTrigger",
  );
  appState.$reportDateToTrigger = document.getElementById(
    "reportDateToTrigger",
  );
  appState.$reportDateFromLabel = document.getElementById(
    "reportDateFromLabel",
  );
  appState.$reportDateToLabel = document.getElementById("reportDateToLabel");
  appState.$reportDateFromPicker = document.getElementById(
    "reportDateFromPicker",
  );
  appState.$reportDateToPicker = document.getElementById("reportDateToPicker");
  appState.$reportStationType = document.getElementById("reportStationType");
  appState.$reportPayment = document.getElementById("reportPayment");
  appState.$reportView = document.getElementById("reportView");
  appState.$reportRevenue = document.getElementById("reportRevenue");
  appState.$reportSessionsCount = document.getElementById(
    "reportSessionsCount",
  );
  appState.$reportAvgCheck = document.getElementById("reportAvgCheck");
  appState.$reportAvgDuration = document.getElementById("reportAvgDuration");
  appState.$reportTypeTotals = document.getElementById("reportTypeTotals");
  appState.$reportPaymentTotals = document.getElementById(
    "reportPaymentTotals",
  );
  appState.$reportsList = document.getElementById("reportsList");
  appState.$reportsSub = document.getElementById("reportsSub");
  appState.$reportChart = document.getElementById("reportChart");
  appState.$reportPresetButtons = Array.from(
    document.querySelectorAll("[data-report-preset]"),
  );
  appState.$pinModal = document.getElementById("pinModal");
  appState.$pinInput = document.getElementById("pinInput");
  appState.$pinNote = document.getElementById("pinNote");
  appState.$btnPinSubmit = document.getElementById("btnPinSubmit");
  appState.$btnPinCancel = document.getElementById("btnPinCancel");
  appState.$btnClosePin = document.getElementById("btnClosePin");
  appState.$btnSettings = document.getElementById("btnSettings");
  appState.$settingsModal = document.getElementById("settingsModal");
  appState.$btnCloseSettings = document.getElementById("btnCloseSettings");
  appState.$btnSaveSettings = document.getElementById("btnSaveSettings");
  appState.$btnResetSettings = document.getElementById("btnResetSettings");
  appState.$settingsTariffs = document.getElementById("settingsTariffs");
  appState.$settingsTypeTabs = document.getElementById("settingsTypeTabs");
  appState.$settingsTypeTitle = document.getElementById("settingsTypeTitle");
  appState.$settingsCustomRate = document.getElementById("settingsCustomRate");
  appState.$settingsGraceMinutes = document.getElementById(
    "settingsGraceMinutes",
  );
  appState.$settingsOverdueMinutes = document.getElementById(
    "settingsOverdueMinutes",
  );
  appState.$settingsPinCurrent = document.getElementById("settingsPinCurrent");
  appState.$settingsPinNew = document.getElementById("settingsPinNew");
  appState.$settingsPinRepeat = document.getElementById("settingsPinRepeat");
  appState.$settingsNotificationSound = document.getElementById(
    "settingsNotificationSound",
  );
  appState.$btnTestNotificationSound = document.getElementById(
    "btnTestNotificationSound",
  );
  appState.$btnChangePin = document.getElementById("btnChangePin");
  appState.$subtitle = document.getElementById("subtitle");
  appState.$btnAddTariff = document.getElementById("btnAddTariff");
  appState.$settingsStations = document.getElementById("settingsStations");
  appState.$btnAddStation = document.getElementById("btnAddStation");
  appState.$settingsDirtyBadge = document.getElementById("settingsDirtyBadge");
  appState.settingsEditorType = "ps";
  appState.settingsDraft = null;
  appState.settingsModalUnlocked = false;
  appState.settingsDraftDirty = false;
  appState.settingsRenderInProgress = false;
  appState.settingsBaselineSignature = "";
  appState.reportDatePickerOpen = "";
  appState.reportDatePickerMonth = { from: "", to: "" };
  appState.settings = loadSettings();
  appState.stations = loadStations();
  appState.stations = syncStationsWithDefinitions(
    appState.stations,
    getStationDefinitions(appState.settings),
  );
  appState.sessions = loadSessions();
  appState.actionLog = loadActionLog();
  appState.achievements = loadAchievements();
  appState.achievementFilter = "all";
  if (appState.actionLog.length > appState.ACTION_LOG_MAX) {
    appState.actionLog = appState.actionLog.slice(0, appState.ACTION_LOG_MAX);
    saveActionLog();
  }
  appState.selectedStationId = null;
  appState.selectedTariffIds = { ps: null, simulator: null, switch: null };
  ensureSelectedTariffs();
  appState.selectedPaymentMethod = "cash";
  appState.appInitialized = false;
  appState.licenseStatusCache = null;
  appState.tickTimer = null;
  appState.lastTickWallClock = Date.now();
  appState.notificationAudioCtx = null;
  appState.notificationAudioUnlockBound = false;
  appState.lastTimeJumpToastAt = 0;
}
