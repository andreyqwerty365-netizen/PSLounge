'use strict';

const ASSETS_PS = {
  idle: '/static/assets/dualsense_idle.png',
  active: '/static/assets/dualsense_active.png',
  hint: 'dualsense_idle.png / dualsense_active.png',
};

const ASSETS_SIM = {
  idle: '/static/assets/racing_idle.png',
  active: '/static/assets/racing_idle.png',
  hint: 'racing_idle.png',
};

const ASSETS_SWITCH = {
  idle: '/static/assets/switch_idle.png',
  active: '/static/assets/switch_active.png',
  hint: 'switch_idle.png / switch_active.png',
};

const STATION_TYPES = {
  ps: { id: 'ps', label: 'PlayStation' },
  simulator: { id: 'simulator', label: 'Симулятор' },
  switch: { id: 'switch', label: 'Nintendo Switch' },
};

function getStationType(stationOrId) {
  if (stationOrId && typeof stationOrId === 'object') {
    const direct = String(stationOrId.stationType || stationOrId.type || '').trim().toLowerCase();
    if (STATION_TYPES[direct]) return direct;
  }
  const id = typeof stationOrId === 'object' ? Number(stationOrId?.id) : Number(stationOrId);
  const fromSettings = getStationDefinitionById(id);
  if (fromSettings?.type && STATION_TYPES[fromSettings.type]) return fromSettings.type;
  if (id === 5) return 'simulator';
  if (id === 6) return 'switch';
  return 'ps';
}

function assetsForStation(stationOrId) {
  const type = getStationType(stationOrId);
  if (type === 'switch') return { ...ASSETS_SWITCH, fallbackIdle: ASSETS_PS.idle, fallbackActive: ASSETS_PS.active };
  if (type === 'simulator') return { ...ASSETS_SIM, fallbackIdle: ASSETS_PS.idle, fallbackActive: ASSETS_PS.active };
  return { ...ASSETS_PS, fallbackIdle: null, fallbackActive: null };
}


const STORAGE_KEY = 'pslounge_stations_v7';
const SESSIONS_KEY = 'pslounge_sessions_v7';
const SETTINGS_KEY = 'pslounge_settings_v3';
const ACHIEVEMENTS_KEY = 'pslounge_achievements_v1';


const META_KEY = 'pslounge_meta_v1'; // stores lastModified for disk backup sync
const AUTOSAVE_INTERVAL_MS = 15000;
const RECOVERY_WINDOW_MINUTES = 10;
const PIN_GUARD_KEY = 'pslounge_pin_guard_v1';
const DEFAULT_SETTINGS_PIN = '4826';
const PIN_MAX_ATTEMPTS = 3;
const PIN_LOCK_MS = 10 * 60 * 1000;
const TIME_JUMP_WARN_MS = 30 * 1000;
const TIME_JUMP_TOAST_COOLDOWN_MS = 2 * 60 * 1000;
const HISTORY_RETENTION_DAYS = 30;
const ACTION_LOG_KEY = 'pslounge_action_log_v1';
const ACTION_LOG_MAX = 500;

const ACTION_GUARD_MS = 650;
const _actionGuardMap = new Map();

function canRunGuardedAction(key, ms = ACTION_GUARD_MS) {
  const now = Date.now();
  const last = _actionGuardMap.get(key) || 0;
  if (now - last < ms) return false;
  _actionGuardMap.set(key, now);
  return true;
}

function withActionGuard(key, fn, ms = ACTION_GUARD_MS) {
  return (...args) => {
    if (!canRunGuardedAction(key, ms)) return;
    return fn(...args);
  };
}

function withButtonGuard(button, key, fn, ms = ACTION_GUARD_MS) {
  return (...args) => {
    if (!canRunGuardedAction(key, ms)) return;
    if (button) {
      button.disabled = true;
      setTimeout(() => { try { button.disabled = false; } catch {} }, ms);
    }
    return fn(...args);
  };
}



function loadActionLog() {
  try {
    const raw = localStorage.getItem(ACTION_LOG_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveActionLog() {
  try {
    localStorage.setItem(ACTION_LOG_KEY, JSON.stringify(actionLog.slice(0, ACTION_LOG_MAX)));
  } catch {}
}

function addActionLog(action, station = null, details = '', level = 'info', options = {}) {
  const entry = {
    id: `log_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
    ts: Date.now(),
    action: String(action || 'Действие'),
    level: level === 'warn' ? 'warn' : 'info',
    stationId: station?.id ?? null,
    stationName: station?.name ? normalizeStationName(station.name) : '',
    stationType: station ? getStationType(station) : '',
    details: String(details || '').trim(),
  };
  actionLog.unshift(entry);
  if (actionLog.length > ACTION_LOG_MAX) actionLog.length = ACTION_LOG_MAX;
  saveActionLog();
  if ($journalModal?.classList.contains('modal--open')) renderJournal();
  if (ACHIEVEMENT_BREAK_ACTIONS.has(entry.action)) recordAchievementBreakEvent(entry.ts);
  if (!options?.suppressAchievementSync) syncAchievementsState();
  return entry;
}

function rejectAction(station, reason) {
  addActionLog('Отклонено', station, reason, 'warn');
  toast(reason);
}

function getJournalEntryStationName(item) {
  const stationId = String(item?.stationId || '').trim();
  if (stationId) {
    const station = getStationDefinitions().find((entry) => String(entry.id) === stationId);
    if (station?.name) return station.name;
  }
  return item?.stationName || '—';
}

function exportJournalTXT() {
  const rows = getFilteredJournalEntries();
  const lines = rows.map((item) => {
    const station = getJournalEntryStationName(item);
    const level = item.level === 'warn' ? 'WARNING' : 'INFO';
    const details = item.details ? ` | ${item.details}` : '';
    return `[${formatDateRU(item.ts)} ${hhmm(item.ts)}] ${level} | ${station} | ${item.action}${details}`;
  });
  const stationFilter = $journalStationFilter?.value || 'all';
  const levelFilter = $journalLevelFilter?.value || 'all';
  const search = String($journalSearch?.value || '').trim();
  const suffixParts = [];
  if (stationFilter !== 'all') suffixParts.push(sanitizeFilenamePart(journalStationLabel(stationFilter)));
  if (levelFilter !== 'all') suffixParts.push(levelFilter);
  if (search) suffixParts.push(sanitizeFilenamePart(search).slice(0, 24));
  const suffix = suffixParts.length ? `_${suffixParts.join('_')}` : '';
  downloadText(`PS_Lounge_Journal_${todayKey()}${suffix}.txt`, lines.join('\n') || 'Журнал пуст', 'text/plain;charset=utf-8');
}

function getFilteredJournalEntries() {
  const stationFilter = $journalStationFilter?.value || 'all';
  const levelFilter = $journalLevelFilter?.value || 'all';
  const search = String($journalSearch?.value || '').trim().toLocaleLowerCase('ru');
  return actionLog.filter((item) => {
    if (stationFilter !== 'all' && String(item.stationId || '') !== stationFilter) return false;
    if (levelFilter !== 'all' && item.level !== levelFilter) return false;
    if (search) {
      const hay = [
        item.action,
        item.stationName,
        item.stationType ? stationTypeLabel(item.stationType) : '',
        item.details,
        item.level === 'warn' ? 'предупреждение' : 'событие',
      ].join(' ').toLocaleLowerCase('ru');
      if (!hay.includes(search)) return false;
    }
    return true;
  });
}

function renderJournal() {
  if (!$journalList) return;
  const rows = getFilteredJournalEntries();
  if ($journalCount) $journalCount.textContent = String(rows.length);
  if ($journalStats) {
    const warns = rows.filter((x) => x.level === 'warn').length;
    const info = rows.length - warns;
    $journalStats.textContent = `Обычные: ${info} • Предупреждения: ${warns}`;
  }
  if ($journalResultsInfo) {
    $journalResultsInfo.textContent = `Показано ${rows.length} из ${actionLog.length}`;
  }
  updateJournalFilterInfo();
  if (!rows.length) {
    $journalList.innerHTML = '<div class="sessionRow"><div class="sessionRow__left"><div class="sessionRow__title">Пусто</div><div class="sessionRow__meta">Записей журнала пока нет.</div></div></div>';
    return;
  }
  $journalList.innerHTML = '';
  rows.forEach((item, idx) => {
    const row = document.createElement('div');
    row.className = 'journalRow journalRow--enter';
    row.style.animationDelay = `${Math.min(idx, 8) * 35}ms`;
    const stationText = getJournalEntryStationName(item);
    const typeText = item.stationType ? stationTypeLabel(item.stationType) : '—';
    const isWarn = item.level === 'warn';
    row.innerHTML = `
      <div class="journalRow__left">
        <div class="journalRow__title"><span class="journalIcon" aria-hidden="true">${isWarn ? '⚠' : 'ℹ'}</span>${escapeHtml(item.action)}</div>
        <div class="journalRow__meta">${escapeHtml(stationText)} • ${escapeHtml(typeText)}<br>${escapeHtml(item.details || 'Без деталей')}</div>
      </div>
      <div class="journalRow__right">
        <div><span class="journalTag journalTag--${isWarn ? 'warn' : 'info'}">${isWarn ? 'ПРЕДУПРЕЖДЕНИЕ' : 'СОБЫТИЕ'}</span></div>
        <div>${formatDateRU(item.ts)} • ${hhmm(item.ts)}</div>
      </div>
    `;
    $journalList.appendChild(row);
    requestAnimationFrame(() => row.classList.remove('journalRow--enter'));
  });
}

function openJournal() {
  $journalModal.classList.add('modal--open');
  $journalModal.setAttribute('aria-hidden', 'false');
  renderJournalStationOptions();
  syncJournalSelect('station');
  syncJournalSelect('level');
  renderJournal();
  updateJournalFilterInfo();
}

function closeJournal() {
  closeJournalSelects();
  closeAllCustomSelects();
  $journalModal.classList.remove('modal--open');
  $journalModal.setAttribute('aria-hidden', 'true');
}

function loadMeta() {
  try {
    const raw = localStorage.getItem(META_KEY);
    if (!raw) return { lastModified: 0 };
    const m = JSON.parse(raw);
    return (m && typeof m === 'object' && Number.isFinite(m.lastModified)) ? m : { lastModified: 0 };
  } catch {
    return { lastModified: 0 };
  }
}

function saveMeta(meta) {
  try { localStorage.setItem(META_KEY, JSON.stringify(meta)); } catch {}
}

let meta = loadMeta();
let lastModified = Number.isFinite(meta.lastModified) ? meta.lastModified : 0;
let dirtySinceFlush = false;
let lastFlushSucceededAt = 0;

// Debounced disk-backup flush
let _flushTimer = null;
let _flushInFlight = false;
let _flushRequested = false;

async function flushBackupNow() {
  if (_flushInFlight) { _flushRequested = true; return; }
  _flushInFlight = true;
  try {
    const res = await fetch('/api/backup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lastModified, stations, sessions, settings, achievements }),
    });
    if (res.ok) {
      dirtySinceFlush = false;
      lastFlushSucceededAt = Date.now();
    }
  } catch {
    // ignore, offline/blocked; localStorage remains source of truth
  } finally {
    _flushInFlight = false;
    if (_flushRequested) {
      _flushRequested = false;
      // fire again once
      flushBackupNow();
    }
  }
}

function scheduleFlush(immediate=false) {
  if (immediate) {
    if (_flushTimer) { clearTimeout(_flushTimer); _flushTimer = null; }
    flushBackupNow();
    return;
  }
  if (_flushTimer) return;
  _flushTimer = setTimeout(() => {
    _flushTimer = null;
    flushBackupNow();
  }, 400);
}

function touchModified(immediate=false) {
  lastModified = Date.now();
  dirtySinceFlush = true;
  saveMeta({ lastModified });
  scheduleFlush(immediate);
}

const DEFAULT_GRACE_MINUTES = 10;
const DEFAULT_AUTO_CLOSE_OVERDUE_MINUTES = 10; // auto-stop after this many minutes in overdue state


const DEFAULT_TARIFFS_PS = [
  { id: 'ps_t1', label: '1 час', minutes: 60, price: 300 },
  { id: 'ps_t2', label: '2 часа', minutes: 120, price: 600 },
  { id: 'ps_t3', label: '3 часа', minutes: 180, price: 900 },
  { id: 'ps_t4', label: '4 часа', minutes: 240, price: 1200 },
  { id: 'ps_t5', label: '5 часов', minutes: 300, price: 1500 },
];

const DEFAULT_TARIFFS_SIMULATOR = [
  { id: 'sim_t1', label: '30 минут', minutes: 30, price: 250 },
  { id: 'sim_t2', label: '1 час', minutes: 60, price: 400 },
  { id: 'sim_t3', label: '2 часа', minutes: 120, price: 750 },
];

const DEFAULT_TARIFFS_SWITCH = [
  { id: 'sw_t1', label: '30 минут', minutes: 30, price: 200 },
  { id: 'sw_t2', label: '1 час', minutes: 60, price: 300 },
  { id: 'sw_t3', label: '2 часа', minutes: 120, price: 550 },
  { id: 'sw_t4', label: '3 часа', minutes: 180, price: 750 },
];

const DEFAULT_CUSTOM_RATES = {
  ps: 300,
  simulator: 400,
  switch: 300,
};
const DEFAULT_STATION_DEFINITIONS = [
  { id: 1, name: 'PS1', type: 'ps' },
  { id: 2, name: 'PS2', type: 'ps' },
  { id: 3, name: 'PS3', type: 'ps' },
  { id: 4, name: 'PS4', type: 'ps' },
  { id: 5, name: 'Симулятор гонок', type: 'simulator' },
  { id: 6, name: 'Nintendo Switch', type: 'switch' },
];
const PAYMENT_METHODS = [
  { id: 'cash', label: 'Наличные' },
  { id: 'card', label: 'Карта' },
  { id: 'transfer', label: 'Перевод' },
];

const ACHIEVEMENTS_BACKFILL_VERSION = 3;
const ACHIEVEMENT_BREAK_ACTIONS = new Set(['Отмена', 'Восстановление']);
const ACHIEVEMENT_DEFINITIONS = [
  { id: 'first_session', title: 'Первая посадка', description: 'Закройте первую игровую сессию.', icon: '01', category: 'Старт', progressMax: 1, metric: 'closedSessions', rarity: 'base' },
  { id: 'routine', title: 'Рабочий ритм', description: 'Накопите 10 завершённых сессий.', icon: '10', category: 'Ритм', progressMax: 10, metric: 'closedSessions', rarity: 'base' },
  { id: 'sessions_25', title: 'В потоке', description: 'Накопите 25 завершённых сессий.', icon: '25', category: 'Ритм', progressMax: 25, metric: 'closedSessions', rarity: 'rare' },
  { id: 'operator_50', title: 'Уверенная рука', description: 'Доведите общее число завершённых сессий до 50.', icon: '50', category: 'Ритм', progressMax: 50, metric: 'closedSessions', rarity: 'rare' },
  { id: 'sessions_100', title: 'Длинная дистанция', description: 'Накопите 100 завершённых сессий.', icon: '100', category: 'Ритм', progressMax: 100, metric: 'closedSessions', rarity: 'elite' },
  { id: 'sessions_250', title: 'Мощный архив', description: 'Доведите общее число завершённых сессий до 250.', icon: '250', category: 'Ритм', progressMax: 250, metric: 'closedSessions', rarity: 'elite' },
  { id: 'sessions_500', title: 'Летопись зала', description: 'Накопите 500 завершённых сессий.', icon: '500', category: 'Ритм', progressMax: 500, metric: 'closedSessions', rarity: 'legend' },

  { id: 'three_running', title: 'Без остановки', description: 'Держите 3 станции активными одновременно.', icon: 'III', category: 'Зал', progressMax: 3, metric: 'concurrentPeak', rarity: 'base' },
  { id: 'full_house', title: 'Полный зал', description: 'Заполните одновременно все станции.', icon: 'MAX', category: 'Зал', progressMax: 6, metric: 'concurrentPeak', rarity: 'rare' },

  { id: 'duration_180', title: 'Длинная партия', description: 'Проведите хотя бы одну сессию на 3 часа.', icon: '3H', category: 'Сессии', progressMax: 180, metric: 'maxDurationMinutes', rarity: 'base' },
  { id: 'marathon', title: 'Марафон', description: 'Проведите хотя бы одну сессию на 4 часа.', icon: '4H', category: 'Сессии', progressMax: 240, metric: 'maxDurationMinutes', rarity: 'rare' },
  { id: 'duration_360', title: 'Выносливость', description: 'Проведите хотя бы одну сессию на 6 часов.', icon: '6H', category: 'Сессии', progressMax: 360, metric: 'maxDurationMinutes', rarity: 'elite' },
  { id: 'duration_480', title: 'Ночной марафон', description: 'Проведите хотя бы одну сессию на 8 часов.', icon: '8H', category: 'Сессии', progressMax: 480, metric: 'maxDurationMinutes', rarity: 'legend' },

  { id: 'playtime_24h', title: 'Сутки в игре', description: 'Накопите 24 часа суммарного игрового времени.', icon: '24H', category: 'Время', progressMax: 1440, metric: 'totalPlayMinutes', rarity: 'rare' },
  { id: 'playtime_72h', title: 'Три полных дня', description: 'Накопите 72 часа суммарного игрового времени.', icon: '72H', category: 'Время', progressMax: 4320, metric: 'totalPlayMinutes', rarity: 'elite' },
  { id: 'playtime_150h', title: 'Хроника смен', description: 'Накопите 150 часов суммарного игрового времени.', icon: '150H', category: 'Время', progressMax: 9000, metric: 'totalPlayMinutes', rarity: 'legend' },

  { id: 'extensions_10', title: 'Ещё немного', description: 'Сделайте 10 платных продлений.', icon: '+10', category: 'Продления', progressMax: 10, metric: 'paidExtensions', rarity: 'base' },
  { id: 'extra_time', title: 'Дополнительное время', description: 'Сделайте 25 платных продлений.', icon: '+25', category: 'Продления', progressMax: 25, metric: 'paidExtensions', rarity: 'rare' },
  { id: 'extensions_50', title: 'Плюс ещё раунд', description: 'Сделайте 50 платных продлений.', icon: '+50', category: 'Продления', progressMax: 50, metric: 'paidExtensions', rarity: 'elite' },
  { id: 'extensions_100', title: 'Бесконечная ночь', description: 'Сделайте 100 платных продлений.', icon: '+100', category: 'Продления', progressMax: 100, metric: 'paidExtensions', rarity: 'legend' },

  { id: 'revenue_10k', title: 'Первые деньги', description: 'Наберите 10 000 рублей общей выручки.', icon: '10K', category: 'Выручка', progressMax: 10000, metric: 'totalRevenue', rarity: 'base' },
  { id: 'revenue_25k', title: 'Касса пошла', description: 'Наберите 25 000 рублей общей выручки.', icon: '25K', category: 'Выручка', progressMax: 25000, metric: 'totalRevenue', rarity: 'rare' },
  { id: 'revenue_50k', title: 'Хороший месяц', description: 'Наберите 50 000 рублей общей выручки.', icon: '50K', category: 'Выручка', progressMax: 50000, metric: 'totalRevenue', rarity: 'rare' },
  { id: 'revenue_100k', title: 'Золотой фонд', description: 'Наберите 100 000 рублей общей выручки.', icon: '100K', category: 'Выручка', progressMax: 100000, metric: 'totalRevenue', rarity: 'elite' },
  { id: 'revenue_250k', title: 'Сильная касса', description: 'Наберите 250 000 рублей общей выручки.', icon: '250K', category: 'Выручка', progressMax: 250000, metric: 'totalRevenue', rarity: 'elite' },
  { id: 'revenue_500k', title: 'Полмиллиона света', description: 'Наберите 500 000 рублей общей выручки.', icon: '500K', category: 'Выручка', progressMax: 500000, metric: 'totalRevenue', rarity: 'legend' },

  { id: 'payments', title: 'Универсал', description: 'Проведите продажи всеми способами оплаты.', icon: 'ALL', category: 'Оплата', progressMax: 3, metric: 'paymentCount', rarity: 'base' },

  { id: 'best_day_10', title: 'Живой день', description: 'Закройте 10 сессий за один день.', icon: '10D', category: 'Темп', progressMax: 10, metric: 'bestDayClosed', rarity: 'base' },
  { id: 'busy_day', title: 'Жизнь кипит', description: 'Закройте 15 сессий за один день.', icon: '15D', category: 'Темп', progressMax: 15, metric: 'bestDayClosed', rarity: 'rare' },
  { id: 'best_day_20', title: 'Без пауз', description: 'Закройте 20 сессий за один день.', icon: '20D', category: 'Темп', progressMax: 20, metric: 'bestDayClosed', rarity: 'elite' },
  { id: 'best_day_30', title: 'Аншлаг до ночи', description: 'Закройте 30 сессий за один день.', icon: '30D', category: 'Темп', progressMax: 30, metric: 'bestDayClosed', rarity: 'legend' },

  { id: 'simulator_5', title: 'Первые круги', description: 'Закройте 5 сессий на симуляторе.', icon: 'S5', category: 'Станции', progressMax: 5, metric: 'simulatorClosed', rarity: 'base' },
  { id: 'simulator_master', title: 'Хозяин симулятора', description: 'Закройте 12 сессий на симуляторе.', icon: 'S12', category: 'Станции', progressMax: 12, metric: 'simulatorClosed', rarity: 'rare' },
  { id: 'simulator_30', title: 'Трасса не пустеет', description: 'Закройте 30 сессий на симуляторе.', icon: 'S30', category: 'Станции', progressMax: 30, metric: 'simulatorClosed', rarity: 'elite' },
  { id: 'simulator_60', title: 'Король трассы', description: 'Закройте 60 сессий на симуляторе.', icon: 'S60', category: 'Станции', progressMax: 60, metric: 'simulatorClosed', rarity: 'legend' },

  { id: 'switch_5', title: 'Joy-Con в деле', description: 'Закройте 5 сессий на Nintendo Switch.', icon: 'N5', category: 'Станции', progressMax: 5, metric: 'switchClosed', rarity: 'base' },
  { id: 'switch_ready', title: 'Switch в деле', description: 'Закройте 12 сессий на Nintendo Switch.', icon: 'N12', category: 'Станции', progressMax: 12, metric: 'switchClosed', rarity: 'rare' },
  { id: 'switch_30', title: 'Карманный хит', description: 'Закройте 30 сессий на Nintendo Switch.', icon: 'N30', category: 'Станции', progressMax: 30, metric: 'switchClosed', rarity: 'elite' },
  { id: 'switch_60', title: 'Остров Nintendo', description: 'Закройте 60 сессий на Nintendo Switch.', icon: 'N60', category: 'Станции', progressMax: 60, metric: 'switchClosed', rarity: 'legend' },

  { id: 'clean_5', title: 'Чистая серия', description: 'Закройте 5 сессий подряд без отмен и восстановлений.', icon: 'C5', category: 'Точность', progressMax: 5, metric: 'cleanCloseStreak', rarity: 'base' },
  { id: 'clean_streak', title: 'Ни минуты зря', description: 'Закройте 12 сессий подряд без отмен и восстановлений.', icon: 'C12', category: 'Точность', progressMax: 12, metric: 'cleanCloseStreak', rarity: 'rare' },
  { id: 'clean_20', title: 'Жёсткий порядок', description: 'Закройте 20 сессий подряд без отмен и восстановлений.', icon: 'C20', category: 'Точность', progressMax: 20, metric: 'cleanCloseStreak', rarity: 'elite' },
  { id: 'clean_30', title: 'Идеальная линия', description: 'Закройте 30 сессий подряд без отмен и восстановлений.', icon: 'C30', category: 'Точность', progressMax: 30, metric: 'cleanCloseStreak', rarity: 'legend' },

  { id: 'active_days_7', title: 'Ровный старт', description: 'Отработайте 7 разных активных дней с сессиями.', icon: '7D', category: 'Темп', progressMax: 7, metric: 'activeDays', rarity: 'base' },
  { id: 'active_days', title: 'Постоянный темп', description: 'Отработайте 20 разных активных дней с сессиями.', icon: '20D', category: 'Темп', progressMax: 20, metric: 'activeDays', rarity: 'rare' },
  { id: 'active_days_45', title: 'Сезон в работе', description: 'Отработайте 45 разных активных дней с сессиями.', icon: '45D', category: 'Темп', progressMax: 45, metric: 'activeDays', rarity: 'elite' },
  { id: 'active_days_90', title: 'Длинный сезон', description: 'Отработайте 90 разных активных дней с сессиями.', icon: '90D', category: 'Темп', progressMax: 90, metric: 'activeDays', rarity: 'legend' },

  { id: 'sales_25', title: 'Первая касса', description: 'Проведите 25 продаж и начислений суммарно.', icon: '25$', category: 'Выручка', progressMax: 25, metric: 'totalSales', rarity: 'base' },
  { id: 'sales_master', title: 'Чистая касса', description: 'Проведите 80 продаж и начислений суммарно.', icon: '80$', category: 'Выручка', progressMax: 80, metric: 'totalSales', rarity: 'rare' },
  { id: 'sales_150', title: 'Ритм продаж', description: 'Проведите 150 продаж и начислений суммарно.', icon: '150$', category: 'Выручка', progressMax: 150, metric: 'totalSales', rarity: 'elite' },
  { id: 'sales_300', title: 'Большой оборот', description: 'Проведите 300 продаж и начислений суммарно.', icon: '300$', category: 'Выручка', progressMax: 300, metric: 'totalSales', rarity: 'legend' },

  { id: 'ps_25', title: 'PS Lounge живёт', description: 'Закройте 25 сессий на классических PlayStation-станциях.', icon: 'P25', category: 'Станции', progressMax: 25, metric: 'psClosed', rarity: 'base' },
  { id: 'ps_80', title: 'Главная сцена', description: 'Закройте 80 сессий на классических PlayStation-станциях.', icon: 'P80', category: 'Станции', progressMax: 80, metric: 'psClosed', rarity: 'rare' },
  { id: 'ps_160', title: 'Сердце клуба', description: 'Закройте 160 сессий на классических PlayStation-станциях.', icon: 'P160', category: 'Станции', progressMax: 160, metric: 'psClosed', rarity: 'elite' },

  { id: 'cash_25', title: 'Наличные в ходу', description: 'Проведите 25 оплат наличными.', icon: 'CASH', category: 'Оплата', progressMax: 25, metric: 'cashCount', rarity: 'base' },
  { id: 'card_25', title: 'Карта наготове', description: 'Проведите 25 оплат картой.', icon: 'CARD', category: 'Оплата', progressMax: 25, metric: 'cardCount', rarity: 'base' },
  { id: 'transfer_10', title: 'Мобильный перевод', description: 'Проведите 10 оплат переводом.', icon: 'TR', category: 'Оплата', progressMax: 10, metric: 'transferCount', rarity: 'rare' },

  { id: 'premium_1000', title: 'Сильный чек', description: 'Поймайте хотя бы одну сессию с чеком от 1 000 рублей.', icon: '1K', category: 'Чек', progressMax: 1000, metric: 'highestSessionAmount', rarity: 'rare' },
  { id: 'premium_2000', title: 'Премиум-посадка', description: 'Поймайте хотя бы одну сессию с чеком от 2 000 рублей.', icon: '2K', category: 'Чек', progressMax: 2000, metric: 'highestSessionAmount', rarity: 'elite' },
  { id: 'sessions_5', title: 'Разминка', description: 'Накопите 5 завершённых сессий.', icon: '05', category: 'Ритм', progressMax: 5, metric: 'closedSessions', rarity: 'base' },
  { id: 'sessions_75', title: 'Крепкий ритм', description: 'Накопите 75 завершённых сессий.', icon: '75', category: 'Ритм', progressMax: 75, metric: 'closedSessions', rarity: 'elite' },
  { id: 'sessions_150', title: 'Плотный поток', description: 'Накопите 150 завершённых сессий.', icon: '150', category: 'Ритм', progressMax: 150, metric: 'closedSessions', rarity: 'elite' },
  { id: 'sessions_350', title: 'Архив вечеров', description: 'Накопите 350 завершённых сессий.', icon: '350', category: 'Ритм', progressMax: 350, metric: 'closedSessions', rarity: 'legend' },
  { id: 'sessions_750', title: 'Музей записей', description: 'Накопите 750 завершённых сессий.', icon: '750', category: 'Ритм', progressMax: 750, metric: 'closedSessions', rarity: 'mythic' },
  { id: 'sessions_1000', title: 'Тысяча посадок', description: 'Накопите 1000 завершённых сессий.', icon: '1K', category: 'Ритм', progressMax: 1000, metric: 'closedSessions', rarity: 'mythic' },

  { id: 'duration_120', title: 'Спокойная игра', description: 'Проведите хотя бы одну сессию на 2 часа.', icon: '2H', category: 'Сессии', progressMax: 120, metric: 'maxDurationMinutes', rarity: 'base' },
  { id: 'duration_300', title: 'Долгий заход', description: 'Проведите хотя бы одну сессию на 5 часов.', icon: '5H', category: 'Сессии', progressMax: 300, metric: 'maxDurationMinutes', rarity: 'elite' },
  { id: 'duration_540', title: 'После закрытия', description: 'Проведите хотя бы одну сессию на 9 часов.', icon: '9H', category: 'Сессии', progressMax: 540, metric: 'maxDurationMinutes', rarity: 'mythic' },

  { id: 'playtime_10h', title: 'Первые десять часов', description: 'Накопите 10 часов суммарного игрового времени.', icon: '10H', category: 'Время', progressMax: 600, metric: 'totalPlayMinutes', rarity: 'base' },
  { id: 'playtime_36h', title: 'Полтора дня', description: 'Накопите 36 часов суммарного игрового времени.', icon: '36H', category: 'Время', progressMax: 2160, metric: 'totalPlayMinutes', rarity: 'rare' },
  { id: 'playtime_100h', title: 'Сотня часов', description: 'Накопите 100 часов суммарного игрового времени.', icon: '100H', category: 'Время', progressMax: 6000, metric: 'totalPlayMinutes', rarity: 'elite' },
  { id: 'playtime_300h', title: 'Триста часов зала', description: 'Накопите 300 часов суммарного игрового времени.', icon: '300H', category: 'Время', progressMax: 18000, metric: 'totalPlayMinutes', rarity: 'mythic' },

  { id: 'extensions_5', title: 'Добавили ещё', description: 'Сделайте 5 платных продлений.', icon: '+5', category: 'Продления', progressMax: 5, metric: 'paidExtensions', rarity: 'base' },
  { id: 'extensions_15', title: 'Время пошло', description: 'Сделайте 15 платных продлений.', icon: '+15', category: 'Продления', progressMax: 15, metric: 'paidExtensions', rarity: 'rare' },
  { id: 'extensions_75', title: 'Ночь продолжается', description: 'Сделайте 75 платных продлений.', icon: '+75', category: 'Продления', progressMax: 75, metric: 'paidExtensions', rarity: 'legend' },
  { id: 'extensions_150', title: 'Ещё один час?', description: 'Сделайте 150 платных продлений.', icon: '+150', category: 'Продления', progressMax: 150, metric: 'paidExtensions', rarity: 'mythic' },

  { id: 'revenue_5k', title: 'Разогрев кассы', description: 'Наберите 5 000 рублей общей выручки.', icon: '5K', category: 'Выручка', progressMax: 5000, metric: 'totalRevenue', rarity: 'base' },
  { id: 'revenue_75k', title: 'Хорошая неделя', description: 'Наберите 75 000 рублей общей выручки.', icon: '75K', category: 'Выручка', progressMax: 75000, metric: 'totalRevenue', rarity: 'elite' },
  { id: 'revenue_150k', title: 'Сильный оборот', description: 'Наберите 150 000 рублей общей выручки.', icon: '150K', category: 'Выручка', progressMax: 150000, metric: 'totalRevenue', rarity: 'legend' },
  { id: 'revenue_350k', title: 'Полный зал в цифрах', description: 'Наберите 350 000 рублей общей выручки.', icon: '350K', category: 'Выручка', progressMax: 350000, metric: 'totalRevenue', rarity: 'legend' },
  { id: 'revenue_750k', title: 'Большой кассовый свет', description: 'Наберите 750 000 рублей общей выручки.', icon: '750K', category: 'Выручка', progressMax: 750000, metric: 'totalRevenue', rarity: 'mythic' },
  { id: 'revenue_1m', title: 'Миллионный рубеж', description: 'Наберите 1 000 000 рублей общей выручки.', icon: '1M', category: 'Выручка', progressMax: 1000000, metric: 'totalRevenue', rarity: 'mythic' },

  { id: 'best_day_5', title: 'Бодрый день', description: 'Закройте 5 сессий за один день.', icon: '5D', category: 'Темп', progressMax: 5, metric: 'bestDayClosed', rarity: 'base' },
  { id: 'best_day_12', title: 'День на подъёме', description: 'Закройте 12 сессий за один день.', icon: '12D', category: 'Темп', progressMax: 12, metric: 'bestDayClosed', rarity: 'rare' },
  { id: 'best_day_25', title: 'День без воздуха', description: 'Закройте 25 сессий за один день.', icon: '25D', category: 'Темп', progressMax: 25, metric: 'bestDayClosed', rarity: 'legend' },
  { id: 'best_day_40', title: 'Легендарная смена', description: 'Закройте 40 сессий за один день.', icon: '40D', category: 'Темп', progressMax: 40, metric: 'bestDayClosed', rarity: 'mythic' },

  { id: 'simulator_20', title: 'Трасса открыта', description: 'Закройте 20 сессий на симуляторе.', icon: 'S20', category: 'Станции', progressMax: 20, metric: 'simulatorClosed', rarity: 'elite' },
  { id: 'simulator_45', title: 'Сезон трассы', description: 'Закройте 45 сессий на симуляторе.', icon: 'S45', category: 'Станции', progressMax: 45, metric: 'simulatorClosed', rarity: 'mythic' },

  { id: 'switch_20', title: 'Switch не простаивает', description: 'Закройте 20 сессий на Nintendo Switch.', icon: 'N20', category: 'Станции', progressMax: 20, metric: 'switchClosed', rarity: 'elite' },
  { id: 'switch_45', title: 'Лига Nintendo', description: 'Закройте 45 сессий на Nintendo Switch.', icon: 'N45', category: 'Станции', progressMax: 45, metric: 'switchClosed', rarity: 'mythic' },

  { id: 'ps_10', title: 'Первый зал PlayStation', description: 'Закройте 10 сессий на классических PlayStation-станциях.', icon: 'P10', category: 'Станции', progressMax: 10, metric: 'psClosed', rarity: 'base' },
  { id: 'ps_50', title: 'Домашняя сцена', description: 'Закройте 50 сессий на классических PlayStation-станциях.', icon: 'P50', category: 'Станции', progressMax: 50, metric: 'psClosed', rarity: 'rare' },
  { id: 'ps_120', title: 'Основной контур', description: 'Закройте 120 сессий на классических PlayStation-станциях.', icon: 'P120', category: 'Станции', progressMax: 120, metric: 'psClosed', rarity: 'elite' },
  { id: 'ps_250', title: 'Лицо клуба', description: 'Закройте 250 сессий на классических PlayStation-станциях.', icon: 'P250', category: 'Станции', progressMax: 250, metric: 'psClosed', rarity: 'legend' },

  { id: 'active_days_3', title: 'Первый график', description: 'Отработайте 3 разных активных дня с сессиями.', icon: '3D', category: 'Темп', progressMax: 3, metric: 'activeDays', rarity: 'base' },
  { id: 'active_days_14', title: 'Две недели в деле', description: 'Отработайте 14 разных активных дней с сессиями.', icon: '14D', category: 'Темп', progressMax: 14, metric: 'activeDays', rarity: 'rare' },
  { id: 'active_days_30', title: 'Целый месяц', description: 'Отработайте 30 разных активных дней с сессиями.', icon: '30D', category: 'Темп', progressMax: 30, metric: 'activeDays', rarity: 'elite' },
  { id: 'active_days_60', title: 'Два сезона', description: 'Отработайте 60 разных активных дней с сессиями.', icon: '60D', category: 'Темп', progressMax: 60, metric: 'activeDays', rarity: 'legend' },
  { id: 'active_days_120', title: 'Стабильный год', description: 'Отработайте 120 разных активных дней с сессиями.', icon: '120D', category: 'Темп', progressMax: 120, metric: 'activeDays', rarity: 'mythic' },
  { id: 'active_days_180', title: 'Полгода ритма', description: 'Отработайте 180 разных активных дней с сессиями.', icon: '180D', category: 'Темп', progressMax: 180, metric: 'activeDays', rarity: 'mythic' },
];

function getAchievementDefinition(id) {
  return ACHIEVEMENT_DEFINITIONS.find((item) => item.id === id) || null;
}

function defaultAchievementsState() {
  return {
    version: 1,
    backfillVersion: 0,
    unlocked: {},
    progress: {},
    unseenIds: [],
    breakEvents: [],
    cleanTrackingStartedAt: Date.now(),
  };
}

function normalizeAchievementsState(raw) {
  const src = (raw && typeof raw === 'object') ? raw : {};
  const base = defaultAchievementsState();
  const known = new Set(ACHIEVEMENT_DEFINITIONS.map((item) => item.id));
  const unlocked = {};
  if (src.unlocked && typeof src.unlocked === 'object') {
    for (const [id, value] of Object.entries(src.unlocked)) {
      if (!known.has(id) || !value || typeof value !== 'object') continue;
      const unlockedAt = Number(value.unlockedAt);
      const seenAt = value.seenAt == null ? null : Number(value.seenAt);
      if (!Number.isFinite(unlockedAt) || unlockedAt <= 0) continue;
      unlocked[id] = {
        unlockedAt: Math.round(unlockedAt),
        seenAt: Number.isFinite(seenAt) && seenAt > 0 ? Math.round(seenAt) : null,
      };
    }
  }
  const progress = {};
  if (src.progress && typeof src.progress === 'object') {
    for (const [id, value] of Object.entries(src.progress)) {
      if (!known.has(id)) continue;
      const numeric = Number(value);
      if (!Number.isFinite(numeric)) continue;
      progress[id] = Math.max(0, numeric);
    }
  }
  const unseenIds = Array.isArray(src.unseenIds)
    ? [...new Set(src.unseenIds.filter((id) => known.has(id) && unlocked[id]))]
    : [];
  const breakEvents = Array.isArray(src.breakEvents)
    ? [...new Set(src.breakEvents
      .map((value) => Math.round(Number(value)))
      .filter((value) => Number.isFinite(value) && value > 0))]
    : [];
  breakEvents.sort((a, b) => a - b);
  const cleanTrackingStartedAtRaw = Math.round(Number(src.cleanTrackingStartedAt));
  const cleanTrackingStartedAt = Number.isFinite(cleanTrackingStartedAtRaw) && cleanTrackingStartedAtRaw > 0
    ? cleanTrackingStartedAtRaw
    : base.cleanTrackingStartedAt;
  return {
    version: Number.isFinite(Number(src.version)) ? Math.max(1, Math.round(Number(src.version))) : base.version,
    backfillVersion: Number.isFinite(Number(src.backfillVersion)) ? Math.max(0, Math.round(Number(src.backfillVersion))) : base.backfillVersion,
    unlocked,
    progress,
    unseenIds,
    breakEvents,
    cleanTrackingStartedAt,
  };
}

function loadAchievements() {
  try {
    const raw = localStorage.getItem(ACHIEVEMENTS_KEY);
    if (!raw) return defaultAchievementsState();
    return normalizeAchievementsState(JSON.parse(raw));
  } catch {
    return defaultAchievementsState();
  }
}

function saveAchievements(immediate = false) {
  achievements = normalizeAchievementsState(achievements);
  localStorage.setItem(ACHIEVEMENTS_KEY, JSON.stringify(achievements));
  touchModified(immediate);
}

function recordAchievementBreakEvent(ts = Date.now()) {
  achievements = normalizeAchievementsState(achievements);
  const normalizedTs = Math.round(Number(ts));
  if (!Number.isFinite(normalizedTs) || normalizedTs <= 0) return;
  const events = Array.isArray(achievements.breakEvents) ? achievements.breakEvents : [];
  if (events[events.length - 1] === normalizedTs) return;
  achievements.breakEvents = [...events, normalizedTs];
  saveAchievements(true);
}

function countUnseenAchievements() {
  return Array.isArray(achievements?.unseenIds) ? achievements.unseenIds.length : 0;
}

function defaultStationDefinitions() {
  return DEFAULT_STATION_DEFINITIONS.map((item) => ({ ...item }));
}

function normalizeStationDefinition(raw, fallbackIndex = 0) {
  const item = (raw && typeof raw === 'object') ? raw : {};
  const id = Number.isFinite(Number(item.id)) ? Math.max(1, Math.round(Number(item.id))) : fallbackIndex + 1;
  const requestedType = String(item.type || item.stationType || '').trim().toLowerCase();
  const type = STATION_TYPES[requestedType] ? requestedType : (id === 5 ? 'simulator' : id === 6 ? 'switch' : 'ps');
  const fallbackName = defaultStationDefinitions().find((x) => x.id === id)?.name || `${stationTypeLabel(type)} ${fallbackIndex + 1}`;
  const name = normalizeStationName(typeof item.name === 'string' && item.name.trim() ? item.name.trim() : fallbackName);
  return { id, name, type };
}

function sortStationDefinitions(list) {
  return [...list].sort((a, b) => {
    const idDiff = (Number(a.id) || 0) - (Number(b.id) || 0);
    if (idDiff !== 0) return idDiff;
    return String(a.name || '').localeCompare(String(b.name || ''), 'ru');
  });
}

function normalizeStationDefinitions(list) {
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

function getStationDefinitions(source = settings) {
  return normalizeStationDefinitions(source?.stationDefinitions);
}

function getStationDefinitionById(id, source = settings) {
  const stationId = Number(id);
  return getStationDefinitions(source).find((item) => Number(item.id) === stationId) || null;
}

function nextStationId(defs = getStationDefinitions()) {
  return defs.reduce((maxId, item) => Math.max(maxId, Number(item.id) || 0), 0) + 1;
}

function makeDefaultStationName(type, defs = getStationDefinitions()) {
  if (type === 'ps') {
    const count = defs.filter((item) => item.type === 'ps').length + 1;
    return `PS${count}`;
  }
  if (type === 'simulator') {
    const count = defs.filter((item) => item.type === 'simulator').length + 1;
    return count > 1 ? `Симулятор ${count}` : 'Симулятор гонок';
  }
  const count = defs.filter((item) => item.type === 'switch').length + 1;
  return count > 1 ? `Nintendo Switch ${count}` : 'Nintendo Switch';
}

function createStationState(definition) {
  return {
    id: definition.id,
    name: definition.name,
    stationType: definition.type,
    status: 'idle',
    startTime: null,
    endTime: null,
    tariffId: null,
    history: [],
    activeSessionId: null,
    lastClosedSnapshot: null,
  };
}

function syncStationsWithDefinitions(rawStations, defs = getStationDefinitions()) {
  const source = Array.isArray(rawStations) ? rawStations : [];
  const byId = new Map(source.map((item) => [Number(item?.id), item]));
  return defs.map((definition) => {
    const raw = byId.get(Number(definition.id)) || {};
    return {
      ...createStationState(definition),
      status: ['idle', 'running', 'grace', 'overdue'].includes(raw?.status) ? raw.status : 'idle',
      startTime: Number.isFinite(raw?.startTime) ? raw.startTime : null,
      endTime: Number.isFinite(raw?.endTime) ? raw.endTime : null,
      tariffId: typeof raw?.tariffId === 'string' ? raw.tariffId : null,
      history: Array.isArray(raw?.history) ? raw.history : [],
      activeSessionId: typeof raw?.activeSessionId === 'string' ? raw.activeSessionId : null,
      lastClosedSnapshot: normalizeRecoverySnapshot(raw?.lastClosedSnapshot),
      name: definition.name,
      stationType: definition.type,
    };
  });
}

function hashPin(pin) {
  const text = String(pin || '').trim();
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a_${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function loadPinGuard() {
  try {
    const raw = localStorage.getItem(PIN_GUARD_KEY);
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

function savePinGuard(state) {
  try {
    localStorage.setItem(PIN_GUARD_KEY, JSON.stringify({
      attempts: Math.max(0, Math.round(Number(state?.attempts) || 0)),
      lockUntil: Math.max(0, Number(state?.lockUntil) || 0),
    }));
  } catch {}
}

function clearPinGuard() {
  savePinGuard({ attempts: 0, lockUntil: 0 });
}

function getSettingsPinHash() {
  return String(settings?.pinHash || hashPin(DEFAULT_SETTINGS_PIN));
}

function makeTariffId(prefix = 'tariff') {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
}

function normalizeTariff(raw, fallbackIndex = 0, prefix = 'tariff') {
  const item = (raw && typeof raw === 'object') ? raw : {};
  const minutes = Math.max(10, Math.round(Number(item.minutes) || 0));
  const price = Math.max(0, Math.round(Number(item.price) || 0));
  const label = typeof item.label === 'string' && item.label.trim()
    ? item.label.trim()
    : `${Math.max(1, Math.round(minutes / 60))} ч`;
  return {
    id: typeof item.id === 'string' && item.id.trim() ? item.id.trim() : `${prefix}_${fallbackIndex + 1}`,
    label,
    minutes,
    price,
  };
}

function sortTariffs(list) {
  return [...list].sort((a, b) => {
    const minDiff = (a.minutes || 0) - (b.minutes || 0);
    if (minDiff !== 0) return minDiff;
    const priceDiff = (a.price || 0) - (b.price || 0);
    if (priceDiff !== 0) return priceDiff;
    const labelA = String(a.label || '').trim().toLocaleLowerCase('ru');
    const labelB = String(b.label || '').trim().toLocaleLowerCase('ru');
    return labelA.localeCompare(labelB, 'ru');
  });
}

function defaultTariffGroups() {
  return {
    ps: DEFAULT_TARIFFS_PS.map((t, idx) => normalizeTariff(t, idx, 'ps')),
    simulator: DEFAULT_TARIFFS_SIMULATOR.map((t, idx) => normalizeTariff(t, idx, 'sim')),
    switch: DEFAULT_TARIFFS_SWITCH.map((t, idx) => normalizeTariff(t, idx, 'sw')),
  };
}

function normalizeSettings(raw) {
  const src = (raw && typeof raw === 'object') ? raw : {};
  const base = {
    tariffGroups: defaultTariffGroups(),
    customRates: { ...DEFAULT_CUSTOM_RATES },
    stationDefinitions: defaultStationDefinitions(),
    graceMinutes: DEFAULT_GRACE_MINUTES,
    overdueMinutes: DEFAULT_AUTO_CLOSE_OVERDUE_MINUTES,
    currency: 'RUB',
    currencySymbol: '₽',
    pinHash: hashPin(DEFAULT_SETTINGS_PIN),
    notificationSound: false,
  };

  if (Array.isArray(src.tariffs)) {
    const migrated = sortTariffs(src.tariffs.map((t, idx) => normalizeTariff(t, idx, 'ps')).filter((t) => Number.isFinite(t.minutes) && t.minutes >= 10));
    if (migrated.length) {
      base.tariffGroups.ps = migrated.map((t, idx) => normalizeTariff({ ...t, id: `ps_${idx + 1}` }, idx, 'ps'));
      base.tariffGroups.simulator = migrated.map((t, idx) => normalizeTariff({ ...t, id: `sim_${idx + 1}` }, idx, 'sim'));
      base.tariffGroups.switch = migrated.map((t, idx) => normalizeTariff({ ...t, id: `sw_${idx + 1}` }, idx, 'sw'));
    }
  }
  if (src.tariffGroups && typeof src.tariffGroups === 'object') {
    for (const type of ['ps', 'simulator', 'switch']) {
      const rawList = Array.isArray(src.tariffGroups[type]) ? src.tariffGroups[type] : null;
      if (rawList && rawList.length) {
        base.tariffGroups[type] = sortTariffs(rawList.map((t, idx) => normalizeTariff(t, idx, type)).filter((t) => Number.isFinite(t.minutes) && t.minutes >= 10));
      }
    }
  }

  if (Array.isArray(src.stationDefinitions)) {
    base.stationDefinitions = normalizeStationDefinitions(src.stationDefinitions);
  }

  const legacyRate = Number(src.customRatePerHour);
  if (Number.isFinite(legacyRate) && legacyRate >= 0) {
    base.customRates.ps = Math.round(legacyRate);
    base.customRates.simulator = Math.round(legacyRate);
    base.customRates.switch = Math.round(legacyRate);
  }
  if (src.customRates && typeof src.customRates === 'object') {
    for (const type of ['ps', 'simulator', 'switch']) {
      const rate = Number(src.customRates[type]);
      if (Number.isFinite(rate) && rate >= 0) base.customRates[type] = Math.round(rate);
    }
  }

  const graceMinutes = Number(src.graceMinutes);
  if (Number.isFinite(graceMinutes) && graceMinutes >= 0) base.graceMinutes = Math.round(graceMinutes);
  const overdueMinutes = Number(src.overdueMinutes);
  if (Number.isFinite(overdueMinutes) && overdueMinutes >= 0) base.overdueMinutes = Math.round(overdueMinutes);

  const pinHash = typeof src.pinHash === 'string' && src.pinHash.trim() ? src.pinHash.trim() : '';
  if (pinHash) base.pinHash = pinHash;
  else if (src.security && typeof src.security === 'object' && typeof src.security.pinHash === 'string' && src.security.pinHash.trim()) base.pinHash = src.security.pinHash.trim();

  if (typeof src.notificationSound === 'boolean') base.notificationSound = src.notificationSound;
  else if (src.notifications && typeof src.notifications === 'object' && typeof src.notifications.sound === 'boolean') base.notificationSound = src.notifications.sound;

  return base;
}

function defaultSettings() {
  return normalizeSettings({});
}

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return normalizeSettings(JSON.parse(raw));
  } catch {}
  try {
    const legacyRaw = localStorage.getItem('pslounge_settings_v1');
    if (legacyRaw) return normalizeSettings(JSON.parse(legacyRaw));
  } catch {}
  return defaultSettings();
}

function saveSettings(immediate=false) {
  settings = normalizeSettings(settings);
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  touchModified(immediate);
}

function ensureSelectedTariffs() {
  if (!selectedTariffIds || typeof selectedTariffIds !== 'object') selectedTariffIds = {};
  for (const type of ['ps', 'simulator', 'switch']) {
    const list = settings.tariffGroups?.[type] || [];
    if (!list.length) {
      selectedTariffIds[type] = null;
      continue;
    }
    if (!list.find((t) => t.id === selectedTariffIds[type])) selectedTariffIds[type] = list[0].id;
  }
}

function getTariffs(stationType = 'ps') {
  return settings.tariffGroups?.[stationType] || [];
}

function getSelectedStationType() {
  if (selectedStationId != null) {
    const s = stations.find((x) => x.id === selectedStationId);
    if (s) return getStationType(s);
  }
  return getStationDefinitions()[0]?.type || 'ps';
}

function getCurrentTariffs() {
  return getTariffs(getSelectedStationType());
}

const $grid = document.getElementById('stations');
const $appShell = document.getElementById('appShell');
const $nowClock = document.getElementById('nowClock');
const $activeCount = document.getElementById('activeCount');
const $toast = document.getElementById('toast');
const $licenseGate = document.getElementById('licenseGate');
const $licenseFingerprint = document.getElementById('licenseFingerprint');
const $licenseLead = document.getElementById('licenseLead');
const $licenseNote = document.getElementById('licenseNote');
const $licenseKeyInput = document.getElementById('licenseKeyInput');
const $btnLicenseActivate = document.getElementById('btnLicenseActivate');
const $btnLicenseRetry = document.getElementById('btnLicenseRetry');

// control panel
const $ctlTitle = document.getElementById('ctlTitle');
const $ctlPill = document.getElementById('ctlPill');
const $ctlMeta = document.getElementById('ctlMeta');
const $control = document.getElementById('control');
const $ctlMetaMain = document.getElementById('ctlMetaMain');
const $ctlMetaSub = document.getElementById('ctlMetaSub');
const $ctlMetaStatusLabel = document.getElementById('ctlMetaStatusLabel');
const $ctlMetaStatus = document.getElementById('ctlMetaStatus');
const $ctlMetaUntilLabel = document.getElementById('ctlMetaUntilLabel');
const $ctlMetaUntil = document.getElementById('ctlMetaUntil');
const $tariffs = document.getElementById('tariffs');
const $btnStart = document.getElementById('btnStart');
const $btnExtend = document.getElementById('btnExtend');
const $btnStop = document.getElementById('btnStop');
const $btnUndo = document.getElementById('btnUndo');
const $btnRestoreLast = document.getElementById('btnRestoreLast');
const $undoNote = document.getElementById('undoNote');
const $btnToggleCustom = document.getElementById('btnToggleCustom');
const $customRow = document.getElementById('customRow');
const $customMinutes = document.getElementById('customMinutes');
const $btnCustomSet = document.getElementById('btnCustomSet');
const $btnCustomAdd = document.getElementById('btnCustomAdd');
const $btnPaidAdd30 = document.getElementById('btnPaidAdd30');
const $btnPaidAdd60 = document.getElementById('btnPaidAdd60');
const $paymentMethodButtons = document.getElementById('paymentMethodButtons');
const $selectedTariffPrice = document.getElementById('selectedTariffPrice');

// sessions modal
const $btnSessions = document.getElementById('btnSessions');
const $sessionsModal = document.getElementById('sessionsModal');
const $btnCloseSessions = document.getElementById('btnCloseSessions');
const $btnClearToday = document.getElementById('btnClearToday');
const $btnExportToday = document.getElementById('btnExportToday');
const $btnCloseShift = document.getElementById('btnCloseShift');
const $sessionsList = document.getElementById('sessionsList');
const $sessionsSub = document.getElementById('sessionsSub');
const $summaryRevenue = document.getElementById('summaryRevenue');
const $summarySessions = document.getElementById('summarySessions');
const $summaryAvgCheck = document.getElementById('summaryAvgCheck');
const $summaryPaid = document.getElementById('summaryPaid');

// reports modal
const $btnReports = document.getElementById('btnReports');
const $btnJournal = document.getElementById('btnJournal');
const $btnAchievements = document.getElementById('btnAchievements');
const $achievementsBadge = document.getElementById('achievementsBadge');
const $achievementsModal = document.getElementById('achievementsModal');
const $achievementsContent = $achievementsModal?.querySelector('.modal__content--achievements');
const $btnCloseAchievements = document.getElementById('btnCloseAchievements');
const $achievementSummaryUnlocked = document.getElementById('achievementSummaryUnlocked');
const $achievementSummaryInProgress = document.getElementById('achievementSummaryInProgress');
const $achievementSummaryLatest = document.getElementById('achievementSummaryLatest');
const $achievementHero = $achievementsModal?.querySelector('.achievementHero');
const $achievementHeroLead = document.getElementById('achievementHeroLead');
const $achievementHeroCount = document.getElementById('achievementHeroCount');
const $achievementHeroNext = document.getElementById('achievementHeroNext');
const $achievementSpotlight = document.getElementById('achievementSpotlight');
const $achievementFilters = document.getElementById('achievementFilters');
const $achievementsList = document.getElementById('achievementsList');
const $journalModal = document.getElementById('journalModal');
const $btnCloseJournal = document.getElementById('btnCloseJournal');
const $btnClearJournal = document.getElementById('btnClearJournal');
const $btnExportJournal = document.getElementById('btnExportJournal');
const $journalList = document.getElementById('journalList');
const $journalSub = document.getElementById('journalSub');
const $journalCount = document.getElementById('journalCount');
const $journalStats = document.getElementById('journalStats');
const $journalStationFilter = document.getElementById('journalStationFilter');
const $journalLevelFilter = document.getElementById('journalLevelFilter');
const $btnResetJournalFilters = document.getElementById('btnResetJournalFilters');
const $journalActiveFilters = document.getElementById('journalActiveFilters');
const $journalSearch = document.getElementById('journalSearch');
const $journalResultsInfo = document.getElementById('journalResultsInfo');
const $reportsModal = document.getElementById('reportsModal');
const $btnCloseReports = document.getElementById('btnCloseReports');
const $btnExportReports = document.getElementById('btnExportReports');
const $reportDateFrom = document.getElementById('reportDateFrom');
const $reportDateTo = document.getElementById('reportDateTo');
const $reportDateFromText = document.getElementById('reportDateFromText');
const $reportDateToText = document.getElementById('reportDateToText');
const $reportDateFromTrigger = document.getElementById('reportDateFromTrigger');
const $reportDateToTrigger = document.getElementById('reportDateToTrigger');
const $reportDateFromLabel = document.getElementById('reportDateFromLabel');
const $reportDateToLabel = document.getElementById('reportDateToLabel');
const $reportDateFromPicker = document.getElementById('reportDateFromPicker');
const $reportDateToPicker = document.getElementById('reportDateToPicker');
const $reportStationType = document.getElementById('reportStationType');
const $reportPayment = document.getElementById('reportPayment');
const $reportView = document.getElementById('reportView');
const $reportRevenue = document.getElementById('reportRevenue');
const $reportSessionsCount = document.getElementById('reportSessionsCount');
const $reportAvgCheck = document.getElementById('reportAvgCheck');
const $reportAvgDuration = document.getElementById('reportAvgDuration');
const $reportTypeTotals = document.getElementById('reportTypeTotals');
const $reportPaymentTotals = document.getElementById('reportPaymentTotals');
const $reportsList = document.getElementById('reportsList');
const $reportsSub = document.getElementById('reportsSub');
const $reportChart = document.getElementById('reportChart');
const $reportPresetButtons = Array.from(document.querySelectorAll('[data-report-preset]'));

const $pinModal = document.getElementById('pinModal');
const $pinInput = document.getElementById('pinInput');
const $pinNote = document.getElementById('pinNote');
const $btnPinSubmit = document.getElementById('btnPinSubmit');
const $btnPinCancel = document.getElementById('btnPinCancel');
const $btnClosePin = document.getElementById('btnClosePin');

// settings modal
const $btnSettings = document.getElementById('btnSettings');
const $settingsModal = document.getElementById('settingsModal');
const $btnCloseSettings = document.getElementById('btnCloseSettings');
const $btnSaveSettings = document.getElementById('btnSaveSettings');
const $btnResetSettings = document.getElementById('btnResetSettings');
const $settingsTariffs = document.getElementById('settingsTariffs');
const $settingsTypeTabs = document.getElementById('settingsTypeTabs');
const $settingsTypeTitle = document.getElementById('settingsTypeTitle');
const $settingsCustomRate = document.getElementById('settingsCustomRate');
const $settingsGraceMinutes = document.getElementById('settingsGraceMinutes');
const $settingsOverdueMinutes = document.getElementById('settingsOverdueMinutes');
const $settingsPinCurrent = document.getElementById('settingsPinCurrent');
const $settingsPinNew = document.getElementById('settingsPinNew');
const $settingsPinRepeat = document.getElementById('settingsPinRepeat');
const $settingsNotificationSound = document.getElementById('settingsNotificationSound');
const $btnTestNotificationSound = document.getElementById('btnTestNotificationSound');
const $btnChangePin = document.getElementById('btnChangePin');
const $subtitle = document.getElementById('subtitle');
const $btnAddTariff = document.getElementById('btnAddTariff');
const $settingsStations = document.getElementById('settingsStations');
const $btnAddStation = document.getElementById('btnAddStation');
const $settingsDirtyBadge = document.getElementById('settingsDirtyBadge');

let settingsEditorType = 'ps';
let settingsDraft = null;
let settingsModalUnlocked = false;
let settingsDraftDirty = false;
let settingsRenderInProgress = false;
let settingsBaselineSignature = '';
let reportDatePickerOpen = '';
const reportDatePickerMonth = { from: '', to: '' };
let settings = loadSettings();
let stations = loadStations();
stations = syncStationsWithDefinitions(stations, getStationDefinitions(settings));
let sessions = loadSessions();
let actionLog = loadActionLog();
let achievements = loadAchievements();
let achievementFilter = 'all';
if (actionLog.length > ACTION_LOG_MAX) {
  actionLog = actionLog.slice(0, ACTION_LOG_MAX);
  saveActionLog();
}

let selectedStationId = null;
let selectedTariffIds = { ps: null, simulator: null, switch: null };
ensureSelectedTariffs();
let selectedPaymentMethod = 'cash';
let appInitialized = false;
let licenseStatusCache = null;

let tickTimer = null;
let lastTickWallClock = Date.now();

function defaultStationName(id) {
  if (id === 5) return 'Симулятор гонок';
  if (id === 6) return 'Nintendo Switch';
  return `PS${id}`;
}

function defaultStations() {
  return Array.from({ length: 6 }, (_, i) => ({
    id: i + 1,
    name: defaultStationName(i + 1),
    status: 'idle', // idle | running | grace | overdue
    startTime: null,
    endTime: null,
    tariffId: null,
    history: [],
    activeSessionId: null,
    lastClosedSnapshot: null,
  }));
}

function loadStations() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultStations();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length !== 6) return defaultStations();

    const mapped = parsed.map((s, idx) => ({
      id: Number.isFinite(s?.id) ? s.id : idx + 1,
      name: (typeof s?.name === 'string' && s.name.trim()) ? s.name : defaultStationName(idx + 1),
      status: ['idle', 'running', 'grace', 'overdue'].includes(s?.status) ? s.status : 'idle',
      startTime: Number.isFinite(s?.startTime) ? s.startTime : null,
      endTime: Number.isFinite(s?.endTime) ? s.endTime : null,
      tariffId: typeof s?.tariffId === 'string' ? s.tariffId : null,
      history: Array.isArray(s?.history) ? s.history : [],
      activeSessionId: typeof s?.activeSessionId === 'string' ? s.activeSessionId : null,
      lastClosedSnapshot: normalizeRecoverySnapshot(s?.lastClosedSnapshot),
    }));

    if (mapped[4] && ['PS5', 'PS 5'].includes(mapped[4].name)) {
      mapped[4].name = 'Симулятор гонок';
    }
    if (mapped[5] && (mapped[5].name === 'PS6' || mapped[5].name === 'PS 6')) {
      mapped[5].name = 'Nintendo Switch';
    }

    return mapped;
  } catch {
    return defaultStations();
  }
}

function saveStations(immediate=false) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(stations));
  touchModified(immediate);
}

function areDefaultStationDefinitions(defs) {
  const normalized = normalizeStationDefinitions(defs);
  const base = defaultStationDefinitions();
  if (normalized.length !== base.length) return false;
  return normalized.every((item, idx) => item.id === base[idx].id && item.name === base[idx].name && item.type === base[idx].type);
}

function maybeMigrateStationDefinitionsFromLegacyStations(parsed) {
  if (!Array.isArray(parsed) || !parsed.length) return;
  if (!areDefaultStationDefinitions(settings?.stationDefinitions)) return;
  const defs = parsed.map((item, idx) => normalizeStationDefinition({
    id: Number.isFinite(Number(item?.id)) ? Number(item.id) : idx + 1,
    name: typeof item?.name === 'string' ? item.name : defaultStationDefinitions()[idx]?.name,
    type: String(item?.stationType || '').trim().toLowerCase() || (Number(item?.id) === 5 ? 'simulator' : Number(item?.id) === 6 ? 'switch' : 'ps'),
  }, idx));
  if (!defs.length) return;
  settings.stationDefinitions = normalizeStationDefinitions(defs);
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(normalizeSettings(settings)));
}

defaultStationName = function defaultStationName(id) {
  return getStationDefinitionById(id)?.name || `PS${id}`;
};

defaultStations = function defaultStations() {
  return syncStationsWithDefinitions([], getStationDefinitions());
};

loadStations = function loadStations() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultStations();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return defaultStations();
    maybeMigrateStationDefinitionsFromLegacyStations(parsed);
    return syncStationsWithDefinitions(parsed, getStationDefinitions());
  } catch {
    return defaultStations();
  }
};

function loadSessions() {
  try {
    const raw = localStorage.getItem(SESSIONS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};

    for (const key of Object.keys(parsed)) {
      const list = Array.isArray(parsed[key]) ? parsed[key] : [];
      parsed[key] = list.map((rec) => {
        const item = (rec && typeof rec === 'object') ? rec : {};
        const totalAmount = Number(item.totalAmount);
        const paymentMethod = typeof item.paymentMethod === 'string' ? item.paymentMethod : 'cash';
        const sales = Array.isArray(item.sales) ? item.sales.map((sale) => ({
          id: typeof sale?.id === 'string' ? sale.id : `sale_${Math.random().toString(16).slice(2)}`,
          time: Number.isFinite(sale?.time) ? sale.time : (Number.isFinite(item.startTime) ? item.startTime : Date.now()),
          type: typeof sale?.type === 'string' ? sale.type : 'sale',
          label: typeof sale?.label === 'string' ? sale.label : 'Продажа',
          minutes: Number.isFinite(Number(sale?.minutes)) ? Math.round(Number(sale.minutes)) : 0,
          amount: Math.max(0, Math.round(Number(sale?.amount) || 0)),
          paymentMethod: typeof sale?.paymentMethod === 'string' ? sale.paymentMethod : paymentMethod,
        })) : [];
        const safeTotal = Number.isFinite(totalAmount) ? Math.max(0, Math.round(totalAmount)) : 0;
        if (!sales.length && safeTotal > 0) {
          sales.push({
            id: `sale_legacy_${Math.random().toString(16).slice(2)}`,
            time: Number.isFinite(item.startTime) ? item.startTime : Date.now(),
            type: 'legacy',
            label: 'Продажа',
            minutes: 0,
            amount: safeTotal,
            paymentMethod,
          });
        }
        return {
          ...item,
          totalAmount: sales.reduce((sum, sale) => sum + (Number(sale.amount) || 0), 0),
          paymentMethod,
          sales,
        };
      });
    }
    return parsed;
  } catch {
    return {};
  }
}

function saveSessions(immediate=false) {
  localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions));
  touchModified(immediate);
}

function todayKey(ts = Date.now()) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function getTariffById(tariffId, stationType = null) {
  if (!tariffId) return null;
  const types = stationType ? [stationType] : ['ps', 'simulator', 'switch'];
  for (const type of types) {
    const found = getTariffs(type).find((t) => t.id === tariffId);
    if (found) return found;
  }
  return null;
}

function priceForMinutes(minutes, stationType = null) {
  const safe = Math.max(0, Number(minutes) || 0);
  const type = stationType || getSelectedStationType();
  const rate = Number(settings.customRates?.[type]);
  const perHour = Number.isFinite(rate) ? rate : DEFAULT_CUSTOM_RATES[type] || DEFAULT_CUSTOM_RATES.ps;
  return Math.round((perHour * safe) / 60);
}

function money(value) {
  const safe = Number.isFinite(Number(value)) ? Math.round(Number(value)) : 0;
  return `${safe.toLocaleString('ru-RU')} ${settings.currencySymbol || '₽'}`;
}

function paymentLabel(methodId) {
  const item = PAYMENT_METHODS.find((x) => x.id === methodId);
  return item ? item.label : 'Не указано';
}

function tariffPriceLabel(tariffId, stationType = null) {
  if (!tariffId) return '—';
  const type = stationType || getSelectedStationType();
  const tariff = getTariffById(tariffId, type);
  if (tariff) return money(tariff.price);
  if (String(tariffId).startsWith('custom:')) {
    const mins = parseInt(String(tariffId).split(':')[1], 10);
    return Number.isFinite(mins) ? money(priceForMinutes(mins, type)) : '—';
  }
  return '—';
}

function addSessionRecord(station, startTime, extra = {}) {
  const key = todayKey(startTime);
  if (!sessions[key]) sessions[key] = [];
  const id = `${station.id}-${startTime}-${Math.random().toString(16).slice(2)}`;
  sessions[key].push({
    id,
    stationId: station.id,
    stationType: getStationType(station),
    stationName: normalizeStationName(station.name),
    startTime,
    endTime: null,
    tariffId: station.tariffId,
    extraMinutes: 0,
    mode: 'started',
    totalAmount: 0,
    paymentMethod: selectedPaymentMethod || 'cash',
    sales: [],
    ...extra,
  });
  saveSessions(true);
  return id;
}

function getSessionRecordById(station, sid = null) {
  const key = station?.startTime ? todayKey(station.startTime) : todayKey();
  const list = sessions[key] || [];
  return list.find((x) => x.id === (sid || station?.activeSessionId)) || null;
}

function finalizeSession(station, endTime, mode) {
  const rec = getSessionRecordById(station);
  if (!rec) return;
  rec.endTime = endTime;
  rec.mode = mode;
  saveSessions(true);
}

function normalizeStationName(name) {
  if (!name) return name;
  if (name === 'PS23') return 'PS3';
  return name;
}

function recordSale(station, sale) {
  try {
    const rec = getSessionRecordById(station);
    if (!rec) { rejectAction(station, `${station?.name || 'Станция'}: продажа без активной сессии отклонена`); return; }
    if (!Array.isArray(rec.sales)) rec.sales = [];
    const rawAmount = Number(sale?.amount);
    if (!Number.isFinite(rawAmount) || rawAmount < 0) { rejectAction(station, `${station?.name || 'Станция'}: сумма продажи некорректна`); return; }
    const amount = Math.max(0, Math.round(rawAmount || 0));
    const rawMinutes = Number(sale?.minutes);
    if (Number.isFinite(rawMinutes) && rawMinutes < 0) { rejectAction(station, `${station?.name || 'Станция'}: минуты продажи не могут быть отрицательными`); return; }
    if (!amount && !(Number.isFinite(rawMinutes) && rawMinutes > 0)) { rejectAction(station, `${station?.name || 'Станция'}: пустая продажа отклонена`); return; }
    const entry = {
      id: `sale_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
      time: Date.now(),
      type: typeof sale?.type === 'string' ? sale.type : 'sale',
      label: typeof sale?.label === 'string' ? sale.label : 'Продажа',
      minutes: Number.isFinite(Number(sale?.minutes)) ? Math.round(Number(sale.minutes)) : 0,
      amount,
      paymentMethod: typeof sale?.paymentMethod === 'string' ? sale.paymentMethod : (rec.paymentMethod || selectedPaymentMethod || 'cash'),
    };
    rec.sales.push(entry);
    rec.totalAmount = rec.sales.reduce((sum, x) => sum + (Number(x.amount) || 0), 0);
    rec.paymentMethod = entry.paymentMethod;
    saveSessions(true);
  } catch {}
}

function bumpSessionExtension(station, deltaMinutes) {
  try {
    const dm = Number(deltaMinutes);
    if (!Number.isFinite(dm) || dm === 0) return;
    const rec = getSessionRecordById(station);
    if (!rec) { rejectAction(station, `${station?.name || 'Станция'}: продажа без активной сессии отклонена`); return; }
    const current = Number(rec.extraMinutes || 0);
    rec.extraMinutes = (Number.isFinite(current) ? current : 0) + dm;
    saveSessions(true);
  } catch {}
}

function setSessionPaymentMethod(station, methodId) {
  try {
    const rec = getSessionRecordById(station);
    if (!rec) { rejectAction(station, `${station?.name || 'Станция'}: продажа без активной сессии отклонена`); return; }
    rec.paymentMethod = methodId;
    saveSessions(true);
  } catch {}
}

function salesTotal(list) {
  return (Array.isArray(list) ? list : []).reduce((sum, rec) => sum + (Number(rec?.totalAmount) || 0), 0);
}

function paymentTotalsFromSessions(list) {
  const totals = Object.fromEntries(PAYMENT_METHODS.map((m) => [m.id, 0]));
  for (const rec of (Array.isArray(list) ? list : [])) {
    const sales = Array.isArray(rec?.sales) ? rec.sales : [];
    if (sales.length) {
      for (const sale of sales) {
        const pm = totals[sale.paymentMethod] != null ? sale.paymentMethod : 'cash';
        totals[pm] += Number(sale.amount) || 0;
      }
    } else {
      const pm = totals[rec?.paymentMethod] != null ? rec.paymentMethod : 'cash';
      totals[pm] += Number(rec?.totalAmount) || 0;
    }
  }
  return totals;
}

function computeConcurrentStationPeak() {
  const points = [];
  const now = Date.now();
  for (const list of Object.values(sessions || {})) {
    if (!Array.isArray(list)) continue;
    for (const rec of list) {
      const start = Number(rec?.startTime);
      if (!Number.isFinite(start) || start <= 0) continue;
      const end = Number.isFinite(Number(rec?.endTime)) ? Number(rec.endTime) : now;
      points.push({ ts: start, delta: 1 });
      points.push({ ts: Math.max(start, end), delta: -1 });
    }
  }
  points.sort((a, b) => a.ts - b.ts || a.delta - b.delta);
  let current = 0;
  let peak = 0;
  for (const point of points) {
    current += point.delta;
    if (current > peak) peak = current;
  }
  return peak;
}

function computeCleanCloseStreak() {
  const events = [];
  const trackingStartedAt = Math.max(0, Math.round(Number(achievements?.cleanTrackingStartedAt) || 0));
  for (const list of Object.values(sessions || {})) {
    if (!Array.isArray(list)) continue;
    for (const rec of list) {
      const endTime = Math.round(Number(rec?.endTime));
      if (!Number.isFinite(endTime) || endTime <= 0 || endTime < trackingStartedAt) continue;
      events.push({ ts: endTime, type: 'close' });
    }
  }
  for (const ts of achievements?.breakEvents || []) {
    const breakTs = Math.round(Number(ts));
    if (!Number.isFinite(breakTs) || breakTs <= 0 || breakTs < trackingStartedAt) continue;
    events.push({ ts: breakTs, type: 'break' });
  }
  events.sort((a, b) => a.ts - b.ts || (a.type === 'break' ? -1 : 1));
  let streak = 0;
  let best = 0;
  for (const event of events) {
    if (event.type === 'break') {
      streak = 0;
      continue;
    }
    streak += 1;
    if (streak > best) best = streak;
  }
  return best;
}

function collectAchievementMetrics() {
  const perDayClosed = new Map();
  const perTypeClosed = { ps: 0, simulator: 0, switch: 0 };
  let closedSessions = 0;
  let totalRevenue = 0;
  let maxDurationMinutes = 0;
  let totalPlayMinutes = 0;
  let paidExtensions = 0;
  let totalSales = 0;
  const paymentSet = new Set();
  const paymentCounts = { cash: 0, card: 0, transfer: 0 };
  let highestSessionAmount = 0;

  for (const [dayKey, list] of Object.entries(sessions || {})) {
    if (!Array.isArray(list)) continue;
    for (const rec of list) {
      if (!rec || typeof rec !== 'object') continue;
      const sessionAmount = Math.max(0, Math.round(Number(rec.totalAmount) || 0));
      totalRevenue += sessionAmount;
      if (sessionAmount > highestSessionAmount) highestSessionAmount = sessionAmount;
      const sales = Array.isArray(rec.sales) ? rec.sales : [];
      if (sales.length) {
        totalSales += sales.length;
        for (const sale of sales) {
          const paymentMethod = String(sale?.paymentMethod || rec.paymentMethod || 'cash');
          if (PAYMENT_METHODS.some((item) => item.id === paymentMethod)) paymentSet.add(paymentMethod);
          if (paymentCounts[paymentMethod] != null) paymentCounts[paymentMethod] += 1;
          if (['extend_tariff', 'extend_custom', 'extend_paid_minutes'].includes(String(sale?.type || ''))) paidExtensions += 1;
        }
      } else {
        const fallbackMethod = String(rec.paymentMethod || 'cash');
        if (PAYMENT_METHODS.some((item) => item.id === fallbackMethod)) paymentSet.add(fallbackMethod);
        if (paymentCounts[fallbackMethod] != null && sessionAmount > 0) paymentCounts[fallbackMethod] += 1;
        if (Number(rec?.totalAmount) > 0) totalSales += 1;
      }
      if (!Number.isFinite(Number(rec.endTime))) continue;
      closedSessions += 1;
      perDayClosed.set(dayKey, (perDayClosed.get(dayKey) || 0) + 1);
      const stype = getStationType(rec);
      if (perTypeClosed[stype] != null) perTypeClosed[stype] += 1;
      const duration = Math.max(0, Math.round((Number(rec.endTime) - Number(rec.startTime || rec.endTime)) / 60000));
      totalPlayMinutes += duration;
      if (duration > maxDurationMinutes) maxDurationMinutes = duration;
    }
  }

  return {
    closedSessions,
    concurrentPeak: computeConcurrentStationPeak(),
    stationCount: Math.max(1, getStationDefinitions().length),
    maxDurationMinutes,
    totalPlayMinutes,
    paidExtensions,
    totalRevenue,
    paymentCount: paymentSet.size,
    bestDayClosed: Math.max(0, ...perDayClosed.values()),
    psClosed: perTypeClosed.ps || 0,
    simulatorClosed: perTypeClosed.simulator || 0,
    switchClosed: perTypeClosed.switch || 0,
    cleanCloseStreak: computeCleanCloseStreak(),
    activeDays: perDayClosed.size,
    totalSales,
    cashCount: paymentCounts.cash,
    cardCount: paymentCounts.card,
    transferCount: paymentCounts.transfer,
    highestSessionAmount,
  };
}

function metricForAchievement(id, metrics) {
  const def = getAchievementDefinition(id);
  if (!def) return 0;
  if (id === 'full_house') return Math.min(metrics.concurrentPeak, metrics.stationCount);
  const metricValue = metrics?.[def.metric];
  return Number.isFinite(Number(metricValue)) ? Number(metricValue) : 0;
}

function renderAchievementsButton() {
  if (!$btnAchievements || !$achievementsBadge) return;
  const unseen = countUnseenAchievements();
  $achievementsBadge.textContent = unseen > 9 ? '9+' : String(unseen);
  $achievementsBadge.hidden = unseen <= 0;
  $btnAchievements.classList.toggle('chip--active', unseen > 0);
}

function getAchievementViewModels() {
  const progressMap = achievements?.progress || {};
  const unlockedMap = achievements?.unlocked || {};
  return ACHIEVEMENT_DEFINITIONS.map((item) => {
    const unlockedEntry = unlockedMap[item.id] || null;
    const dynamicMax = item.id === 'full_house' ? Math.max(1, getStationDefinitions().length) : item.progressMax;
    const progressMax = Math.max(1, Number(dynamicMax) || 1);
    const progressRaw = Math.max(0, Number(progressMap[item.id] || 0));
    const progressValue = Math.min(progressMax, progressRaw);
    return {
      ...item,
      progressMax,
      progressValue,
      progressPercent: Math.min(100, Math.round((progressValue / progressMax) * 100)),
      isUnlocked: !!unlockedEntry,
      unlockedAt: unlockedEntry?.unlockedAt || null,
      seenAt: unlockedEntry?.seenAt || null,
    };
  });
}

function achievementRarity(item) {
  if (item?.rarity === 'mythic') return 'Мифическое';
  if (item?.rarity === 'legend') return 'Легенда';
  if (item?.rarity === 'elite') return 'Элита';
  if (item?.rarity === 'rare') return 'Редкое';
  return 'Базовое';
}

function achievementRaritySlug(item) {
  if (item?.rarity === 'mythic') return 'mythic';
  if (item?.rarity === 'legend') return 'legend';
  if (item?.rarity === 'elite') return 'elite';
  if (item?.rarity === 'rare') return 'rare';
  return 'base';
}

function achievementMatchesFilter(item, filter) {
  if (filter === 'unlocked') return item.isUnlocked;
  if (filter === 'progress') return !item.isUnlocked && item.progressValue > 0;
  if (filter === 'top') return ['legend', 'mythic'].includes(achievementRaritySlug(item));
  return true;
}

function achievementFilterOptions(items) {
  return [
    { id: 'all', label: 'Все', count: items.length },
    { id: 'unlocked', label: 'Получено', count: items.filter((item) => item.isUnlocked).length },
    { id: 'progress', label: 'На пути', count: items.filter((item) => !item.isUnlocked && item.progressValue > 0).length },
    { id: 'top', label: 'Топ', count: items.filter((item) => ['legend', 'mythic'].includes(achievementRaritySlug(item))).length },
  ];
}

function achievementIconKey(item) {
  const metric = String(item?.metric || '');
  if (metric === 'closedSessions') return 'rhythm';
  if (metric === 'concurrentPeak') return 'hall';
  if (metric === 'maxDurationMinutes' || metric === 'totalPlayMinutes') return 'clock';
  if (metric === 'paidExtensions') return 'plus';
  if (metric === 'totalRevenue' || metric === 'totalSales') return 'coins';
  if (metric === 'paymentCount') return 'wallet';
  if (metric === 'cashCount') return 'cash';
  if (metric === 'cardCount') return 'card';
  if (metric === 'transferCount') return 'transfer';
  if (metric === 'simulatorClosed') return 'simulator';
  if (metric === 'switchClosed') return 'switch';
  if (metric === 'psClosed') return 'gamepad';
  if (metric === 'cleanCloseStreak') return 'check';
  if (metric === 'activeDays' || metric === 'bestDayClosed') return 'calendar';
  if (metric === 'highestSessionAmount') return 'gem';
  return 'star';
}

function renderAchievementGlyph(iconKey) {
  switch (iconKey) {
    case 'rhythm':
      return '<svg viewBox="0 0 24 24" class="achievementGlyph" aria-hidden="true"><path d="M3 15c2.2 0 2.2-6 4.4-6s2.2 10 4.4 10 2.2-14 4.4-14 2.2 8 4.4 8" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    case 'hall':
      return '<svg viewBox="0 0 24 24" class="achievementGlyph" aria-hidden="true"><circle cx="6" cy="6" r="2.2" fill="currentColor"/><circle cx="12" cy="6" r="2.2" fill="currentColor"/><circle cx="18" cy="6" r="2.2" fill="currentColor"/><circle cx="6" cy="12" r="2.2" fill="currentColor"/><circle cx="12" cy="12" r="2.2" fill="currentColor"/><circle cx="18" cy="12" r="2.2" fill="currentColor"/><circle cx="6" cy="18" r="2.2" fill="currentColor"/><circle cx="12" cy="18" r="2.2" fill="currentColor"/><circle cx="18" cy="18" r="2.2" fill="currentColor"/></svg>';
    case 'clock':
      return '<svg viewBox="0 0 24 24" class="achievementGlyph" aria-hidden="true"><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 7.2V12l3.6 2.2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    case 'plus':
      return '<svg viewBox="0 0 24 24" class="achievementGlyph" aria-hidden="true"><path d="M12 4.5v15M4.5 12h15" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/><circle cx="12" cy="12" r="8.8" fill="none" stroke="currentColor" stroke-opacity=".32" stroke-width="1.2"/></svg>';
    case 'coins':
      return '<svg viewBox="0 0 24 24" class="achievementGlyph" aria-hidden="true"><ellipse cx="8" cy="8" rx="3.6" ry="1.8" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M4.4 8v4.4c0 1 1.6 1.8 3.6 1.8s3.6-.8 3.6-1.8V8M12.6 11.2c0-1 1.6-1.8 3.6-1.8s3.6.8 3.6 1.8v4.6c0 1-1.6 1.8-3.6 1.8s-3.6-.8-3.6-1.8v-4.6Z" fill="none" stroke="currentColor" stroke-width="1.6"/><ellipse cx="16.2" cy="11.2" rx="3.6" ry="1.8" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>';
    case 'wallet':
      return '<svg viewBox="0 0 24 24" class="achievementGlyph" aria-hidden="true"><path d="M4.5 8.2c0-1.4 1.1-2.5 2.5-2.5h10.6a1.9 1.9 0 0 1 1.9 1.9v1.1h-9.2A2.8 2.8 0 0 0 7.5 11.5v1A2.8 2.8 0 0 0 10.3 15h9.2v1.4a1.9 1.9 0 0 1-1.9 1.9H7A2.5 2.5 0 0 1 4.5 15.8V8.2Z" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M19.5 9.7h-9.2c-1 0-1.8.8-1.8 1.8v1c0 1 .8 1.8 1.8 1.8h9.2Z" fill="none" stroke="currentColor" stroke-width="1.7"/><circle cx="13.1" cy="12" r="1.1" fill="currentColor"/></svg>';
    case 'cash':
      return '<svg viewBox="0 0 24 24" class="achievementGlyph" aria-hidden="true"><rect x="4" y="6.5" width="16" height="11" rx="2.2" fill="none" stroke="currentColor" stroke-width="1.7"/><circle cx="12" cy="12" r="2.5" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M7 9.3h.01M17 14.7h.01" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>';
    case 'card':
      return '<svg viewBox="0 0 24 24" class="achievementGlyph" aria-hidden="true"><rect x="3.8" y="6" width="16.4" height="12" rx="2.4" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M3.8 10.1h16.4" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M7.4 14.1h4.2" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>';
    case 'transfer':
      return '<svg viewBox="0 0 24 24" class="achievementGlyph" aria-hidden="true"><path d="M6 8h10.5M13.4 4.8 17 8.2l-3.6 3.4M18 16H7.5M10.6 12.6 7 16l3.6 3.4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    case 'simulator':
      return '<svg viewBox="0 0 24 24" class="achievementGlyph" aria-hidden="true"><circle cx="12" cy="12" r="6.8" fill="none" stroke="currentColor" stroke-width="1.7"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><path d="M12 5.2v4.6M18.8 12h-4.6M12 18.8v-4.6M5.2 12h4.6" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>';
    case 'switch':
      return '<svg viewBox="0 0 24 24" class="achievementGlyph" aria-hidden="true"><rect x="4.2" y="5.2" width="6.4" height="13.6" rx="3.2" fill="none" stroke="currentColor" stroke-width="1.7"/><rect x="13.4" y="5.2" width="6.4" height="13.6" rx="3.2" fill="none" stroke="currentColor" stroke-width="1.7"/><circle cx="7.4" cy="9.2" r="1.1" fill="currentColor"/><circle cx="16.6" cy="14.8" r="1.1" fill="currentColor"/></svg>';
    case 'gamepad':
      return '<svg viewBox="0 0 24 24" class="achievementGlyph" aria-hidden="true"><path d="M7 10.4h10c1.9 0 3.4 1.5 3.4 3.4 0 3.2-2 5.2-3.7 5.2-1.1 0-1.8-.6-2.6-1.2-.7-.5-1.4-1-2.1-1s-1.4.5-2.1 1c-.8.6-1.5 1.2-2.6 1.2C5.6 19 3.6 17 3.6 13.8c0-1.9 1.5-3.4 3.4-3.4Z" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M8 13.3v2.2M6.9 14.4h2.2M15.8 13.8h.01M17.4 15.4h.01" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
    case 'check':
      return '<svg viewBox="0 0 24 24" class="achievementGlyph" aria-hidden="true"><path d="M5.5 12.8 9.6 17l8.9-10.2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="12" cy="12" r="8.6" fill="none" stroke="currentColor" stroke-opacity=".32" stroke-width="1.2"/></svg>';
    case 'calendar':
      return '<svg viewBox="0 0 24 24" class="achievementGlyph" aria-hidden="true"><rect x="4.2" y="6" width="15.6" height="13.2" rx="2.2" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M8 4.5v3M16 4.5v3M4.2 9.4h15.6" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><path d="m9.2 13.2 1.7 1.8 3.9-4.2" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    case 'gem':
      return '<svg viewBox="0 0 24 24" class="achievementGlyph" aria-hidden="true"><path d="M7 8.4 9.7 5h4.6L17 8.4 12 19 7 8.4Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M7 8.4h10M9.7 5 12 8.4 14.3 5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>';
    default:
      return '<svg viewBox="0 0 24 24" class="achievementGlyph" aria-hidden="true"><path d="m12 4.8 2.2 4.6 5 .7-3.6 3.6.9 5-4.5-2.4-4.5 2.4.9-5-3.6-3.6 5-.7Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>';
  }
}

function renderAchievementEmblem(item, variant = 'card') {
  const token = escapeHtml(String(item?.icon || '★'));
  const rarity = escapeHtml(achievementRaritySlug(item));
  const glyph = renderAchievementGlyph(achievementIconKey(item));
  return `
    <div class="achievementEmblem achievementEmblem--${rarity} achievementEmblem--${escapeHtml(variant)}" aria-hidden="true">
      <div class="achievementEmblem__halo"></div>
      <div class="achievementEmblem__ring"></div>
      <div class="achievementEmblem__core">
        <div class="achievementEmblem__glyph">${glyph}</div>
        <div class="achievementEmblem__chip">${token}</div>
      </div>
    </div>
  `;
}

function renderAchievements() {
  if (!$achievementsList) return;
  const items = getAchievementViewModels().sort((a, b) => {
    if (a.isUnlocked !== b.isUnlocked) return a.isUnlocked ? -1 : 1;
    if (a.isUnlocked && b.isUnlocked) return (b.unlockedAt || 0) - (a.unlockedAt || 0);
    return b.progressPercent - a.progressPercent;
  });
  const unlockedCount = items.filter((item) => item.isUnlocked).length;
  const latest = items.filter((item) => item.isUnlocked).sort((a, b) => (b.unlockedAt || 0) - (a.unlockedAt || 0))[0] || null;
  const nextGoal = items
    .filter((item) => !item.isUnlocked)
    .sort((a, b) => {
      if (b.progressPercent !== a.progressPercent) return b.progressPercent - a.progressPercent;
      return (a.progressMax - a.progressValue) - (b.progressMax - b.progressValue);
    })[0] || null;
  const spotlight = nextGoal || latest || items[0] || null;

  if ($achievementSummaryUnlocked) $achievementSummaryUnlocked.textContent = `${unlockedCount}/${items.length}`;
  if ($achievementSummaryInProgress) {
    $achievementSummaryInProgress.textContent = nextGoal
      ? `${nextGoal.title} • ${nextGoal.progressValue}/${nextGoal.progressMax}`
      : 'Коллекция завершена';
  }
  if ($achievementSummaryLatest) $achievementSummaryLatest.textContent = latest ? `${latest.title} • ${formatDateRU(latest.unlockedAt)}` : '—';
  if ($achievementHeroCount) $achievementHeroCount.textContent = `${unlockedCount}/${items.length}`;
  if ($achievementHeroNext) {
    $achievementHeroNext.textContent = nextGoal
      ? `${nextGoal.title} • ${nextGoal.progressValue}/${nextGoal.progressMax}`
      : 'Все вехи собраны';
  }
  if ($achievementHeroLead) {
    $achievementHeroLead.textContent = nextGoal
      ? `Ближе всего сейчас цель «${nextGoal.title}»: уже ${nextGoal.progressValue} из ${nextGoal.progressMax}. Витрина отмечает не быстрые победы, а длинный ритм смен, выручки и полной загрузки зала.`
      : 'Коллекция закрыта полностью. Все ключевые вехи по сессиям, загрузке зала и выручке уже собраны.';
  }
  if ($achievementSpotlight) {
    if (spotlight) {
      const rarity = achievementRarity(spotlight);
      const stateLabel = spotlight.isUnlocked ? 'Получено' : spotlight.progressValue > 0 ? 'На пути' : 'Запечатано';
      const stateMeta = spotlight.isUnlocked && spotlight.unlockedAt
        ? `Витрина пополнилась ${formatDateRU(spotlight.unlockedAt)}`
        : `Текущий прогресс: ${spotlight.progressValue}/${spotlight.progressMax}`;
      const accentLabel = spotlight.isUnlocked ? 'Последнее достижение' : 'Фокус коллекции';
      $achievementSpotlight.innerHTML = `
        <article class="achievementSpotlight__card achievementSpotlight__card--${achievementRaritySlug(spotlight)}${spotlight.isUnlocked ? ' achievementSpotlight__card--unlocked' : ''}">
          <div class="achievementSpotlight__artWrap">
            ${renderAchievementEmblem(spotlight, 'spotlight')}
          </div>
          <div class="achievementSpotlight__body">
            <div class="achievementSpotlight__eyebrow">${escapeHtml(accentLabel)}</div>
            <div class="achievementSpotlight__titleRow">
              <div>
                <h3 class="achievementSpotlight__title">${escapeHtml(spotlight.title)}</h3>
                <div class="achievementSpotlight__meta">${escapeHtml(stateMeta)}</div>
              </div>
              <div class="achievementSpotlight__state">${escapeHtml(stateLabel)}</div>
            </div>
            <div class="achievementSpotlight__tags">
              <span class="achievementTag">${escapeHtml(spotlight.category)}</span>
              <span class="achievementTag achievementTag--accent">${escapeHtml(rarity)}</span>
            </div>
            <p class="achievementSpotlight__description">${escapeHtml(spotlight.description)}</p>
            <div class="achievementProgress achievementProgress--spotlight">
              <div class="achievementProgress__track"><span class="achievementProgress__fill" style="width:${spotlight.progressPercent}%"></span></div>
              <div class="achievementProgress__label">${escapeHtml(String(spotlight.progressValue))}/${escapeHtml(String(spotlight.progressMax))}</div>
            </div>
          </div>
        </article>
      `;
    } else {
      $achievementSpotlight.innerHTML = '';
    }
  }

  const filterOptions = achievementFilterOptions(items);
  if (!filterOptions.some((item) => item.id === achievementFilter && item.count > 0) && achievementFilter !== 'all') {
    achievementFilter = 'all';
  }
  if ($achievementFilters) {
    $achievementFilters.innerHTML = filterOptions.map((item) => `
      <button class="achievementFilter${item.id === achievementFilter ? ' achievementFilter--active' : ''}" type="button" data-achievement-filter="${escapeHtml(item.id)}">
        <span class="achievementFilter__label">${escapeHtml(item.label)}</span>
        <span class="achievementFilter__count">${escapeHtml(String(item.count))}</span>
      </button>
    `).join('');
  }

  const filteredItems = items.filter((item) => achievementMatchesFilter(item, achievementFilter));
  $achievementsList.innerHTML = '';
  if (!filteredItems.length) {
    $achievementsList.innerHTML = `
      <article class="achievementEmptyState">
        <div class="achievementEmptyState__eyebrow">Пусто по фильтру</div>
        <div class="achievementEmptyState__title">Сейчас здесь нет подходящих достижений</div>
        <div class="achievementEmptyState__body">Смените фильтр выше, чтобы вернуться к полной коллекции и текущим вехам.</div>
      </article>
    `;
    return;
  }
  const featuredId = achievementFilter === 'progress'
    ? nextGoal?.id || null
    : achievementFilter === 'all'
      ? latest?.id || null
      : null;
  filteredItems.forEach((item, index) => {
    const card = document.createElement('article');
    const isFeatured = !!featuredId && item.id === featuredId && item.id !== spotlight?.id;
    const backdropToken = item.icon || item.category.slice(0, 3).toUpperCase();
    const featuredLabel = achievementFilter === 'progress' ? 'Следующая цель' : 'Последнее достижение';
    card.className = `achievementCard achievementCard--${achievementRaritySlug(item)}${item.isUnlocked ? ' achievementCard--unlocked' : item.progressValue > 0 ? ' achievementCard--progress' : ''}${!item.isUnlocked ? ' achievementCard--locked' : ''}${isFeatured ? ' achievementCard--featured' : ''}${index % 5 === 3 ? ' achievementCard--tall' : ''}`;
    card.innerHTML = `
      <div class="achievementCard__marker achievementCard__marker--${item.isUnlocked ? 'done' : item.progressValue > 0 ? 'track' : 'sealed'}"></div>
      <div class="achievementCard__backdrop">${escapeHtml(String(backdropToken))}</div>
      <div class="achievementCard__head">
        <div class="achievementCard__iconWrap">
          ${renderAchievementEmblem(item, isFeatured ? 'featured' : 'card')}
        </div>
        <div>
          ${isFeatured ? `<div class="achievementCard__eyebrow">${escapeHtml(featuredLabel)}</div>` : ''}
          <div class="achievementCard__title">${escapeHtml(item.title)}</div>
          <div class="achievementCard__meta">${item.isUnlocked && item.unlockedAt ? `Получено • ${escapeHtml(formatDateRU(item.unlockedAt))}` : item.progressValue > 0 ? `На пути • ${escapeHtml(String(item.progressValue))}/${escapeHtml(String(item.progressMax))}` : 'Коллекция ещё закрыта'}</div>
        </div>
        <div class="achievementCard__statusStack">
          <div class="achievementCard__corner">${escapeHtml(achievementRarity(item))}</div>
          <div class="achievementCard__state">${item.isUnlocked ? 'Получено' : item.progressValue > 0 ? 'На пути' : 'Запечатано'}</div>
        </div>
      </div>
      <div class="achievementCard__tags">
        <span class="achievementTag">${escapeHtml(item.category)}</span>
        <span class="achievementTag achievementTag--accent">${escapeHtml(achievementRarity(item))}</span>
      </div>
      <div class="achievementCard__body">${escapeHtml(item.description)}</div>
      <div class="achievementProgress">
        <div class="achievementProgress__track"><span class="achievementProgress__fill" style="width:${item.progressPercent}%"></span></div>
        <div class="achievementProgress__label">${escapeHtml(String(item.progressValue))}/${escapeHtml(String(item.progressMax))}</div>
      </div>
    `;
    $achievementsList.appendChild(card);
  });
}

function openAchievements() {
  if (!$achievementsModal) return;
  $achievementsModal.classList.add('modal--open');
  $achievementsModal.setAttribute('aria-hidden', 'false');
  if (countUnseenAchievements() > 0) {
    const seenAt = Date.now();
    for (const id of achievements.unseenIds || []) {
      if (achievements.unlocked[id]) achievements.unlocked[id].seenAt = seenAt;
    }
    achievements.unseenIds = [];
    saveAchievements(true);
  }
  renderAchievementsButton();
  renderAchievements();
  if ($achievementsContent) {
    $achievementsContent.scrollTop = 0;
    requestAnimationFrame(() => {
      if ($achievementsContent) $achievementsContent.scrollTop = 0;
      $achievementHero?.scrollIntoView({ block: 'start', inline: 'nearest' });
      setTimeout(() => {
        if ($achievementsContent) $achievementsContent.scrollTop = 0;
      }, 0);
    });
  }
}

function closeAchievements() {
  $achievementsModal?.classList.remove('modal--open');
  $achievementsModal?.setAttribute('aria-hidden', 'true');
}

function syncAchievementsState(options = {}) {
  if (!achievements) achievements = defaultAchievementsState();
  if (syncAchievementsState._running) return;
  syncAchievementsState._running = true;
  try {
    const state = normalizeAchievementsState(achievements);
    const metrics = collectAchievementMetrics();
    const progress = {};
    const unseen = new Set(state.unseenIds || []);
    const now = Date.now();
    const isBackfill = state.backfillVersion < ACHIEVEMENTS_BACKFILL_VERSION;
    const newlyUnlocked = [];

    for (const item of ACHIEVEMENT_DEFINITIONS) {
      const progressMax = item.id === 'full_house' ? Math.max(1, metrics.stationCount) : item.progressMax;
      const value = Math.max(0, metricForAchievement(item.id, metrics));
      progress[item.id] = Math.min(progressMax, value);
      if (value >= progressMax && !state.unlocked[item.id]) {
        state.unlocked[item.id] = {
          unlockedAt: now,
          seenAt: options.silent ? now : null,
        };
        if (!options.silent) unseen.add(item.id);
        newlyUnlocked.push(item.id);
      }
    }

    state.progress = progress;
    state.unseenIds = [...unseen].filter((id) => state.unlocked[id]);
    if (isBackfill) state.backfillVersion = ACHIEVEMENTS_BACKFILL_VERSION;
    achievements = state;
    localStorage.setItem(ACHIEVEMENTS_KEY, JSON.stringify(achievements));

    if (newlyUnlocked.length && !(isBackfill || options.silent)) {
      const latestDef = getAchievementDefinition(newlyUnlocked[newlyUnlocked.length - 1]);
      if (latestDef) toast(`Достижение открыто: ${latestDef.title}`, 2400);
      newlyUnlocked.forEach((id) => {
        const def = getAchievementDefinition(id);
        if (!def) return;
        addActionLog('Достижение открыто', null, def.title, 'info', { suppressAchievementSync: true });
      });
      touchModified(true);
    } else if (isBackfill && newlyUnlocked.length) {
      newlyUnlocked.forEach((id) => {
        const def = getAchievementDefinition(id);
        if (!def) return;
        addActionLog('Достижение открыто', null, def.title, 'info', { suppressAchievementSync: true });
      });
      touchModified(true);
    }

    renderAchievementsButton();
    if ($achievementsModal?.classList.contains('modal--open')) renderAchievements();
  } finally {
    syncAchievementsState._running = false;
  }
}

function init() {
  if (appInitialized) return;
  appInitialized = true;
  // migrate legacy station names
  for (const s of stations) {
    if (s && s.name) s.name = normalizeStationName(s.name);
  }
  // migrate legacy sessions stationName
  try {
    for (const k of Object.keys(sessions||{})) {
      const list = sessions[k];
      if (!Array.isArray(list)) continue;
      for (const rec of list) {
        if (rec && rec.stationName) rec.stationName = normalizeStationName(rec.stationName);
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
  if ($journalSub) $journalSub.textContent = 'Последние действия администратора и защитные срабатывания.';
  syncControl();
  startAutoSave();

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && dirtySinceFlush) scheduleFlush(true);
  });

  // warn on closing tab/window when there are active stations
  window.addEventListener('beforeunload', (e) => {
    try {
      const hasActive = stations.some(s => s && s.status && s.status !== 'idle');
      if (!hasActive) return;
      e.preventDefault();
      e.returnValue = '';
    } catch {}
  });
}

function bindUI() {
  $btnSessions.addEventListener('click', openSessions);
  $btnAchievements?.addEventListener('click', openAchievements);
  $btnCloseSessions?.addEventListener('click', closeSessions);
  $btnCloseAchievements?.addEventListener('click', closeAchievements);
  $sessionsModal.addEventListener('click', (e) => {
    if (e.target === $sessionsModal) closeSessions();
  });
  $achievementsModal?.addEventListener('click', (e) => {
    if (e.target === $achievementsModal) closeAchievements();
  });
  $achievementFilters?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-achievement-filter]');
    if (!btn) return;
    achievementFilter = btn.getAttribute('data-achievement-filter') || 'all';
    renderAchievements();
  });
  $btnClearToday.addEventListener('click', () => {
    const ok = confirm('Очистить список сессий за сегодня?\n\nЭто действие удалит весь список и его нельзя отменить.');
    if (!ok) return;
    const key = todayKey();
    const result = clearSessionsForDay(key);
    renderSessions();
    if (result.keptActive) toast(`Очищено ${result.removed} сессий, активные (${result.keptActive}) сохранены`);
    else toast('Сессии за сегодня очищены');
  });

  if ($btnExportToday) {
    $btnExportToday.addEventListener('click', withButtonGuard($btnExportToday, 'export_today', () => {
      const list = todaySessionsList();
      if (!list || list.length === 0) { toast('Сессий за сегодня нет'); return; }
      exportTodayXLSX(); exportTodayJSON();
      toast('Экспорт: готово');
    }));
  }

  if ($btnCloseShift) {
    $btnCloseShift.addEventListener('click', () => {
      const list = todaySessionsList();
      if (!list || list.length === 0) {
        if (confirm('Сессий за сегодня нет. Очистить список?')) {
          const key = todayKey();
          const result = clearSessionsForDay(key);
          renderSessions();
          if (result.keptActive) toast(`Очищено ${result.removed} сессий, активные (${result.keptActive}) сохранены`);
          else toast('Сессии за сегодня очищены');
        }
        return;
      }

      exportTodayXLSX(); exportTodayJSON();
      const ok = confirm('Отчёт сохранён (XLSX + JSON). Очистить сессии за сегодня?');
      if (ok) {
        const key = todayKey();
        const result = clearSessionsForDay(key);
        renderSessions();
        if (result.keptActive) toast(`Смена закрыта: завершенные сессии очищены, активные (${result.keptActive}) оставлены`);
        else toast('Смена закрыта: сессии за сегодня очищены');
      } else {
        toast('Смена закрыта: отчёт сохранён');
      }
    });
  }

  $btnStart.addEventListener('click', withButtonGuard($btnStart, 'start', () => applyTariff('set')));
  $btnExtend.addEventListener('click', withButtonGuard($btnExtend, 'extend', () => applyTariff('add')));
  $btnStop.addEventListener('click', withButtonGuard($btnStop, 'stop', () => stopStation(selectedStationId, 'manual')));
  $btnUndo.addEventListener('click', withButtonGuard($btnUndo, 'undo', () => undoLast(selectedStationId)));
  $btnRestoreLast?.addEventListener('click', withButtonGuard($btnRestoreLast, 'restore', () => restoreLastClosedSession(selectedStationId)));

  document.addEventListener('click', (e) => {
    const btn = e.target?.closest?.('[data-adjust]');
    if (!btn) return;
    const v = btn.getAttribute('data-adjust');
    const mins = parseInt(v, 10);
    if (!Number.isFinite(mins)) return;
    if (!canRunGuardedAction(`adjust_${mins}`)) return;
    adjustMinutes(selectedStationId, mins);
  });

  $btnToggleCustom.addEventListener('click', () => {
    $customRow.hidden = !$customRow.hidden;
  });
  $btnCustomSet.addEventListener('click', withButtonGuard($btnCustomSet, 'custom_set', () => applyCustom('set')));
  $btnCustomAdd.addEventListener('click', withButtonGuard($btnCustomAdd, 'custom_add', () => applyCustom('add')));
  $btnPaidAdd30?.addEventListener('click', withButtonGuard($btnPaidAdd30, 'paid30', () => addPaidMinutes(30)));
  $btnPaidAdd60?.addEventListener('click', withButtonGuard($btnPaidAdd60, 'paid60', () => addPaidMinutes(60)));


$btnJournal?.addEventListener('click', openJournal);
$btnCloseJournal?.addEventListener('click', closeJournal);
$journalModal?.addEventListener('click', (e) => {
  const toggle = e.target.closest('[data-journal-select-toggle]');
  if (toggle) {
    e.preventDefault();
    e.stopPropagation();
    toggleJournalSelect(toggle.dataset.journalSelectToggle || '');
    return;
  }
  const option = e.target.closest('[data-journal-select-menu] .cselect__option');
  if (option) {
    e.preventDefault();
    e.stopPropagation();
    const menu = option.closest('[data-journal-select-menu]');
    const kind = menu?.dataset.journalSelectMenu || '';
    if (kind) setJournalSelectValue(kind, option.dataset.value || 'all');
    return;
  }
  if (e.target.closest('[data-journal-select]')) return;
  if (e.target === $journalModal) closeJournal();
  else closeJournalSelects();
});
$btnClearJournal?.addEventListener('click', withButtonGuard($btnClearJournal, 'clear_journal', () => {
  if (!confirm('Очистить журнал действий?')) return;
  actionLog = [];
  saveActionLog();
  renderJournal();
  toast('Журнал очищен');
}));
$btnExportJournal?.addEventListener('click', withButtonGuard($btnExportJournal, 'export_journal', exportJournalTXT));
$btnResetJournalFilters?.addEventListener('click', withButtonGuard($btnResetJournalFilters, 'reset_journal_filters', resetJournalFilters));
$journalStationFilter?.addEventListener('change', updateJournalFilterInfo);
$journalLevelFilter?.addEventListener('change', updateJournalFilterInfo);
$journalSearch?.addEventListener('input', renderJournal);
[$journalStationFilter, $journalLevelFilter].forEach((el) => {
  el?.addEventListener('input', renderJournal);
  el?.addEventListener('change', renderJournal);
});
  $btnReports?.addEventListener('click', openReports);
  $btnCloseReports?.addEventListener('click', closeReports);
  $reportsModal?.addEventListener('click', (e) => {
    if (e.target === $reportsModal) closeReports();
  });
  [$reportDateFrom, $reportDateTo, $reportStationType, $reportPayment, $reportView].forEach((el) => {
    el?.addEventListener('input', renderReports);
    el?.addEventListener('change', renderReports);
  });
  $reportDateFromTrigger?.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleReportDatePicker('from');
  });
  $reportDateToTrigger?.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleReportDatePicker('to');
  });
  $reportDateFromText?.addEventListener('blur', () => commitReportDateText('from'));
  $reportDateToText?.addEventListener('blur', () => commitReportDateText('to'));
  $reportDateFromText?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    commitReportDateText('from');
  });
  $reportDateToText?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    commitReportDateText('to');
  });
  $reportPresetButtons.forEach((btn) => {
    btn.addEventListener('click', () => applyReportPreset(btn.dataset.reportPreset || 'today'));
  });
  $btnExportReports?.addEventListener('click', withButtonGuard($btnExportReports, 'export_reports', exportReportsXLSX));

  initCustomSelects();

  $btnSettings?.addEventListener('click', requestSettingsAccess);
  $btnCloseSettings?.addEventListener('click', closeSettings);
  $btnSaveSettings?.addEventListener('click', saveSettingsFromModal);
  $btnResetSettings?.addEventListener('click', resetSettings);
  $settingsNotificationSound?.addEventListener('change', () => {
    const enabled = !!$settingsNotificationSound.checked;
    if (settingsDraft) settingsDraft.notificationSound = enabled;
    settings.notificationSound = enabled;
    unlockNotificationAudio();
    if (enabled) setTimeout(() => playNotificationTone(true), 0);
  });
  $btnTestNotificationSound?.addEventListener('click', async () => {
    unlockNotificationAudio();
    if (!$settingsNotificationSound?.checked) {
      toast('Сначала включи звук уведомлений');
      return;
    }
    const ok = await playNotificationTone(true);
    if (!ok) toast('Браузер всё ещё блокирует звук. Кликни по странице и попробуй снова.');
  });
  $btnAddStation?.addEventListener('click', addStationDefinition);
  $btnAddTariff?.addEventListener('click', () => {
    addTariffRow(null, settingsEditorType);
    syncSettingsDirtyState();
  });
  $btnChangePin?.addEventListener('click', changeSettingsPin);
  $btnPinSubmit?.addEventListener('click', submitPinAccess);
  $btnPinCancel?.addEventListener('click', closePinModal);
  $btnClosePin?.addEventListener('click', closePinModal);
  $pinInput?.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitPinAccess(); });
  updateSubtitle();
  $settingsModal?.addEventListener('click', (e) => {
    if (e.target === $settingsModal) closeSettings();
  });
  $settingsModal?.addEventListener('input', (e) => {
    if (!settingsModalUnlocked || !$settingsModal.classList.contains('modal--open')) return;
    if (settingsRenderInProgress) return;
    if (e.target.closest('.settingsGrid')) syncSettingsDirtyState();
  });
  $settingsModal?.addEventListener('change', (e) => {
    if (!settingsModalUnlocked || !$settingsModal.classList.contains('modal--open')) return;
    if (settingsRenderInProgress) return;
    if (e.target.closest('.settingsGrid')) syncSettingsDirtyState();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeAllCustomSelects();
      closeReportDatePickers();
      if ($pinModal.classList.contains('modal--open')) closePinModal();
      if ($settingsModal.classList.contains('modal--open')) closeSettings();
      if ($sessionsModal.classList.contains('modal--open')) closeSessions();
      if ($journalModal.classList.contains('modal--open')) closeJournal();
      if ($reportsModal.classList.contains('modal--open')) closeReports();
    }
  });
  document.addEventListener('click', (e) => {
    if (e.target.closest('.reportDateField')) return;
    closeReportDatePickers();
  });
}


function initCustomSelects() {
  document.querySelectorAll('[data-cselect]').forEach((root) => {
    const input = root.querySelector('input[type="hidden"]');
    const toggle = root.querySelector('[data-cselect-toggle]');
    const label = root.querySelector('[data-cselect-label]');
    const menu = root.querySelector('[data-cselect-menu]');
    if (!input || !toggle || !label || !menu || root.dataset.bound === '1') return;
    root.dataset.bound = '1';

    const sync = () => {
      const active = menu.querySelector(`.cselect__option[data-value="${CSS.escape(input.value)}"]`) || menu.querySelector('.cselect__option');
      menu.querySelectorAll('.cselect__option').forEach((btn) => btn.classList.toggle('is-active', btn === active));
      if (active) label.textContent = active.textContent.trim();
    };

    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = !root.classList.contains('is-open');
      document.querySelectorAll('[data-cselect].is-open').forEach((other) => {
        if (other !== root) {
          other.classList.remove('is-open');
          other.querySelector('[data-cselect-toggle]')?.setAttribute('aria-expanded', 'false');
        }
      });
      root.classList.toggle('is-open', open);
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });

    menu.querySelectorAll('.cselect__option').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const nextValue = btn.dataset.value || '';
        if (input.value !== nextValue) {
          input.value = nextValue;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }
        sync();
        root.classList.remove('is-open');
        toggle.setAttribute('aria-expanded', 'false');
      });
    });

    sync();
  });

  if (!document.body.dataset.cselectBound) {
    document.body.dataset.cselectBound = '1';
    document.addEventListener('click', (e) => {
      if (e.target.closest('[data-cselect]')) return;
      document.querySelectorAll('[data-cselect].is-open').forEach((root) => {
        root.classList.remove('is-open');
        root.querySelector('[data-cselect-toggle]')?.setAttribute('aria-expanded', 'false');
      });
    });
  }
}

function closeAllCustomSelects() {
  document.querySelectorAll('[data-cselect].is-open').forEach((root) => {
    root.classList.remove('is-open');
    root.querySelector('[data-cselect-toggle]')?.setAttribute('aria-expanded', 'false');
  });
}

function updateSubtitle() {
  if (!$subtitle) return;
  const grace = Math.max(0, Math.round(settings.graceMinutes || 0));
  const overdue = Math.max(0, Math.round(settings.overdueMinutes || 0));
  const count = getStationDefinitions().length;
  $subtitle.textContent = `${count} станций • доигровка ${grace} мин • просрочка ${overdue} мин • локально в браузере`;
}


let notificationAudioCtx = null;
let notificationAudioUnlockBound = false;
let lastTimeJumpToastAt = 0;

function getNotificationAudioCtx() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  if (!notificationAudioCtx) notificationAudioCtx = new Ctx();
  return notificationAudioCtx;
}

function unlockNotificationAudio() {
  const ctx = getNotificationAudioCtx();
  if (!ctx) return;
  try {
    if (ctx.state === 'suspended') ctx.resume();
  } catch {}
}

function bindNotificationAudioUnlock() {
  if (notificationAudioUnlockBound) return;
  notificationAudioUnlockBound = true;
  const unlock = () => unlockNotificationAudio();
  window.addEventListener('pointerdown', unlock, { passive: true });
  window.addEventListener('keydown', unlock);
}

async function playNotificationTone(force = false) {
  if (!force && !settings?.notificationSound) return false;
  const ctx = getNotificationAudioCtx();
  if (!ctx) return false;
  try {
    if (ctx.state === 'suspended') await ctx.resume();
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.connect(gain);
    gain.connect(ctx.destination);

    gain.gain.setValueAtTime(0.0001, now);

    // First beep
    osc.frequency.setValueAtTime(880, now);
    gain.gain.exponentialRampToValueAtTime(0.08, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.22);

    // Second beep for better noticeability
    osc.frequency.setValueAtTime(987.77, now + 0.28);
    gain.gain.setValueAtTime(0.0001, now + 0.28);
    gain.gain.exponentialRampToValueAtTime(0.08, now + 0.30);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.54);

    osc.start(now);
    osc.stop(now + 0.58);
    return true;
  } catch {
    return false;
  }
}

function enqueueStationNotification(message) {
  toast(message, 2600);
  playNotificationTone();
}

function handleStationTransition(station, prevStatus, nextStatus) {
  if (!station || prevStatus === nextStatus) return;
  if (prevStatus === 'running' && nextStatus === 'grace') {
    enqueueStationNotification(`${station.name}: основное время закончилось, началась доигровка`);
    return;
  }
  if ((prevStatus === 'running' || prevStatus === 'grace') && nextStatus === 'overdue') {
    enqueueStationNotification(`${station.name}: доигровка закончилась, станция просрочена`);
  }
}

function startClock() {
  const update = () => {
    const d = new Date();
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    $nowClock.textContent = `${hh}:${mm}`;
  };
  update();
  setInterval(update, 1000);
}

function startAutoSave() {
  if (startAutoSave._timer) return;
  startAutoSave._timer = setInterval(() => {
    if (dirtySinceFlush) scheduleFlush(true);
    for (const station of stations) getRecoverySnapshot(station);
  }, AUTOSAVE_INTERVAL_MS);
}

function startTicking() {
  if (tickTimer) clearInterval(tickTimer);
  lastTickWallClock = Date.now();
  tickTimer = setInterval(() => {
    const now = Date.now();
    const delta = now - lastTickWallClock;
    if (Math.abs(delta - 250) > TIME_JUMP_WARN_MS) {
      const canShowJumpToast = !document.hidden && (now - lastTimeJumpToastAt > TIME_JUMP_TOAST_COOLDOWN_MS);
      if (canShowJumpToast) {
        lastTimeJumpToastAt = now;
        toast('Обнаружен скачок системного времени. Таймеры пересчитаны.', 3200);
      }
      saveStations(true);
      if ($sessionsModal.classList.contains('modal--open')) renderSessions();
    }
    lastTickWallClock = now;

    let changed = false;
    const autoStopIds = [];

    for (const s of stations) {
      if (s.status === 'idle' || !Number.isFinite(s.endTime)) continue;

      const prevStatus = s.status;
      const graceEnd = s.endTime + settings.graceMinutes * 60 * 1000;

      if (now < s.endTime) {
        if (s.status !== 'running') { s.status = 'running'; changed = true; }
      } else if (now >= s.endTime && now < graceEnd) {
        if (s.status !== 'grace') { s.status = 'grace'; changed = true; }
      } else if (now >= graceEnd) {
        if (s.status !== 'overdue') { s.status = 'overdue'; changed = true; }
        const autoEnd = s.endTime + ((settings.graceMinutes || 0) + (settings.overdueMinutes || 0)) * 60 * 1000;
        if (now >= autoEnd) autoStopIds.push(s.id);
      }

      if (prevStatus !== s.status) {
        handleStationTransition(s, prevStatus, s.status);
      }
    }

    if (autoStopIds.length) {
      for (const id of autoStopIds) stopStation(id, 'auto');
      changed = true;
    }

    if (changed) saveStations(true);

    renderStations(false);
    syncControl();
  }, 250);
}

function renderTariffs() {
  $tariffs.innerHTML = '';
  const stationType = getSelectedStationType();
  const list = getTariffs(stationType);
  for (const t of list) {
    const b = document.createElement('button');
    b.className = `tag${t.id === selectedTariffIds[stationType] ? ' tag--active' : ''}`;
    b.type = 'button';
    b.textContent = `${t.label} • ${money(t.price)}`;
    b.addEventListener('click', () => {
      selectedTariffIds[stationType] = t.id;
      renderTariffs();
      syncControl();
    });
    $tariffs.appendChild(b);
  }
}

function renderPaymentMethods() {
  if (!$paymentMethodButtons) return;
  $paymentMethodButtons.innerHTML = '';
  for (const item of PAYMENT_METHODS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `paychip${selectedPaymentMethod === item.id ? ' paychip--active' : ''}`;
    b.textContent = item.label;
    b.addEventListener('click', () => {
      selectedPaymentMethod = item.id;
      renderPaymentMethods();
      if (selectedStationId != null) {
        const station = stations.find((x) => x.id === selectedStationId);
        if (station && station.status !== 'idle') {
          setSessionPaymentMethod(station, selectedPaymentMethod);
          if ($sessionsModal.classList.contains('modal--open')) renderSessions();
        }
      }
      syncControl();
    });
    $paymentMethodButtons.appendChild(b);
  }
}

function renderStations(full = true) {
  const now = Date.now();
  let active = 0;
  if (full) $grid.innerHTML = '';

  for (const s of stations) {
    if (s.status !== 'idle') active++;

    const state = computeState(s, now);
    const timerLabel = state.timerLabel || 'Осталось';
    const remainingText = state.remainingText;
    const untilText = state.untilText;

    const tariffText = s.tariffId ? labelTariff(s.tariffId, getStationType(s)) : '—';

    const statusLabel =
      s.status === 'running' ? 'ЗАНЯТА' :
      s.status === 'grace' ? 'ДОИГРОВКА' :
      s.status === 'overdue' ? 'ПРОСРОЧЕНО' : 'СВОБОДНА';

    const pillClass =
      s.status === 'running' ? 'pill pill--run' :
      s.status === 'grace' ? 'pill pill--grace' :
      s.status === 'overdue' ? 'pill pill--overdue' : 'pill';

    const assets = assetsForStation(s);
    const imgSrc = s.status === 'idle' ? assets.idle : assets.active;

    if (!full) {
      const card = $grid.querySelector(`[data-station-id="${s.id}"]`);
      if (!card) continue;
      const stationType = getStationType(s);
      card.dataset.stationType = stationType;
      card.setAttribute('data-station-type', stationType);

      card.classList.toggle('card--running', s.status === 'running');
      card.classList.toggle('card--grace', s.status === 'grace');
      card.classList.toggle('card--overdue', s.status === 'overdue');
      card.classList.toggle('card--selected', selectedStationId === s.id);

      const pill = card.querySelector('.pill');
      if (pill) {
        pill.className = pillClass;
      }
      const pillText = card.querySelector("[data-role='pill']");
      if (pillText) pillText.textContent = statusLabel;

      const timerLabelEl = card.querySelector('.timerBox__label');
      if (timerLabelEl) timerLabelEl.textContent = timerLabel;

      const timer = card.querySelector("[data-role='timer']");
      if (timer) {
        timer.textContent = remainingText;
        timer.classList.toggle('timer--warn', state.tone === 'warn');
        timer.classList.toggle('timer--danger', state.tone === 'danger');
      }

      const until = card.querySelector("[data-role='until']");
      if (until) until.textContent = untilText;

      const tariff = card.querySelector("[data-role='tariff']");
      if (tariff) tariff.textContent = tariffText;

      const finance = card.querySelector("[data-role='finance']");
      const rec = getActiveSessionRecord(s);
      if (finance) finance.textContent = rec ? `Оплачено: ${money(rec.totalAmount || 0)} • ${paymentLabel(rec.paymentMethod || 'cash')}` : 'Оплачено: —';

      const img = card.querySelector("img[data-role='pad']");
      if (img) img.src = imgSrc;

      continue;
    }

    const card = document.createElement('article');
    card.className = `card${s.status === 'running' ? ' card--running' : ''}${s.status === 'grace' ? ' card--grace' : ''}${s.status === 'overdue' ? ' card--overdue' : ''}${selectedStationId === s.id ? ' card--selected' : ''}`;
    card.dataset.stationId = String(s.id);
    card.setAttribute('data-station-id', String(s.id));
    card.dataset.stationType = getStationType(s);
    card.setAttribute('data-station-type', getStationType(s));

    card.innerHTML = `
      <div class="card__top">
        <div>
          <div class="station__name" data-role="station-name" title="Двойной клик — переименовать">${escapeHtml(s.name)}</div>
          <div class="station__sub">Тариф: <span data-role="tariff">${escapeHtml(tariffText)}</span></div>
        </div>
        <div class="${pillClass}">
          <span class="pill__dot" aria-hidden="true"></span>
          <span class="pill__text" data-role="pill">${statusLabel}</span>
        </div>
      </div>

      <div class="card__body">
        <div class="timerBox">
          <div class="timerBox__label">${escapeHtml(timerLabel)}</div>
          <div class="timerBox__value" data-role="timer">${remainingText}</div>
          <div class="timerBox__sub">Окончание: <span data-role="until">${untilText}</span></div>
          <div class="timerBox__meta" data-role="finance"></div>
        </div>

        <div class="media">
          <img class="pad-img" data-role="pad" src="${imgSrc}" alt="Controller ${escapeHtml(s.name)}" />
          <div class="media__hint" data-role="img-hint">
            Нет PNG. Положите файлы в<br>
            <b>static/assets</b><br>
            <span data-role="img-hint-text"></span>
          </div>
        </div>
      </div>
    `;


    // rename station (double click on title)
    const nameEl = card.querySelector('[data-role="station-name"]');
    if (nameEl) {
      nameEl.addEventListener('dblclick', (ev) => {
        ev.stopPropagation();
        const current = (s.name || '').trim();
        const next = prompt('Название станции:', current);
        if (next == null) return;
        const clean = next.trim();
        if (!clean) return;
        s.name = normalizeStationName(clean);
        settings.stationDefinitions = getStationDefinitions().map((item) => item.id === s.id ? { ...item, name: s.name } : item);
        saveSettings(true);
        saveStations(true);
        renderStations(true);
        syncControl();
        toast(`Переименовано: ${s.name}`);
      });
    }

    // apply timer tone classes (warn <=10min, danger in grace/overdue)
    const timerEl = card.querySelector("[data-role='timer']");
    if (timerEl) {
      timerEl.classList.toggle('timer--warn', state.tone === 'warn');
      timerEl.classList.toggle('timer--danger', state.tone === 'danger');
    }

    const financeEl = card.querySelector('[data-role="finance"]');
    const rec = getActiveSessionRecord(s);
    if (financeEl) financeEl.textContent = rec ? `Оплачено: ${money(rec.totalAmount || 0)} • ${paymentLabel(rec.paymentMethod || 'cash')}` : 'Оплачено: —';

    const img = card.querySelector('img[data-role="pad"]');
    const hint = card.querySelector('[data-role="img-hint"]');
    if (img && hint) {
      const hintText = hint.querySelector('[data-role="img-hint-text"]');
      if (hintText) hintText.textContent = assets.hint;
      let triedFallback = false;
      img.addEventListener('error', () => {
        const fallbackSrc = s.status === 'idle' ? assets.fallbackIdle : assets.fallbackActive;
        if (!triedFallback && fallbackSrc) {
          triedFallback = true;
          img.src = fallbackSrc;
          return;
        }
        img.style.display = 'none';
        hint.style.display = 'block';
      });
    }

    card.addEventListener('click', () => {
      selectedStationId = s.id;
      saveStations(); // keep selection stable across reload? (lightweight)
      renderTariffs();
      renderStations(true);
      syncControl();
    });

    $grid.appendChild(card);
  }

  $activeCount.textContent = String(active);
}

function computeState(station, now) {
  if (station.status === 'idle' || !Number.isFinite(station.endTime)) {
    return { timerLabel: 'Осталось', remainingText: '00:00:00', untilText: '—', tone: 'normal' };
  }

  const end = station.endTime;
  const graceEnd = end + settings.graceMinutes * 60 * 1000;

  // Running
  if (now < end) {
    const remainingMs = end - now;
    const tone = (remainingMs <= 10 * 60 * 1000) ? 'warn' : 'normal';
    return { timerLabel: 'Осталось', remainingText: fmt(remainingMs), untilText: hhmm(end), tone };
  }

  // Grace countdown (доигровка): show remaining grace time
  if (now >= end && now < graceEnd) {
    return { timerLabel: 'Доигровка', remainingText: fmt(graceEnd - now), untilText: hhmm(end), tone: 'danger' };
  }

  // Overdue after grace: show time since grace ended
  return { timerLabel: 'Просрочено', remainingText: fmt(now - graceEnd), untilText: hhmm(end), tone: 'danger' };
}

function labelTariff(tariffId, stationType = null) {
  const t = getTariffById(tariffId, stationType);
  if (t) return t.label.split('•')[0].trim();
  if (tariffId?.startsWith('custom:')) return `Свои минуты (${tariffId.split(':')[1]} мин)`;
  return 'Тариф';
}

function getSelectedTariff() {
  const stationType = getSelectedStationType();
  return getTariffs(stationType).find((t) => t.id === selectedTariffIds[stationType]) ?? getTariffs(stationType)[0];
}

function getActiveSessionRecord(station) {
  if (!station || !station.activeSessionId) return null;
  const key = station.startTime ? todayKey(station.startTime) : todayKey();
  const list = sessions[key] || [];
  return list.find((x) => x.id === station.activeSessionId) || null;
}

function cloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function normalizeRecoverySnapshot(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const stationState = raw.stationState && typeof raw.stationState === 'object' ? raw.stationState : null;
  const sessionRecord = raw.sessionRecord && typeof raw.sessionRecord === 'object' ? raw.sessionRecord : null;
  const expiresAt = Number(raw.expiresAt);
  if (!stationState || !sessionRecord || !Number.isFinite(expiresAt)) return null;
  return {
    version: 1,
    storedAt: Number.isFinite(Number(raw.storedAt)) ? Number(raw.storedAt) : Date.now(),
    expiresAt,
    sessionDayKey: typeof raw.sessionDayKey === 'string' ? raw.sessionDayKey : todayKey(),
    stationState: {
      status: ['running', 'grace', 'overdue'].includes(stationState.status) ? stationState.status : 'running',
      startTime: Number.isFinite(stationState.startTime) ? stationState.startTime : null,
      endTime: Number.isFinite(stationState.endTime) ? stationState.endTime : null,
      tariffId: typeof stationState.tariffId === 'string' ? stationState.tariffId : null,
      activeSessionId: typeof stationState.activeSessionId === 'string' ? stationState.activeSessionId : null,
    },
    sessionRecord: cloneJson(sessionRecord),
  };
}

function getRecoverySnapshot(station) {
  const snap = normalizeRecoverySnapshot(station?.lastClosedSnapshot);
  if (!snap) return null;
  if (Date.now() > snap.expiresAt) {
    station.lastClosedSnapshot = null;
    saveStations(true);
    return null;
  }
  return snap;
}

function buildRecoverySnapshot(station) {
  const rec = getActiveSessionRecord(station);
  if (!rec || !station?.activeSessionId) return null;
  return {
    version: 1,
    storedAt: Date.now(),
    expiresAt: Date.now() + RECOVERY_WINDOW_MINUTES * 60 * 1000,
    sessionDayKey: station.startTime ? todayKey(station.startTime) : todayKey(),
    stationState: {
      status: station.status,
      startTime: station.startTime,
      endTime: station.endTime,
      tariffId: station.tariffId,
      activeSessionId: station.activeSessionId,
    },
    sessionRecord: cloneJson(rec),
  };
}

function clearRecoverySnapshot(station, persist = true) {
  if (!station) return;
  station.lastClosedSnapshot = null;
  if (persist) saveStations(true);
}

function validateRecoverySnapshotForRestore(station, snap) {
  if (!station || !snap) {
    return { ok: false, clearSnapshot: false, reason: 'Нет доступной сессии для восстановления.' };
  }
  const sessionId = snap.stationState.activeSessionId || snap.sessionRecord?.id;
  if (!sessionId) {
    return { ok: false, clearSnapshot: true, reason: `${station.name}: данные восстановления повреждены.` };
  }
  const snapshotStationId = Number(snap.sessionRecord?.stationId);
  if (Number.isFinite(snapshotStationId) && snapshotStationId !== station.id) {
    return { ok: false, clearSnapshot: true, reason: `${station.name}: восстановление относится к другой станции.` };
  }
  if (!Number.isFinite(snap.stationState.startTime) || !Number.isFinite(snap.stationState.endTime) || snap.stationState.endTime <= snap.stationState.startTime) {
    return { ok: false, clearSnapshot: true, reason: `${station.name}: данные времени в восстановлении повреждены.` };
  }
  const owner = stations.find((item) => item.id !== station.id && item.status !== 'idle' && item.activeSessionId === sessionId);
  if (owner) {
    return { ok: false, clearSnapshot: false, reason: `${station.name}: эта сессия уже занята станцией ${owner.name}.` };
  }
  return { ok: true, sessionId };
}

function confirmStartOverridesRecovery(station) {
  const recovery = getRecoverySnapshot(station);
  if (!recovery) return true;
  const ok = confirm(`${station.name}: у станции ещё доступно восстановление последней закрытой сессии до ${hhmm(recovery.expiresAt)}.\n\nНачать новую сессию и удалить возможность восстановления?`);
  if (!ok) return false;
  clearRecoverySnapshot(station, false);
  return true;
}

function buildManualStopPrompt(station) {
  if (!station) return 'Завершить активную сессию?';
  if (station.status === 'overdue') {
    return `${station.name}: станция уже в просрочке. Завершить эту сессию вручную?\n\nПосле завершения её можно будет восстановить в течение ${RECOVERY_WINDOW_MINUTES} минут, пока станция остаётся свободной.`;
  }
  if (station.status === 'grace') {
    return `${station.name}: станция сейчас в доигровке. Завершить сессию вручную?\n\nПосле завершения её можно будет восстановить в течение ${RECOVERY_WINDOW_MINUTES} минут, пока станция остаётся свободной.`;
  }
  return `${station.name}: завершить активную сессию?\n\nПосле завершения её можно будет восстановить в течение ${RECOVERY_WINDOW_MINUTES} минут, пока станция остаётся свободной.`;
}

function requestRestoreLastClosedSession(stationId) {
  if (stationId == null) return;
  const s = stations.find((x) => x.id === stationId);
  if (!s || s.status !== 'idle') return;
  const snap = getRecoverySnapshot(s);
  if (!snap) {
    toast('Нет доступной сессии для восстановления');
    return;
  }
  const validation = validateRecoverySnapshotForRestore(s, snap);
  if (!validation.ok) {
    if (validation.clearSnapshot) clearRecoverySnapshot(s);
    rejectAction(s, validation.reason);
    syncControl();
    return;
  }
  if (!confirm(`${s.name}: восстановить последнюю закрытую сессию?`)) return;

  const dayKey = snap.sessionDayKey || todayKey();
  if (!sessions[dayKey]) sessions[dayKey] = [];
  const list = sessions[dayKey];
  const sessionId = validation.sessionId;
  const idx = list.findIndex((item) => item && item.id === sessionId);
  const restoredRec = cloneJson(snap.sessionRecord);
  restoredRec.stationId = s.id;
  restoredRec.stationName = normalizeStationName(s.name);
  restoredRec.stationType = getStationType(s);
  restoredRec.tariffId = snap.stationState.tariffId;
  restoredRec.endTime = null;
  restoredRec.mode = 'started';
  if (!Array.isArray(restoredRec.sales)) restoredRec.sales = [];
  if (!Number.isFinite(Number(restoredRec.totalAmount))) restoredRec.totalAmount = 0;
  if (idx >= 0) list[idx] = restoredRec;
  else list.push(restoredRec);

  s.status = snap.stationState.status || 'running';
  s.startTime = snap.stationState.startTime;
  s.endTime = snap.stationState.endTime;
  s.tariffId = snap.stationState.tariffId;
  s.activeSessionId = sessionId;
  s.lastClosedSnapshot = null;

  saveSessions(true);
  saveStations(true);
  renderStations(true);
  syncControl();
  if ($sessionsModal.classList.contains('modal--open')) renderSessions();
  addActionLog('Восстановление', s, 'Последняя закрытая сессия восстановлена');
  toast(`${s.name}: сессия восстановлена`);
}

function requestStopStation(stationId) {
  if (stationId == null) return;
  const s = stations.find((x) => x.id === stationId);
  if (!s || s.status === 'idle') {
    rejectAction(s, `${s?.name || 'Станция'}: завершать нечего`);
    return;
  }
  if (!confirm(buildManualStopPrompt(s))) return;
  const recoverySnapshot = buildRecoverySnapshot(s);
  snapshot(s, 'Завершить');

  const now = Date.now();
  finalizeSession(s, now, 'manual');

  s.status = 'idle';
  s.startTime = null;
  s.endTime = null;
  s.tariffId = null;
  s.activeSessionId = null;
  s.lastClosedSnapshot = recoverySnapshot;

  saveStations(true);
  renderStations(true);
  syncControl();
  if ($sessionsModal.classList.contains('modal--open')) renderSessions();
  addActionLog('Ручное завершение', s, 'Сессия завершена администратором', 'info');
  toast(`${s.name}: завершено`);
}

function restoreLastClosedSession(stationId) {
  if (stationId == null) return;
  const s = stations.find((x) => x.id === stationId);
  if (!s || s.status !== 'idle') return;
  const snap = getRecoverySnapshot(s);
  if (!snap) {
    toast('Нет доступной сессии для восстановления');
    return;
  }
  if (!confirm(`${s.name}: восстановить последнюю закрытую сессию?`)) return;

  const dayKey = snap.sessionDayKey || todayKey();
  if (!sessions[dayKey]) sessions[dayKey] = [];
  const list = sessions[dayKey];
  const sessionId = snap.stationState.activeSessionId || snap.sessionRecord.id;
  const idx = list.findIndex((item) => item && item.id === sessionId);
  const restoredRec = cloneJson(snap.sessionRecord);
  restoredRec.endTime = null;
  restoredRec.mode = 'started';
  if (idx >= 0) list[idx] = restoredRec;
  else list.push(restoredRec);

  s.status = snap.stationState.status || 'running';
  s.startTime = snap.stationState.startTime;
  s.endTime = snap.stationState.endTime;
  s.tariffId = snap.stationState.tariffId;
  s.activeSessionId = sessionId;
  s.lastClosedSnapshot = null;

  saveSessions(true);
  saveStations(true);
  renderStations(true);
  syncControl();
  if ($sessionsModal.classList.contains('modal--open')) renderSessions();
  addActionLog('Восстановление', s, 'Последняя закрытая сессия восстановлена');
  toast(`${s.name}: сессия восстановлена`);
}

/* CONTROL */
function syncControl() {
  if (selectedStationId == null) {
    if ($control) {
      $control.classList.add('control--awaiting-selection');
    }
    $ctlTitle.textContent = 'Выберите станцию';
    $ctlPill.textContent = '—';
    if ($ctlMetaMain) $ctlMetaMain.textContent = 'Клик по карточке сверху — выбрать станцию для управления.';
    if ($ctlMetaSub) $ctlMetaSub.textContent = 'После выбора откроются тарифы, оплата и служебные действия.';
    $btnStart.disabled = true;
    $btnExtend.disabled = true;
    $btnStop.disabled = true;
    if ($btnPaidAdd30) $btnPaidAdd30.disabled = true;
    if ($btnPaidAdd60) $btnPaidAdd60.disabled = true;
    $btnUndo.disabled = true;
    if ($btnRestoreLast) $btnRestoreLast.disabled = true;
    $undoNote.textContent = '—';
    const stationType = getSelectedStationType();
    const selectedTariffId = selectedTariffIds[stationType];
    if ($ctlMetaStatusLabel) $ctlMetaStatusLabel.textContent = 'Тариф';
    if ($ctlMetaStatus) $ctlMetaStatus.textContent = selectedTariffId ? tariffPriceLabel(selectedTariffId, stationType) : '—';
    if ($ctlMetaUntilLabel) $ctlMetaUntilLabel.textContent = 'Оплата';
    if ($ctlMetaUntil) $ctlMetaUntil.textContent = paymentLabel(selectedPaymentMethod);
    if ($selectedTariffPrice) $selectedTariffPrice.textContent = selectedTariffIds[stationType] ? `Цена тарифа: ${tariffPriceLabel(selectedTariffIds[stationType], stationType)}` : 'Цена тарифа: —';
    renderPaymentMethods();
    return;
  }

  const s = stations.find(x => x.id === selectedStationId);
  if (!s) {
    selectedStationId = null;
    syncControl();
    return;
  }

  if ($control) {
    $control.classList.remove('control--awaiting-selection');
  }

  const statusText =
    s.status === 'running' ? 'ЗАНЯТА' :
    s.status === 'grace' ? 'ДОИГРОВКА' :
    s.status === 'overdue' ? 'ПРОСРОЧЕНО' : 'СВОБОДНА';

  $ctlTitle.textContent = `${s.name} — управление`;
  $ctlPill.textContent = statusText;

  const state = computeState(s, Date.now());
  const tariffText = s.tariffId ? labelTariff(s.tariffId) : '—';
  const activeRecord = getActiveSessionRecord(s);
  const amountText = activeRecord ? money(activeRecord.totalAmount || 0) : '—';
  const methodText = activeRecord ? paymentLabel(activeRecord.paymentMethod) : paymentLabel(selectedPaymentMethod);

  if ($ctlMetaMain) $ctlMetaMain.textContent = `Тариф: ${tariffText}`;
  if ($ctlMetaSub) $ctlMetaSub.textContent = `Сумма: ${amountText} • Оплата: ${methodText}`;
  if ($ctlMetaStatusLabel) $ctlMetaStatusLabel.textContent = state.timerLabel || 'Осталось';
  if ($ctlMetaStatus) $ctlMetaStatus.textContent = state.remainingText;
  if ($ctlMetaUntilLabel) $ctlMetaUntilLabel.textContent = 'Окончание';
  if ($ctlMetaUntil) $ctlMetaUntil.textContent = state.untilText;
  const stationType = getStationType(s);
  if ($selectedTariffPrice) {
    $selectedTariffPrice.textContent = selectedTariffIds[stationType] ? `Цена тарифа: ${tariffPriceLabel(selectedTariffIds[stationType], stationType)}` : 'Цена тарифа: —';
  }
  selectedPaymentMethod = activeRecord?.paymentMethod || selectedPaymentMethod;
  renderPaymentMethods();

  $btnStart.disabled = s.status !== 'idle';
  $btnExtend.disabled = s.status === 'idle';
  $btnStop.disabled = s.status === 'idle';
  if ($btnPaidAdd30) $btnPaidAdd30.disabled = s.status === 'idle';
  if ($btnPaidAdd60) $btnPaidAdd60.disabled = s.status === 'idle';

  const last = s.history?.[s.history.length - 1];
  const recovery = getRecoverySnapshot(s);
  if ($btnRestoreLast) $btnRestoreLast.disabled = !(s.status === 'idle' && recovery);
  if (recovery && s.status === 'idle') {
    $undoNote.textContent = `Можно восстановить до ${hhmm(recovery.expiresAt)}`;
    $btnUndo.disabled = !(s.history?.length);
  } else if (last) {
    $undoNote.textContent = `Последнее: ${last.label}`;
    $btnUndo.disabled = false;
  } else {
    $undoNote.textContent = 'История пуста';
    $btnUndo.disabled = true;
  }
  if ($reportsModal?.classList.contains('modal--open')) renderReports();
}

/* ACTIONS */
function snapshot(station, label) {
  const snap = {
    label,
    status: station.status,
    startTime: station.startTime,
    endTime: station.endTime,
    tariffId: station.tariffId,
    extraMinutes: 0,
    activeSessionId: station.activeSessionId,
  };
  station.history = Array.isArray(station.history) ? station.history : [];
  station.history.push(snap);
  if (station.history.length > 12) station.history.shift();
}

function undoLast(stationId) {
  const s = stations.find(x => x.id === stationId);
  if (!s || !Array.isArray(s.history) || s.history.length === 0) { rejectAction(s, `${s?.name || 'Станция'}: нечего отменять`); return; }

  const last = s.history.pop();
  s.status = last.status;
  s.startTime = last.startTime;
  s.endTime = last.endTime;
  s.tariffId = last.tariffId;
  s.activeSessionId = last.activeSessionId;

  saveStations(true);
  renderStations(true);
  syncControl();
  addActionLog('Отмена', s, 'Последнее изменение отменено');
  toast(`${s.name}: отменено`);
}

function applyTariff(mode) {
  if (selectedStationId == null) return;
  const s = stations.find(x => x.id === selectedStationId);
  if (!s) return;

  const t = getSelectedTariff();
  if (!t) { rejectAction(s, `${s.name}: для этого типа станции не настроены тарифы`); return; }
  const mins = t.minutes;
  const amount = t.price;

  if (mode === 'set' && s.status !== 'idle') { rejectAction(s, `${s.name}: станция уже занята`); return; }
  if (mode === 'add' && s.status === 'idle') { rejectAction(s, `${s.name}: нельзя продлить незапущенную станцию`); return; }

  const now = Date.now();

  if (mode === 'set') {
    snapshot(s, `Старт: ${t.label}`);
    s.tariffId = t.id;
    s.status = 'running';
    s.startTime = now;
    s.endTime = now + mins * 60 * 1000;
    s.activeSessionId = addSessionRecord(s, s.startTime, { tariffLabel: t.label, paymentMethod: selectedPaymentMethod });
    s.lastClosedSnapshot = null;
    recordSale(s, { type: 'start_tariff', label: `Старт: ${t.label}`, minutes: mins, amount, paymentMethod: selectedPaymentMethod });

    saveStations(true);
    renderStations(true);
    syncControl();
    if ($sessionsModal.classList.contains('modal--open')) renderSessions();
    addActionLog('Старт', s, `${t.label} • ${money(amount)} • ${paymentLabel(selectedPaymentMethod)}`);
    toast(`${s.name}: старт (${t.label})`);
    return;
  }

  snapshot(s, `Продлить: ${t.label}`);
  bumpSessionExtension(s, mins);
  recordSale(s, { type: 'extend_tariff', label: `Продление: ${t.label}`, minutes: mins, amount, paymentMethod: selectedPaymentMethod });
  s.endTime = Number.isFinite(s.endTime) ? s.endTime + mins * 60 * 1000 : now + mins * 60 * 1000;
  s.status = 'running';

  saveStations(true);
  renderStations(true);
  syncControl();
  if ($sessionsModal.classList.contains('modal--open')) renderSessions();
  addActionLog('Продление по тарифу', s, `${t.label} • ${money(amount)} • ${paymentLabel(selectedPaymentMethod)}`);
  toast(`${s.name}: продлено (${t.label})`);
}

function applyCustom(mode) {
  const mins = parseInt($customMinutes.value, 10);
  if (!Number.isFinite(mins) || mins < 10) { rejectAction(null, 'Минуты: минимум 10'); return; }
  if (selectedStationId == null) return;
  const s = stations.find(x => x.id === selectedStationId);
  if (!s) return;

  const now = Date.now();
  const amount = priceForMinutes(mins, getStationType(s));

  if (mode === 'set') {
    if (s.status !== 'idle') { rejectAction(s, `${s.name}: станция уже занята`); return; }
    snapshot(s, `Старт: ${mins} мин`);
    s.tariffId = `custom:${mins}`;
    s.status = 'running';
    s.startTime = now;
    s.endTime = now + mins * 60 * 1000;
    s.activeSessionId = addSessionRecord(s, s.startTime, { tariffLabel: `Свои минуты (${mins} мин)`, paymentMethod: selectedPaymentMethod });
    s.lastClosedSnapshot = null;
    recordSale(s, { type: 'start_custom', label: `Старт: ${mins} мин`, minutes: mins, amount, paymentMethod: selectedPaymentMethod });

    saveStations(true);
    renderStations(true);
    syncControl();
    if ($sessionsModal.classList.contains('modal--open')) renderSessions();
    addActionLog('Старт (свои минуты)', s, `${mins} мин • ${money(amount)} • ${paymentLabel(selectedPaymentMethod)}`);
    toast(`${s.name}: старт (${mins} мин)`);
    return;
  }

  if (s.status === 'idle') { rejectAction(s, `${s.name}: нельзя продлить незапущенную станцию`); return; }

  snapshot(s, `Платно: +${mins} мин`);
  bumpSessionExtension(s, mins);
  recordSale(s, { type: 'extend_custom', label: `Платно: +${mins} мин`, minutes: mins, amount, paymentMethod: selectedPaymentMethod });
  s.endTime = Number.isFinite(s.endTime) ? s.endTime + mins * 60 * 1000 : now + mins * 60 * 1000;
  s.status = 'running';

  saveStations(true);
  renderStations(true);
  syncControl();
  if ($sessionsModal.classList.contains('modal--open')) renderSessions();
  addActionLog('Платное продление', s, `+${mins} мин • ${money(amount)} • ${paymentLabel(selectedPaymentMethod)}`);
  toast(`${s.name}: куплено +${mins} мин`);
}

function addPaidMinutes(minutes) {
  if (selectedStationId == null) return;
  const s = stations.find((x) => x.id === selectedStationId);
  if (!s || s.status === 'idle') { rejectAction(s, `${s?.name || 'Станция'}: завершать нечего`); return; }
  const mins = Math.round(Number(minutes) || 0);
  if (mins <= 0) { rejectAction(s, `${s.name}: количество минут должно быть больше нуля`); return; }
  const amount = priceForMinutes(mins, getStationType(s));
  snapshot(s, `Платно: +${mins} мин`);
  bumpSessionExtension(s, mins);
  recordSale(s, { type: 'extend_paid_minutes', label: `Платно: +${mins} мин`, minutes: mins, amount, paymentMethod: selectedPaymentMethod });
  s.endTime = Number.isFinite(s.endTime) ? s.endTime + mins * 60 * 1000 : Date.now() + mins * 60 * 1000;
  s.status = 'running';
  saveStations(true);
  renderStations(true);
  syncControl();
  if ($sessionsModal.classList.contains('modal--open')) renderSessions();
  addActionLog('Платное продление', s, `+${mins} мин • ${money(amount)} • ${paymentLabel(selectedPaymentMethod)}`);
  toast(`${s.name}: куплено +${mins} мин`);
}

function adjustMinutes(stationId, deltaMins) {
  if (stationId == null) return;
  const s = stations.find(x => x.id === stationId);
  if (!s || s.status === 'idle' || !Number.isFinite(s.endTime)) { rejectAction(s, `${s?.name || 'Станция'}: корректировка недоступна`); return; }

  snapshot(s, `Корректировка: ${deltaMins > 0 ? '+' : ''}${deltaMins} мин`);
  bumpSessionExtension(s, deltaMins);

  const now = Date.now();
  const deltaMs = deltaMins * 60 * 1000;
  const newEnd = s.endTime + deltaMs;
  const minEnd = now + 60 * 1000;
  s.endTime = Math.max(minEnd, newEnd);
  s.status = 'running';

  saveStations(true);
  renderStations(true);
  syncControl();
  addActionLog('Служебная корректировка', s, `${deltaMins > 0 ? '+' : ''}${deltaMins} мин`);
  toast(`${s.name}: ${deltaMins > 0 ? '+' : ''}${deltaMins} мин`);
}

function stopStation(stationId, mode) {
  if (stationId == null) return;
  const s = stations.find(x => x.id === stationId);
  if (!s || s.status === 'idle') { rejectAction(s, `${s?.name || 'Станция'}: завершать нечего`); return; }

  if (mode === 'manual' && s.status !== 'overdue') {
    const recovery = getRecoverySnapshot(s);
    const promptText = `${s.name}: завершить активную сессию?\n\nПосле завершения её можно будет восстановить в течение ${RECOVERY_WINDOW_MINUTES} минут, если станция останется свободной.`;
    if (!confirm(promptText)) return;
  }

  const recoverySnapshot = buildRecoverySnapshot(s);
  snapshot(s, 'Завершить');

  const now = Date.now();
  finalizeSession(s, now, mode);

  s.status = 'idle';
  s.startTime = null;
  s.endTime = null;
  s.tariffId = null;
  s.activeSessionId = null;
  s.lastClosedSnapshot = recoverySnapshot;

  saveStations(true);
  renderStations(true);
  syncControl();
  if ($sessionsModal.classList.contains('modal--open')) renderSessions();
  addActionLog(mode === 'auto' ? 'Автозавершение' : 'Ручное завершение', s, mode === 'auto' ? 'Сессия завершена после просрочки' : 'Сессия завершена администратором', mode === 'auto' ? 'warn' : 'info');
  toast(mode === 'auto' ? `${s.name}: автоматически завершено после просрочки` : `${s.name}: завершено`);
}


/* EXPORT */
function csvEscape(v) {
  const s = String(v ?? '');
  if (/[;"\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}


function downloadBlob(filename, blob) {
  const a = document.createElement('a');
  const url = URL.createObjectURL(blob);
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function downloadText(filename, text, mime) {
  const blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function todaySessionsList() {
  const key = todayKey();
  return sessions[key] || [];
}

function getActiveSessionIdsForDay(dayKey) {
  const ids = new Set();
  for (const station of stations) {
    if (!station || station.status === 'idle' || !station.activeSessionId || !station.startTime) continue;
    if (todayKey(station.startTime) !== dayKey) continue;
    ids.add(station.activeSessionId);
  }
  return ids;
}

function clearSessionsForDay(dayKey) {
  const list = Array.isArray(sessions[dayKey]) ? sessions[dayKey] : [];
  const activeIds = getActiveSessionIdsForDay(dayKey);
  if (!activeIds.size) {
    sessions[dayKey] = [];
    saveSessions(true);
    syncAchievementsState({ silent: true });
    return { removed: list.length, keptActive: 0 };
  }

  const next = list.filter((rec) => activeIds.has(rec?.id));
  sessions[dayKey] = next;
  saveSessions(true);
  syncAchievementsState({ silent: true });
  return { removed: Math.max(0, list.length - next.length), keptActive: next.length };
}

function getAttachmentFilename(response, fallback) {
  const cd = response.headers.get('Content-Disposition') || response.headers.get('content-disposition') || '';
  const utf8 = cd.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8 && utf8[1]) {
    try { return decodeURIComponent(utf8[1]); } catch (_) {}
  }
  const plain = cd.match(/filename="?([^";]+)"?/i);
  if (plain && plain[1]) return plain[1];
  return fallback;
}

function exportTodayXLSX() {
  const key = todayKey();
  const fallback = `PS_Lounge_Report_${formatDateRU(key).replaceAll('.', '-')}.xlsx`;
  const url = `/api/export/today.xlsx?date=${encodeURIComponent(key)}`;
  fetch(url)
    .then(r => {
      if (!r.ok) throw new Error('export failed');
      const filename = getAttachmentFilename(r, fallback);
      return r.blob().then(blob => ({ blob, filename }));
    })
    .then(({ blob, filename }) => downloadBlob(filename, blob))
    .catch(() => toast('Не удалось экспортировать XLSX'));
}

function exportReportsXLSX() {
  const filters = getReportFilters();
  const from = filters.from || todayKey();
  const to = filters.to || from;
  const stationType = filters.stationType || 'all';
  const payment = filters.payment || 'all';
  const qs = new URLSearchParams({ from, to });
  if (stationType && stationType !== 'all') qs.set('stationType', stationType);
  if (payment && payment !== 'all') qs.set('payment', payment);
  const suffixParts = [];
  if (stationType && stationType !== 'all') suffixParts.push(stationType);
  if (payment && payment !== 'all') suffixParts.push(payment);
  if (filters.view && filters.view !== 'sessions') suffixParts.push(filters.view);
  const suffix = suffixParts.length ? `_${suffixParts.join('_')}` : '';
  const fallback = from === to
    ? `PS_Lounge_Report_${formatDateRU(from).replaceAll('.', '-')}${suffix}.xlsx`
    : `PS_Lounge_Report_${formatDateRU(from).replaceAll('.', '-')}_${formatDateRU(to).replaceAll('.', '-')}${suffix}.xlsx`;
  fetch(`/api/export/report.xlsx?${qs.toString()}`)
    .then(r => {
      if (!r.ok) throw new Error('export failed');
      const filename = getAttachmentFilename(r, fallback);
      return r.blob().then(blob => ({ blob, filename }));
    })
    .then(({ blob, filename }) => downloadBlob(filename, blob))
    .catch(() => toast('Не удалось экспортировать отчёт XLSX'));
}

function exportTodayJSON() {
  const list = todaySessionsList();
  const key = todayKey();
  downloadText(`PS_Lounge_${key}_sessions.json`, JSON.stringify(list, null, 2), 'application/json;charset=utf-8');
}

function exportTodayBoth() {
  exportTodayCSV();
  exportTodayJSON();
}

/* SESSIONS */
function openSessions() {
  $sessionsModal.classList.add('modal--open');
  $sessionsModal.setAttribute('aria-hidden', 'false');
  renderSessions();
}

function closeSessions() {
  $sessionsModal.classList.remove('modal--open');
  $sessionsModal.setAttribute('aria-hidden', 'true');
}

function renderSessions() {
  const key = todayKey();
  const list = sessions[key] || [];
  const closedList = list.filter((r) => r && r.endTime);
  const totalRevenue = salesTotal(list);
  const avgCheck = list.length ? Math.round(totalRevenue / list.length) : 0;
  const paymentTotals = paymentTotalsFromSessions(list);
  const paymentSummary = PAYMENT_METHODS
    .map((method) => paymentTotals[method.id] > 0 ? `${method.label}: ${money(paymentTotals[method.id])}` : null)
    .filter(Boolean)
    .join(' • ');

  $sessionsSub.textContent = `${formatDateRU(key)} • сессий: ${list.length}`;
  if ($summaryRevenue) $summaryRevenue.textContent = money(totalRevenue);
  if ($summarySessions) $summarySessions.textContent = String(closedList.length);
  if ($summaryAvgCheck) $summaryAvgCheck.textContent = list.length ? money(avgCheck) : '—';
  if ($summaryPaid) $summaryPaid.textContent = paymentSummary || '—';

  if (list.length === 0) {
    $sessionsList.innerHTML = `<div class="sessionRow"><div class="sessionRow__left"><div class="sessionRow__title">Пусто</div><div class="sessionRow__meta">Сегодня сессий ещё нет.</div></div></div>`;
    return;
  }

  const items = [...list].sort((a,b) => (b.startTime || 0) - (a.startTime || 0));
  $sessionsList.innerHTML = '';

  for (const r of items) {
    const start = r.startTime ? hhmm(r.startTime) : '—';
    const end = r.endTime ? hhmm(r.endTime) : '—';
    const durMin = (r.startTime && r.endTime) ? Math.max(0, Math.round((r.endTime - r.startTime)/60000)) : null;
    const tariffLabel = r.tariffLabel || (r.tariffId ? labelTariff(r.tariffId) : '—');
    const modeLabel = r.endTime ? (r.mode === 'auto' ? 'авто' : 'вручную') : 'идёт';
    const amountText = money(r.totalAmount || 0);
    const payLabel = paymentLabel(r.paymentMethod || 'cash');
    const salesCount = Array.isArray(r.sales) ? r.sales.length : 0;

    const row = document.createElement('div');
    row.className = 'sessionRow';
    row.innerHTML = `
      <div class="sessionRow__left">
        <div class="sessionRow__title">${escapeHtml(r.stationName || `PS${r.stationId}`)}</div>
        <div class="sessionRow__meta">Тариф: ${escapeHtml(tariffLabel)}<br>Время: ${start} → ${end}<br>Оплата: ${escapeHtml(payLabel)}<br>Продаж: ${salesCount}</div>
      </div>
      <div class="sessionRow__right">
        ${durMin != null ? `<div><b>${durMin} мин</b></div>` : '<div><b>Активна</b></div>'}
        <div><b>${escapeHtml(amountText)}</b></div>
        <div>${escapeHtml(modeLabel)}</div>
      </div>
    `;
    $sessionsList.appendChild(row);
  }
}


function toDateInputValue(ts = Date.now()) {
  return todayKey(ts);
}

function stationTypeFromRecord(rec) {
  if (rec?.stationType && STATION_TYPES[rec.stationType]) return rec.stationType;
  return getStationType(rec?.stationId || 1);
}

function allSessionRecords() {
  const out = [];
  for (const [key, list] of Object.entries(sessions || {})) {
    if (!Array.isArray(list)) continue;
    for (const rec of list) {
      if (!rec || typeof rec !== 'object') continue;
      out.push({ ...rec, dateKey: key, stationType: stationTypeFromRecord(rec) });
    }
  }
  return out.sort((a, b) => (b.startTime || 0) - (a.startTime || 0));
}

function sessionMatchesPayment(rec, paymentFilter) {
  if (!paymentFilter || paymentFilter === 'all') return true;
  const sales = Array.isArray(rec?.sales) ? rec.sales : [];
  if (sales.length) return sales.some((sale) => (sale?.paymentMethod || 'cash') === paymentFilter);
  return (rec?.paymentMethod || 'cash') === paymentFilter;
}

function getReportFilters() {
  return {
    from: $reportDateFrom?.value || todayKey(),
    to: $reportDateTo?.value || ($reportDateFrom?.value || todayKey()),
    stationType: $reportStationType?.value || 'all',
    payment: $reportPayment?.value || 'all',
    view: $reportView?.value || 'sessions',
  };
}

function shiftDateKey(dateKey, deltaDays) {
  const base = new Date(`${dateKey}T00:00:00`);
  base.setDate(base.getDate() + deltaDays);
  return todayKey(base.getTime());
}

function monthKey(dateKey) {
  const safe = String(dateKey || todayKey());
  return safe.slice(0, 7);
}

function startOfMonthKey(dateKey) {
  const base = new Date(`${dateKey}T00:00:00`);
  base.setDate(1);
  return todayKey(base.getTime());
}

function shiftMonthKey(key, deltaMonths) {
  const [year, month] = String(key || monthKey(todayKey())).split('-').map(Number);
  const base = new Date(year, (month || 1) - 1, 1);
  base.setMonth(base.getMonth() + deltaMonths);
  return `${base.getFullYear()}-${String(base.getMonth() + 1).padStart(2, '0')}`;
}

function formatMonthRU(key) {
  const [year, month] = String(key || monthKey(todayKey())).split('-').map(Number);
  const base = new Date(year, (month || 1) - 1, 1);
  const label = new Intl.DateTimeFormat('ru-RU', { month: 'long', year: 'numeric' }).format(base);
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function formatDateInputRU(value) {
  const key = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return '';
  const [year, month, day] = key.split('-');
  return `${day}.${month}.${year}`;
}

function parseDateInputRU(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const normalized = raw.replace(/\s+/g, '');
  const match = normalized.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (!match) return '';
  const [, day, month, year] = match;
  const key = `${year}-${month}-${day}`;
  const date = new Date(`${key}T00:00:00`);
  if (Number.isNaN(date.getTime())) return '';
  if (todayKey(date.getTime()) !== key) return '';
  return key;
}

function syncReportDateLabels() {
  if ($reportDateFromLabel) $reportDateFromLabel.textContent = formatDateRU($reportDateFrom?.value || todayKey());
  if ($reportDateToLabel) $reportDateToLabel.textContent = formatDateRU($reportDateTo?.value || ($reportDateFrom?.value || todayKey()));
  if ($reportDateFromText) $reportDateFromText.value = formatDateInputRU($reportDateFrom?.value || todayKey());
  if ($reportDateToText) $reportDateToText.value = formatDateInputRU($reportDateTo?.value || ($reportDateFrom?.value || todayKey()));
}

function getReportDatePickerParts(kind) {
  if (kind === 'from') {
    return {
      input: $reportDateFrom,
      trigger: $reportDateFromTrigger,
      picker: $reportDateFromPicker,
      peer: $reportDateTo,
      label: $reportDateFromLabel,
    };
  }
  return {
    input: $reportDateTo,
    trigger: $reportDateToTrigger,
    picker: $reportDateToPicker,
    peer: $reportDateFrom,
    label: $reportDateToLabel,
  };
}

function closeReportDatePickers() {
  reportDatePickerOpen = '';
  [
    [$reportDateFromTrigger, $reportDateFromPicker],
    [$reportDateToTrigger, $reportDateToPicker],
  ].forEach(([trigger, picker]) => {
    trigger?.setAttribute('aria-expanded', 'false');
    picker?.setAttribute('hidden', '');
  });
}

function renderReportDatePicker(kind) {
  const parts = getReportDatePickerParts(kind);
  if (!parts.input || !parts.picker) return;
  const selected = parts.input.value || todayKey();
  const month = reportDatePickerMonth[kind] || monthKey(selected);
  reportDatePickerMonth[kind] = month;
  const monthStart = new Date(`${month}-01T00:00:00`);
  const daysInMonth = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 0).getDate();
  const startOffset = (monthStart.getDay() + 6) % 7;
  const cells = [];
  for (let i = 0; i < startOffset; i += 1) {
    cells.push('<span class="reportDatePicker__day reportDatePicker__day--empty"></span>');
  }
  for (let day = 1; day <= daysInMonth; day += 1) {
    const date = new Date(monthStart.getFullYear(), monthStart.getMonth(), day);
    const key = todayKey(date.getTime());
    const classes = ['reportDatePicker__day'];
    if (key === selected) classes.push('is-selected');
    if (key === todayKey()) classes.push('is-today');
    cells.push(`<button class="${classes.join(' ')}" type="button" data-report-date="${key}" data-report-kind="${kind}">${day}</button>`);
  }
  parts.picker.innerHTML = `
    <div class="reportDatePicker__head">
      <button class="reportDatePicker__nav" type="button" data-report-month-nav="${kind}:-1">‹</button>
      <div class="reportDatePicker__title">${escapeHtml(formatMonthRU(month))}</div>
      <button class="reportDatePicker__nav" type="button" data-report-month-nav="${kind}:1">›</button>
    </div>
    <div class="reportDatePicker__weekdays">
      <span>Пн</span><span>Вт</span><span>Ср</span><span>Чт</span><span>Пт</span><span>Сб</span><span>Вс</span>
    </div>
    <div class="reportDatePicker__grid">${cells.join('')}</div>
    <div class="reportDatePicker__foot">
      <button class="reportDatePicker__action" type="button" data-report-today="${kind}">Сегодня</button>
      <button class="reportDatePicker__action" type="button" data-report-close="${kind}">Закрыть</button>
    </div>
  `;
  parts.picker.querySelectorAll('[data-report-date]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      setReportDateValue(kind, btn.dataset.reportDate || todayKey());
    });
  });
  parts.picker.querySelectorAll('[data-report-month-nav]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const [, delta] = String(btn.dataset.reportMonthNav || '').split(':');
      reportDatePickerMonth[kind] = shiftMonthKey(month, Number(delta) || 0);
      renderReportDatePicker(kind);
    });
  });
  parts.picker.querySelector(`[data-report-today="${kind}"]`)?.addEventListener('click', () => {
    setReportDateValue(kind, todayKey());
  });
  parts.picker.querySelector(`[data-report-today="${kind}"]`)?.addEventListener('click', (e) => e.stopPropagation());
  parts.picker.querySelector(`[data-report-close="${kind}"]`)?.addEventListener('click', (e) => {
    e.stopPropagation();
    closeReportDatePickers();
  });
}

function toggleReportDatePicker(kind) {
  const parts = getReportDatePickerParts(kind);
  if (!parts.picker || !parts.trigger || !parts.input) return;
  const isOpen = reportDatePickerOpen === kind && !parts.picker.hasAttribute('hidden');
  closeAllCustomSelects();
  closeReportDatePickers();
  if (isOpen) return;
  reportDatePickerMonth[kind] = monthKey(parts.input.value || todayKey());
  renderReportDatePicker(kind);
  reportDatePickerOpen = kind;
  parts.trigger.setAttribute('aria-expanded', 'true');
  parts.picker.removeAttribute('hidden');
}

function setReportDateValue(kind, value) {
  const parts = getReportDatePickerParts(kind);
  if (!parts.input) return;
  parts.input.value = value;
  if (kind === 'from' && $reportDateTo && $reportDateTo.value && value > $reportDateTo.value) {
    $reportDateTo.value = value;
  }
  if (kind === 'to' && $reportDateFrom && $reportDateFrom.value && value < $reportDateFrom.value) {
    $reportDateFrom.value = value;
  }
  syncReportDateLabels();
  if (reportDatePickerOpen === kind) renderReportDatePicker(kind);
  renderReports();
}

function commitReportDateText(kind) {
  const input = kind === 'from' ? $reportDateFromText : $reportDateToText;
  const fallback = kind === 'from'
    ? ($reportDateFrom?.value || todayKey())
    : ($reportDateTo?.value || $reportDateFrom?.value || todayKey());
  if (!input) return;
  const parsed = parseDateInputRU(input.value);
  if (!parsed) {
    input.value = formatDateInputRU(fallback);
    toast('Дата: формат ДД.ММ.ГГГГ');
    return;
  }
  setReportDateValue(kind, parsed);
}

function applyReportPreset(preset) {
  const today = todayKey();
  let from = today;
  let to = today;
  if (preset === 'yesterday') {
    from = shiftDateKey(today, -1);
    to = from;
  } else if (preset === 'week') {
    from = shiftDateKey(today, -6);
  } else if (preset === 'month') {
    from = startOfMonthKey(today);
  }
  if ($reportDateFrom) $reportDateFrom.value = from;
  if ($reportDateTo) $reportDateTo.value = to;
  syncReportDateLabels();
  closeReportDatePickers();
  renderReports();
}

function activeReportPreset(filters = getReportFilters()) {
  const today = todayKey();
  const yesterday = shiftDateKey(today, -1);
  if (filters.from === today && filters.to === today) return 'today';
  if (filters.from === yesterday && filters.to === yesterday) return 'yesterday';
  if (filters.from === shiftDateKey(today, -6) && filters.to === today) return 'week';
  if (filters.from === startOfMonthKey(today) && filters.to === today) return 'month';
  return '';
}

function syncReportPresetButtons(filters = getReportFilters()) {
  const active = activeReportPreset(filters);
  $reportPresetButtons.forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.reportPreset === active);
  });
}

function getFilteredReportData() {
  const filters = getReportFilters();
  const all = allSessionRecords();
  const fromTs = Date.parse(`${filters.from}T00:00:00`) || Date.now();
  const toTs = Date.parse(`${filters.to}T23:59:59`) || fromTs;
  const sessionRows = all.filter((rec) => {
    const startTs = Number(rec?.startTime) || Date.parse(`${rec.dateKey}T00:00:00`) || 0;
    if (startTs < fromTs || startTs > toTs) return false;
    if (filters.stationType !== 'all' && stationTypeFromRecord(rec) !== filters.stationType) return false;
    if (!sessionMatchesPayment(rec, filters.payment)) return false;
    return true;
  });
  const salesRows = [];
  for (const rec of sessionRows) {
    const sales = Array.isArray(rec?.sales) ? rec.sales : [];
    if (!sales.length && Number(rec?.totalAmount || 0) > 0) {
      salesRows.push({
        dateKey: rec.dateKey,
        stationId: rec.stationId,
        stationName: rec.stationName,
        stationType: stationTypeFromRecord(rec),
        time: rec.startTime || Date.parse(`${rec.dateKey}T00:00:00`) || Date.now(),
        type: 'legacy',
        label: 'Продажа',
        minutes: 0,
        amount: Number(rec.totalAmount) || 0,
        paymentMethod: rec.paymentMethod || 'cash',
      });
      continue;
    }
    for (const sale of sales) {
      const pm = sale?.paymentMethod || rec.paymentMethod || 'cash';
      if (filters.payment !== 'all' && pm !== filters.payment) continue;
      salesRows.push({
        dateKey: rec.dateKey,
        stationId: rec.stationId,
        stationName: rec.stationName,
        stationType: stationTypeFromRecord(rec),
        time: Number(sale?.time) || rec.startTime || Date.now(),
        type: sale?.type || 'sale',
        label: sale?.label || 'Начисление',
        minutes: Number(sale?.minutes) || 0,
        amount: Number(sale?.amount) || 0,
        paymentMethod: pm,
      });
    }
  }
  salesRows.sort((a, b) => (b.time || 0) - (a.time || 0));
  return { filters, sessionRows, salesRows };
}

function formatDurationMinutes(totalMinutes) {
  const n = Math.max(0, Math.round(Number(totalMinutes) || 0));
  const h = Math.floor(n / 60);
  const m = n % 60;
  if (h && m) return `${h} ч ${m} мин`;
  if (h) return `${h} ч`;
  return `${m} мин`;
}

function renderReports() {
  if (!$reportsList) return;
  const { filters, sessionRows, salesRows } = getFilteredReportData();
  syncReportDateLabels();
  const revenue = salesRows.reduce((sum, sale) => sum + (Number(sale.amount) || 0), 0);
  const avgCheck = sessionRows.length ? Math.round(revenue / sessionRows.length) : 0;
  const closed = sessionRows.filter((rec) => rec.endTime && rec.startTime);
  const avgDuration = closed.length
    ? Math.round(closed.reduce((sum, rec) => sum + Math.max(0, Math.round(((rec.endTime || 0) - (rec.startTime || 0)) / 60000)), 0) / closed.length)
    : 0;

  const typeTotals = { ps: 0, simulator: 0, switch: 0 };
  for (const sale of salesRows) typeTotals[sale.stationType] += Number(sale.amount) || 0;
  const paymentTotals = Object.fromEntries(PAYMENT_METHODS.map((m) => [m.id, 0]));
  for (const sale of salesRows) paymentTotals[sale.paymentMethod] += Number(sale.amount) || 0;

  if ($reportsSub) $reportsSub.textContent = `${formatDateRU(filters.from)} → ${formatDateRU(filters.to)} • ${filters.view === 'sales' ? 'начислений' : 'сессий'}: ${filters.view === 'sales' ? salesRows.length : sessionRows.length}`;
  if ($reportRevenue) $reportRevenue.textContent = money(revenue);
  if ($reportSessionsCount) $reportSessionsCount.textContent = String(sessionRows.length);
  if ($reportAvgCheck) $reportAvgCheck.textContent = sessionRows.length ? money(avgCheck) : '—';
  if ($reportAvgDuration) $reportAvgDuration.textContent = closed.length ? formatDurationMinutes(avgDuration) : '—';
  if ($reportTypeTotals) $reportTypeTotals.textContent = ['ps','simulator','switch'].map((type) => `${stationTypeLabel(type)}: ${money(typeTotals[type])}`).join(' • ');
  if ($reportPaymentTotals) $reportPaymentTotals.textContent = PAYMENT_METHODS.map((method) => `${method.label}: ${money(paymentTotals[method.id])}`).join(' • ');
  syncReportPresetButtons(filters);

  renderReportChart(salesRows, filters);

  const rows = filters.view === 'sales' ? salesRows : sessionRows;
  if (!rows.length) {
    $reportsList.innerHTML = '<div class="sessionRow"><div class="sessionRow__left"><div class="sessionRow__title">Пусто</div><div class="sessionRow__meta">Нет записей за выбранный период.</div></div></div>';
    return;
  }
  $reportsList.innerHTML = '';
  for (const rowData of rows) {
    const row = document.createElement('div');
    row.className = 'reportRow';
    if (filters.view === 'sales') {
      row.innerHTML = `
        <div>
          <div class="reportRow__title">${escapeHtml(rowData.stationName || defaultStationName(rowData.stationId))} • ${escapeHtml(stationTypeLabel(rowData.stationType))}</div>
          <div class="reportRow__meta">${escapeHtml(rowData.label || 'Начисление')} • ${rowData.minutes ? `${rowData.minutes} мин` : 'без минут'}<br>${formatDateRU(todayKey(rowData.time))} • ${hhmm(rowData.time)} • ${escapeHtml(paymentLabel(rowData.paymentMethod || 'cash'))}</div>
        </div>
        <div class="reportRow__right">
          <div><b>${escapeHtml(money(rowData.amount || 0))}</b></div>
          <div>${escapeHtml(String(rowData.type || 'sale'))}</div>
        </div>
      `;
    } else {
      const start = rowData.startTime ? hhmm(rowData.startTime) : '—';
      const end = rowData.endTime ? hhmm(rowData.endTime) : '—';
      const duration = rowData.startTime && rowData.endTime ? formatDurationMinutes(Math.round(((rowData.endTime || 0) - (rowData.startTime || 0)) / 60000)) : 'Активна';
      const tariff = rowData.tariffLabel || (rowData.tariffId ? labelTariff(rowData.tariffId, rowData.stationType) : '—');
      row.innerHTML = `
        <div>
          <div class="reportRow__title">${escapeHtml(rowData.stationName || defaultStationName(rowData.stationId))} • ${escapeHtml(stationTypeLabel(rowData.stationType))}</div>
          <div class="reportRow__meta">${formatDateRU(todayKey(rowData.startTime || Date.now()))} • ${start} → ${end}<br>Тариф: ${escapeHtml(tariff)} • Оплата: ${escapeHtml(paymentLabel(rowData.paymentMethod || 'cash'))}</div>
        </div>
        <div class="reportRow__right">
          <div><b>${escapeHtml(duration)}</b></div>
          <div><b>${escapeHtml(money(rowData.totalAmount || 0))}</b></div>
          <div>${escapeHtml(rowData.endTime ? (rowData.mode === 'auto' ? 'авто' : 'вручную') : 'идёт')}</div>
        </div>
      `;
    }
    $reportsList.appendChild(row);
  }
}


function renderReportChart(salesRows, filters) {
  if (!$reportChart) return;
  const fromTs = Date.parse(`${filters.from}T00:00:00`) || Date.now();
  const toTs = Date.parse(`${filters.to}T00:00:00`) || fromTs;
  const dayMap = new Map();
  for (let ts = fromTs; ts <= toTs; ts += 86400000) {
    dayMap.set(todayKey(ts), 0);
  }
  for (const sale of salesRows) {
    const key = todayKey(sale.time || Date.now());
    dayMap.set(key, (dayMap.get(key) || 0) + (Number(sale.amount) || 0));
  }
  const rows = Array.from(dayMap.entries()).sort((a,b) => a[0].localeCompare(b[0]));
  const maxValue = Math.max(0, ...rows.map(([,v]) => v));
  if (!rows.length) {
    $reportChart.innerHTML = '<div class="reportChart__empty">Нет данных за выбранный период.</div>';
    return;
  }
  $reportChart.innerHTML = rows.map(([dateKey, value]) => {
    const width = maxValue > 0 ? Math.max(4, Math.round((value / maxValue) * 100)) : 0;
    return `
      <div class="reportChart__row">
        <div class="reportChart__date">${escapeHtml(formatDateRU(dateKey))}</div>
        <div class="reportChart__track"><div class="reportChart__bar" style="width:${width}%;"></div></div>
        <div class="reportChart__value">${escapeHtml(money(value))}</div>
      </div>`;
  }).join('');
}

function openReports() {
  const today = todayKey();
  if ($reportDateFrom && !$reportDateFrom.value) $reportDateFrom.value = today;
  if ($reportDateTo && !$reportDateTo.value) $reportDateTo.value = today;
  syncReportDateLabels();
  renderReports();
  $reportsModal.classList.add('modal--open');
  $reportsModal.setAttribute('aria-hidden', 'false');
}

function closeReports() {
  closeAllCustomSelects();
  closeReportDatePickers();
  $reportsModal.classList.remove('modal--open');
  $reportsModal.setAttribute('aria-hidden', 'true');
}

function exportReportsCSV() {
  const { filters, sessionRows, salesRows } = getFilteredReportData();
  const rows = [];
  if (filters.view === 'sales') {
    rows.push(['Дата','Время','Станция','Тип станции','Тип начисления','Минуты','Сумма','Оплата']);
    for (const sale of salesRows) {
      rows.push([formatDateRU(todayKey(sale.time)), hhmm(sale.time), sale.stationName || defaultStationName(sale.stationId), stationTypeLabel(sale.stationType), sale.label || sale.type || 'Продажа', sale.minutes || 0, Math.round(Number(sale.amount) || 0), paymentLabel(sale.paymentMethod || 'cash')]);
    }
  } else {
    rows.push(['Дата','Станция','Тип станции','Тариф','Старт','Финиш','Сумма','Оплата','Завершение']);
    for (const rec of sessionRows) {
      rows.push([formatDateRU(todayKey(rec.startTime || Date.now())), rec.stationName || defaultStationName(rec.stationId), stationTypeLabel(rec.stationType), rec.tariffLabel || (rec.tariffId ? labelTariff(rec.tariffId, rec.stationType) : '—'), rec.startTime ? hhmm(rec.startTime) : '', rec.endTime ? hhmm(rec.endTime) : '', Math.round(Number(rec.totalAmount) || 0), paymentLabel(rec.paymentMethod || 'cash'), rec.endTime ? (rec.mode === 'auto' ? 'авто' : 'вручную') : 'идёт']);
    }
  }
  const csv = rows.map((row) => row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(';')).join('\n');
  const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `PS_Lounge_reports_${formatDateRU(filters.from).replaceAll('.', '-')}_${formatDateRU(filters.to).replaceAll('.', '-')}_${filters.view}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}




function formatPinLockRemaining(ms) {
  const totalSec = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  if (minutes > 0) return `${minutes} мин ${String(seconds).padStart(2, '0')} сек`;
  return `${seconds} сек`;
}

function updatePinNote(text = '', isError = false) {
  if (!$pinNote) return;
  $pinNote.textContent = text || 'PIN нужен только для открытия настроек.';
  $pinNote.classList.toggle('pinNote--error', !!isError);
}

function openPinModal() {
  const guard = loadPinGuard();
  const now = Date.now();
  if (guard.lockUntil > now) {
    updatePinNote(`Слишком много неверных попыток. Повторите через ${formatPinLockRemaining(guard.lockUntil - now)}.`, true);
  } else {
    updatePinNote('PIN нужен только для открытия настроек.', false);
  }
  if ($pinInput) $pinInput.value = '';
  $pinModal.classList.add('modal--open');
  $pinModal.setAttribute('aria-hidden', 'false');
  setTimeout(() => { try { $pinInput?.focus(); } catch {} }, 0);
}

function closePinModal() {
  if (!$pinModal) return;
  $pinModal.classList.remove('modal--open');
  $pinModal.setAttribute('aria-hidden', 'true');
  updatePinNote('PIN нужен только для открытия настроек.', false);
}

function requestSettingsAccess() {
  if (settingsModalUnlocked) {
    openSettings();
    return;
  }
  openPinModal();
}

function submitPinAccess() {
  const guard = loadPinGuard();
  const now = Date.now();
  if (guard.lockUntil > now) {
    updatePinNote(`Слишком много неверных попыток. Повторите через ${formatPinLockRemaining(guard.lockUntil - now)}.`, true);
    toast('Доступ временно заблокирован');
    return;
  }

  const pin = String($pinInput?.value || '').trim();
  if (!pin) {
    updatePinNote('Введи PIN-код.', true);
    return;
  }

  const ok = hashPin(pin) === getSettingsPinHash();
  if (ok) {
    clearPinGuard();
    settingsModalUnlocked = true;
    closePinModal();
    openSettings();
    return;
  }

  const attempts = guard.attempts + 1;
  const next = { attempts, lockUntil: 0 };
  if (attempts >= PIN_MAX_ATTEMPTS) {
    next.attempts = 0;
    next.lockUntil = now + PIN_LOCK_MS;
    updatePinNote(`Слишком много неверных попыток. Повторите через ${formatPinLockRemaining(PIN_LOCK_MS)}.`, true);
    toast('PIN временно заблокирован на 10 минут');
  } else {
    updatePinNote(`Неверный PIN. Осталось попыток: ${PIN_MAX_ATTEMPTS - attempts}.`, true);
    toast('Неверный PIN');
  }
  savePinGuard(next);
  if ($pinInput) {
    $pinInput.value = '';
    $pinInput.focus();
  }
}

function clearSettingsPinFields() {
  if ($settingsPinCurrent) $settingsPinCurrent.value = '';
  if ($settingsPinNew) $settingsPinNew.value = '';
  if ($settingsPinRepeat) $settingsPinRepeat.value = '';
}

function changeSettingsPin() {
  const current = String($settingsPinCurrent?.value || '').trim();
  const next = String($settingsPinNew?.value || '').trim();
  const repeat = String($settingsPinRepeat?.value || '').trim();
  if (!current || !next || !repeat) {
    toast('Заполни все поля PIN');
    return;
  }
  if (hashPin(current) !== getSettingsPinHash()) {
    toast('Текущий PIN неверный');
    return;
  }
  if (!/^\d{4,8}$/.test(next)) {
    toast('Новый PIN должен состоять из 4–8 цифр');
    return;
  }
  if (next !== repeat) {
    toast('Новый PIN и повтор не совпадают');
    return;
  }
  settings.pinHash = hashPin(next);
  if (settingsDraft) settingsDraft.pinHash = settings.pinHash;
  saveSettings(true);
  clearSettingsPinFields();
  toast('PIN обновлён');
}

function openSettings() {
  settingsEditorType = getSelectedStationType();
  settingsDraft = cloneJson(settings);
  renderSettingsModal();
  clearSettingsPinFields();
  $settingsModal.classList.add('modal--open');
  $settingsModal.setAttribute('aria-hidden', 'false');
  rememberSettingsBaseline();
}

function closeSettings() {
  if (!confirmSettingsClose()) return;
  settingsDraft = null;
  settingsModalUnlocked = false;
  settingsBaselineSignature = '';
  setSettingsDirty(false);
  clearSettingsPinFields();
  $settingsModal.classList.remove('modal--open');
  $settingsModal.setAttribute('aria-hidden', 'true');
}


function getSettingsSource() {
  return settingsDraft || settings;
}

function captureSettingsTabDraft() {
  if (!settingsDraft || !$settingsTariffs) return true;
  const stationRows = [...document.querySelectorAll('.stationDefRow')];
  const stationDefinitions = [];
  for (const row of stationRows) {
    const id = Number(row.dataset.stationId);
    const name = row.querySelector('[data-role="station-name"]')?.value?.trim();
    const type = String(row.querySelector('[data-role="station-type"]')?.value || '').trim().toLowerCase();
    if (!Number.isFinite(id) || id <= 0 || !name || !STATION_TYPES[type]) return false;
    stationDefinitions.push(normalizeStationDefinition({ id, name, type }, stationDefinitions.length));
  }
  if (!stationDefinitions.length) return false;
  settingsDraft.stationDefinitions = stationDefinitions;
  const rows = [...document.querySelectorAll('.tariffRow')];
  const tariffs = [];
  for (const row of rows) {
    const label = row.querySelector('[data-role="label"]')?.value?.trim();
    const minutes = Number(row.querySelector('[data-role="minutes"]')?.value);
    const price = Number(row.querySelector('[data-role="price"]')?.value);
    if (!label || !Number.isFinite(minutes) || minutes < 10 || !Number.isFinite(price) || price < 0) {
      return false;
    }
    tariffs.push(normalizeTariff({ id: row.dataset.tariffId || makeTariffId(settingsEditorType), label, minutes, price }, tariffs.length, settingsEditorType));
  }
  if (!tariffs.length) return false;
  settingsDraft.tariffGroups[settingsEditorType] = sortTariffs(tariffs);
  const customRate = Number($settingsCustomRate?.value);
  const graceMinutes = Number($settingsGraceMinutes?.value);
  const overdueMinutes = Number($settingsOverdueMinutes?.value);
  if (!Number.isFinite(customRate) || customRate < 0 || !Number.isFinite(graceMinutes) || graceMinutes < 0 || !Number.isFinite(overdueMinutes) || overdueMinutes < 0) {
    return false;
  }
  settingsDraft.customRates[settingsEditorType] = Math.round(customRate);
  settingsDraft.graceMinutes = Math.round(graceMinutes);
  settingsDraft.overdueMinutes = Math.round(overdueMinutes);
  settingsDraft.notificationSound = !!$settingsNotificationSound?.checked;
  return true;
}

function stationTypeLabel(type) {
  return STATION_TYPES[type]?.label || 'Тип';
}

function renderStationDefinitionRows() {
  if (!$settingsStations || !settingsDraft) return;
  $settingsStations.innerHTML = '';
  const defs = getStationDefinitions(settingsDraft);
  defs.forEach((item, idx) => {
    const row = document.createElement('div');
    row.className = 'stationDefRow';
    row.dataset.stationId = String(item.id);
    row.innerHTML = `
      <label class="field stationDefRow__field stationDefRow__field--name">
        <span class="field__label">Название</span>
        <input class="field__input field__input--compact" data-role="station-name" type="text" value="${escapeHtml(item.name)}" />
      </label>
      <label class="field stationDefRow__field">
        <span class="field__label">Тип</span>
        <select class="field__input field__input--compact" data-role="station-type">
          ${Object.values(STATION_TYPES).map((type) => `<option value="${type.id}"${type.id === item.type ? ' selected' : ''}>${escapeHtml(type.label)}</option>`).join('')}
        </select>
      </label>
      <div class="stationDefRow__actions">
        <button class="btn btn--ghost btn--mini" data-role="move-up" type="button" ${idx === 0 ? 'disabled' : ''}>↑</button>
        <button class="btn btn--ghost btn--mini" data-role="move-down" type="button" ${idx === defs.length - 1 ? 'disabled' : ''}>↓</button>
        <button class="btn btn--ghost btn--mini" data-role="remove" type="button" ${defs.length <= 1 ? 'disabled' : ''}>Удалить</button>
      </div>
    `;
    row.querySelector('[data-role="move-up"]')?.addEventListener('click', () => moveStationDefinition(item.id, -1));
    row.querySelector('[data-role="move-down"]')?.addEventListener('click', () => moveStationDefinition(item.id, 1));
    row.querySelector('[data-role="remove"]')?.addEventListener('click', () => removeStationDefinition(item.id));
    $settingsStations.appendChild(row);
  });
  $settingsStations.querySelectorAll('select[data-role="station-type"]').forEach((select) => {
    const value = String(select.value || '');
    const options = [...select.options].map((option) => ({
      value: option.value,
      label: option.textContent || option.value,
      active: option.value === value,
    }));
    const wrapper = document.createElement('div');
    wrapper.className = 'cselect cselect--compact';
    wrapper.setAttribute('data-cselect', '');
    wrapper.innerHTML = `
      <input data-role="station-type" type="hidden" value="${escapeHtml(value)}" />
      <button class="cselect__toggle field__input field__input--compact" type="button" data-cselect-toggle aria-haspopup="listbox" aria-expanded="false">
        <span data-cselect-label>${escapeHtml(stationTypeLabel(value))}</span>
        <span class="cselect__chevron">▾</span>
      </button>
      <div class="cselect__menu" data-cselect-menu role="listbox">
        ${options.map((option) => `<button class="cselect__option${option.active ? ' is-active' : ''}" type="button" data-value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</button>`).join('')}
      </div>
    `;
    select.replaceWith(wrapper);
  });
  initCustomSelects();
}

function addStationDefinition() {
  if (!settingsDraft) return;
  const defs = getStationDefinitions(settingsDraft);
  const type = 'ps';
  settingsDraft.stationDefinitions = [
    ...defs,
    normalizeStationDefinition({
      id: nextStationId(defs),
      type,
      name: makeDefaultStationName(type, defs),
    }, defs.length),
  ];
  renderStationDefinitionRows();
  syncSettingsDirtyState();
}

function moveStationDefinition(stationId, delta) {
  if (!settingsDraft) return;
  const defs = [...getStationDefinitions(settingsDraft)];
  const idx = defs.findIndex((item) => item.id === stationId);
  if (idx < 0) return;
  const nextIdx = idx + delta;
  if (nextIdx < 0 || nextIdx >= defs.length) return;
  const [item] = defs.splice(idx, 1);
  defs.splice(nextIdx, 0, item);
  settingsDraft.stationDefinitions = defs;
  renderStationDefinitionRows();
  syncSettingsDirtyState();
}

function removeStationDefinition(stationId) {
  if (!settingsDraft) return;
  const defs = getStationDefinitions(settingsDraft);
  if (defs.length <= 1) {
    toast('Нужна хотя бы одна станция');
    return;
  }
  const station = stations.find((item) => item.id === stationId);
  if (station && station.status !== 'idle') {
    toast('Нельзя удалить активную станцию');
    return;
  }
  settingsDraft.stationDefinitions = defs.filter((item) => item.id !== stationId);
  renderStationDefinitionRows();
  syncSettingsDirtyState();
}

function renderSettingsTypeTabs() {
  if (!$settingsTypeTabs) return;
  $settingsTypeTabs.innerHTML = '';
  for (const type of ['ps', 'simulator', 'switch']) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `chip chip--ghost chip--small${settingsEditorType === type ? ' chip--active' : ''}`;
    btn.textContent = stationTypeLabel(type);
    btn.addEventListener('click', () => {
      if (!captureSettingsTabDraft()) { toast('Сначала исправь текущие значения'); return; }
      settingsEditorType = type;
      renderSettingsModal();
    });
    $settingsTypeTabs.appendChild(btn);
  }
}

function renderSettingsModal() {
  if (!$settingsTariffs || !$settingsCustomRate || !$settingsGraceMinutes || !$settingsOverdueMinutes) return;
  settingsRenderInProgress = true;
  try {
    renderSettingsTypeTabs();
    renderStationDefinitionRows();
    $settingsTariffs.innerHTML = '';
    const type = settingsEditorType;
    if ($settingsTypeTitle) $settingsTypeTitle.textContent = `Тарифы: ${stationTypeLabel(type)}`;
    const source = getSettingsSource();
    for (const t of sortTariffs(source.tariffGroups?.[type] || [])) addTariffRow(t, type);
    $settingsCustomRate.value = String(Math.max(0, Math.round(source.customRates?.[type] || 0)));
    $settingsGraceMinutes.value = String(Math.max(0, Math.round(source.graceMinutes || 0)));
    $settingsOverdueMinutes.value = String(Math.max(0, Math.round(source.overdueMinutes || 0)));
    if ($settingsNotificationSound) $settingsNotificationSound.checked = !!source.notificationSound;
  } finally {
    settingsRenderInProgress = false;
  }
}

function addTariffRow(tariff = null, type = settingsEditorType) {
  if (!$settingsTariffs) return;
  const source = getSettingsSource();
  const item = tariff ? normalizeTariff(tariff, 0, type) : { id: makeTariffId(type), label: 'Новый тариф', minutes: 60, price: source.customRates?.[type] || DEFAULT_CUSTOM_RATES[type] || DEFAULT_CUSTOM_RATES.ps };
  const row = document.createElement('div');
  row.className = 'tariffRow';
  row.dataset.tariffId = item.id;
  row.dataset.tariffType = type;
  row.innerHTML = `
    <label class="field tariffRow__field tariffRow__field--label"><span class="field__label">Название</span><input class="field__input field__input--compact" data-role="label" type="text" value="${escapeHtml(item.label)}" /></label>
    <label class="field tariffRow__field"><span class="field__label">Минуты</span><input class="field__input field__input--compact" data-role="minutes" type="number" min="10" step="10" value="${String(item.minutes)}" /></label>
    <label class="field tariffRow__field"><span class="field__label">Цена</span><input class="field__input field__input--compact" data-role="price" type="number" min="0" step="10" value="${String(item.price)}" /></label>
    <div class="tariffRow__actions"><button class="btn btn--ghost btn--mini tariffRow__remove" type="button">Удалить</button></div>
  `;
  row.querySelector('.tariffRow__remove')?.addEventListener('click', () => {
    if ($settingsTariffs.querySelectorAll('.tariffRow').length <= 1) {
      toast('Нужен хотя бы один тариф');
      return;
    }
    row.remove();
    syncSettingsDirtyState();
  });
  $settingsTariffs.appendChild(row);
}

function saveSettingsFromModal() {
  if (!captureSettingsTabDraft() || !settingsDraft) {
    toast('Проверь тарифы и настройки');
    return;
  }
  const nextDefs = getStationDefinitions(settingsDraft);
  const removedActive = stations.filter((item) => item.status !== 'idle' && !nextDefs.find((def) => def.id === item.id));
  if (removedActive.length) {
    toast('Сначала завершите или восстановите активные станции перед удалением');
    return;
  }
  settings = normalizeSettings(settingsDraft);
  stations = syncStationsWithDefinitions(stations, getStationDefinitions(settings));
  if (selectedStationId != null && !stations.find((item) => item.id === selectedStationId)) selectedStationId = null;
  ensureSelectedTariffs();
  saveSettings(true);
  saveStations(true);
  settingsDraft = cloneJson(settings);
  updateSubtitle();
  renderTariffs();
  renderJournalStationOptions();
  renderStations(true);
  syncControl();
  syncAchievementsState();
  renderAchievementsButton();
  renderSettingsModal();
  rememberSettingsBaseline();
  if ($sessionsModal.classList.contains('modal--open')) renderSessions();
  toast('Настройки сохранены');
}

function resetSettings() {
  const ok = confirm('Сбросить тарифы, кастомные цены и настройки таймера к значениям по умолчанию?');
  if (!ok) return;
  const currentPinHash = getSettingsPinHash();
  settings = defaultSettings();
  settings.pinHash = currentPinHash;
  stations = syncStationsWithDefinitions(stations, getStationDefinitions(settings));
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
  toast('Настройки сброшены');
}

function sanitizeFilenamePart(value) {
  return String(value || '')
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '')
    .replace(/\s+/g, '-');
}

function buildSettingsFormSignature() {
  const source = cloneJson(settingsDraft || settings || {});
  if (!$settingsModal?.classList.contains('modal--open')) {
    return JSON.stringify(source);
  }

  if (Array.isArray(source.stationDefinitions)) {
    source.stationDefinitions = [...document.querySelectorAll('.stationDefRow')].map((row, idx) => ({
      id: Number(row.dataset.stationId || 0),
      name: String(row.querySelector('[data-role="station-name"]')?.value || ''),
      type: String(row.querySelector('[data-role="station-type"]')?.value || ''),
      order: idx,
    }));
  }

  source.tariffGroups = source.tariffGroups && typeof source.tariffGroups === 'object' ? source.tariffGroups : {};
  source.tariffGroups[settingsEditorType] = [...document.querySelectorAll('.tariffRow')].map((row, idx) => ({
    id: String(row.dataset.tariffId || ''),
    label: String(row.querySelector('[data-role="label"]')?.value || ''),
    minutes: String(row.querySelector('[data-role="minutes"]')?.value || ''),
    price: String(row.querySelector('[data-role="price"]')?.value || ''),
    order: idx,
  }));

  source.customRates = source.customRates && typeof source.customRates === 'object' ? source.customRates : {};
  source.customRates[settingsEditorType] = String($settingsCustomRate?.value || '');
  source.graceMinutes = String($settingsGraceMinutes?.value || '');
  source.overdueMinutes = String($settingsOverdueMinutes?.value || '');
  source.notificationSound = !!$settingsNotificationSound?.checked;

  return JSON.stringify(source);
}

function syncSettingsDirtyState() {
  setSettingsDirty(buildSettingsFormSignature() !== settingsBaselineSignature);
}

function rememberSettingsBaseline() {
  settingsBaselineSignature = buildSettingsFormSignature();
  setSettingsDirty(false);
}

function setSettingsDirty(dirty) {
  settingsDraftDirty = !!dirty;
  if ($settingsDirtyBadge) {
    $settingsDirtyBadge.hidden = !settingsDraftDirty;
    $settingsDirtyBadge.style.display = settingsDraftDirty ? 'inline-flex' : 'none';
  }
  if ($btnSaveSettings) {
    $btnSaveSettings.classList.toggle('btn--glow', settingsDraftDirty);
  }
}

function confirmSettingsClose() {
  if (!settingsDraftDirty) return true;
  return confirm('Есть несохранённые изменения. Закрыть настройки без сохранения?');
}

/* HELPERS */
function fmt(ms) {
  const safe = Math.max(0, ms);
  const totalSeconds = Math.floor(safe / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}


function formatDateRU(value) {
  if (!value) return '';
  let d;
  if (value instanceof Date) {
    d = value;
  } else if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [y, m, day] = value.split('-').map(Number);
    d = new Date(y, m - 1, day);
  } else {
    d = new Date(value);
  }
  if (Number.isNaN(d.getTime())) return String(value);
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();
  return `${day}.${month}.${year}`;
}

function hhmm(ts) {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2,'0');
  const mm = String(d.getMinutes()).padStart(2,'0');
  return `${hh}:${mm}`;
}

function toast(text, duration = 1800) {
  if (!toast._queue) toast._queue = [];
  if (toast._showing) {
    toast._queue.push({ text, duration });
    return;
  }
  toast._showing = true;
  $toast.textContent = text;
  $toast.classList.add('toast--show');
  window.clearTimeout(toast._t);
  toast._t = window.setTimeout(() => {
    $toast.classList.remove('toast--show');
    window.setTimeout(() => {
      const next = toast._queue.shift();
      toast._showing = false;
      if (next) toast(next.text, next.duration);
    }, 120);
  }, duration);
}

function escapeHtml(str) {
  return String(str)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}


async function boot() {
  if (window.__licenseBootPatched !== true) return;
  // Sync with disk backup. Newer wins.
  try {
    const res = await fetch('/api/backup', { cache: 'no-store' });
    if (res.ok) {
      const b = await res.json();
      const bLM = Number.isFinite(b?.lastModified) ? b.lastModified : 0;
      if (b?.source === 'backup') {
        setTimeout(() => toast('Состояние восстановлено из резервной копии'), 300);
      }
      if (bLM > lastModified && b?.stations && b?.sessions) {
        stations = b.stations;
        sessions = b.sessions;
        settings = (b?.settings && typeof b.settings === 'object') ? normalizeSettings(b.settings) : settings;
        achievements = normalizeAchievementsState(b?.achievements);
        lastModified = bLM;
        saveMeta({ lastModified });
        // write to localStorage without forcing immediate flush back
        localStorage.setItem(STORAGE_KEY, JSON.stringify(stations));
        localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions));
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
        localStorage.setItem(ACHIEVEMENTS_KEY, JSON.stringify(achievements));
      } else if (lastModified > bLM) {
        // push our newer state to disk
        scheduleFlush(true);
      }
    }
  } catch {
    // ignore
  }
  init();
}

boot();




function journalStationLabel(value){
  if(value==='1') return 'PS1';
  if(value==='2') return 'PS2';
  if(value==='3') return 'PS3';
  if(value==='4') return 'PS4';
  if(value==='5') return 'Симулятор гонок';
  if(value==='6') return 'Nintendo Switch';
  return 'Все станции';
}
function journalLevelLabel(value){
  if(value==='info') return 'Обычные';
  if(value==='warn') return 'Предупреждения';
  return 'Все';
}
journalStationLabel = function journalStationLabelDynamic(value){
  const normalized = String(value || 'all');
  if (normalized === 'all') return 'Все станции';
  const station = getStationDefinitions().find((item) => String(item.id) === normalized);
  return station?.name || 'Все станции';
};

function getJournalSelectRoot(kind){
  return document.querySelector(`[data-journal-select="${kind}"]`);
}
function syncJournalSelect(kind){
  const root = getJournalSelectRoot(kind);
  const input = kind === 'station' ? $journalStationFilter : $journalLevelFilter;
  if (!root || !input) return;
  const label = root.querySelector(`[data-journal-select-label="${kind}"]`);
  const menu = root.querySelector(`[data-journal-select-menu="${kind}"]`);
  const value = String(input.value || 'all');
  const text = kind === 'station' ? journalStationLabel(value) : journalLevelLabel(value);
  if (label) label.textContent = text;
  menu?.querySelectorAll('.cselect__option').forEach((btn) => {
    btn.classList.toggle('is-active', String(btn.dataset.value || '') === value);
  });
}
function closeJournalSelects(){
  document.querySelectorAll('[data-journal-select].is-open').forEach((root) => {
    root.classList.remove('is-open');
    root.querySelector('[data-journal-select-toggle]')?.setAttribute('aria-expanded', 'false');
  });
}
function toggleJournalSelect(kind){
  const root = getJournalSelectRoot(kind);
  const toggle = root?.querySelector(`[data-journal-select-toggle="${kind}"]`);
  if (!root || !toggle) return;
  const open = !root.classList.contains('is-open');
  closeJournalSelects();
  root.classList.toggle('is-open', open);
  toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
}
function setJournalSelectValue(kind, value){
  const input = kind === 'station' ? $journalStationFilter : $journalLevelFilter;
  if (!input) return;
  const nextValue = String(value || 'all');
  if (String(input.value || 'all') !== nextValue) {
    input.value = nextValue;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }
  syncJournalSelect(kind);
  closeJournalSelects();
}
function applyJournalFilterVisualState(){
  const stationActive = ($journalStationFilter?.value || 'all') !== 'all';
  const levelActive = ($journalLevelFilter?.value || 'all') !== 'all';
  const searchActive = String($journalSearch?.value || '').trim() !== '';
  const stationWrap = $journalStationFilter?.closest('.cselect, .field');
  const levelWrap = $journalLevelFilter?.closest('.cselect, .field');
  const searchWrap = $journalSearch?.closest('.field');
  stationWrap?.classList.toggle('is-filter-active', stationActive);
  levelWrap?.classList.toggle('is-filter-active', levelActive);
  searchWrap?.classList.toggle('is-filter-active', searchActive);
}
function updateJournalFilterInfo(){
  const st = $journalStationFilter?.value || 'all';
  const lv = $journalLevelFilter?.value || 'all';
  const search = String($journalSearch?.value || '').trim();
  if ($journalSub) {
    $journalSub.textContent = 'Последние действия администратора и защитные срабатывания.';
  }
  if ($journalActiveFilters) {
    const parts = [];
    if (st !== 'all') parts.push(journalStationLabel(st));
    if (lv !== 'all') parts.push(journalLevelLabel(lv));
    if (search) parts.push(`поиск: ${search}`);
    if (!parts.length) {
      $journalActiveFilters.textContent = 'Активные фильтры: нет';
      $journalActiveFilters.classList.remove('is-active');
    } else {
      $journalActiveFilters.textContent = `Активные фильтры: ${parts.join(' • ')}`;
      $journalActiveFilters.classList.add('is-active');
    }
  }
  applyJournalFilterVisualState();
}
function resetJournalFilters(){
  if($journalStationFilter) {
    $journalStationFilter.value = 'all';
  }
  if($journalSearch) $journalSearch.value = '';
  if($journalLevelFilter) {
    $journalLevelFilter.value = 'all';
  }
  syncJournalSelect('station');
  syncJournalSelect('level');
  closeJournalSelects();
  renderJournal();
}

function setLicenseGateVisible(visible) {
  if ($licenseGate) {
    $licenseGate.hidden = !visible;
    $licenseGate.classList.toggle('licenseGate--visible', !!visible);
  }
  $appShell?.classList.toggle('app--shell-hidden', !!visible);
}

function renderLicenseStatus(status, message = '') {
  const state = status || {};
  const label = state.machineFingerprintLabel || state.machineFingerprint || '—';
  if ($licenseFingerprint) $licenseFingerprint.textContent = label;
  if ($licenseLead) {
    $licenseLead.textContent = state.licensed
      ? `Лицензия активна${state.customer ? ` для ${state.customer}` : ''}.`
      : 'Для работы программы требуется лицензия, привязанная к этому устройству.';
  }
  if ($licenseNote) {
    if (message) {
      $licenseNote.textContent = message;
    } else if (!state.licensed) {
      const reason = state.status === 'device_mismatch'
        ? 'Ключ выпущен для другого устройства.'
        : state.status === 'invalid'
          ? 'Ключ не прошёл локальную проверку.'
          : state.status === 'corrupt'
            ? 'Файл лицензии повреждён. Повторите активацию.'
            : 'Лицензия проверяется локально и сохраняется на этом компьютере.';
      $licenseNote.textContent = reason;
    } else {
      $licenseNote.textContent = 'Проверка лицензии выполнена локально.';
    }
  }
}

async function fetchLicenseStatus() {
  const res = await fetch('/api/license/status', { cache: 'no-store' });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(payload?.error || 'license_status_failed');
  licenseStatusCache = payload;
  renderLicenseStatus(payload);
  return payload;
}

function renderJournalStationOptions() {
  if (!$journalStationFilter) return;
  const defs = getStationDefinitions();
  const menu = document.querySelector('[data-journal-select-menu="station"]');
  const current = String($journalStationFilter.value || 'all');
  const nextValue = current !== 'all' && defs.find((item) => String(item.id) === current) ? current : 'all';
  $journalStationFilter.value = nextValue;
  if (menu) {
    menu.innerHTML = [
      '<button class="cselect__option" type="button" data-value="all">Все станции</button>',
      ...defs.map((item) => `<button class="cselect__option" type="button" data-value="${escapeHtml(String(item.id))}">${escapeHtml(item.name)}</button>`),
    ].join('');
  }
  syncJournalSelect('station');
  syncJournalSelect('level');
}

async function startLicensedApp() {
  try {
    const res = await fetch('/api/backup', { cache: 'no-store' });
    if (res.ok) {
      const b = await res.json();
      const bLM = Number.isFinite(b?.lastModified) ? b.lastModified : 0;
      if (b?.source === 'backup') {
        setTimeout(() => toast('Состояние восстановлено из резервной копии'), 300);
      }
      if (bLM > lastModified && b?.stations && b?.sessions) {
        settings = (b?.settings && typeof b.settings === 'object') ? normalizeSettings(b.settings) : settings;
        stations = syncStationsWithDefinitions(b.stations, getStationDefinitions(settings));
        sessions = b.sessions;
        achievements = normalizeAchievementsState(b?.achievements);
        lastModified = bLM;
        saveMeta({ lastModified });
        localStorage.setItem(STORAGE_KEY, JSON.stringify(stations));
        localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions));
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
        localStorage.setItem(ACHIEVEMENTS_KEY, JSON.stringify(achievements));
      } else if (lastModified > bLM) {
        stations = syncStationsWithDefinitions(stations, getStationDefinitions(settings));
        scheduleFlush(true);
      }
    }
  } catch {}
  stations = syncStationsWithDefinitions(stations, getStationDefinitions(settings));
  renderJournalStationOptions();
  setLicenseGateVisible(false);
  if (!appInitialized) {
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
  if ($sessionsModal.classList.contains('modal--open')) renderSessions();
  if ($achievementsModal?.classList.contains('modal--open')) renderAchievements();
  if ($reportsModal.classList.contains('modal--open')) renderReports();
  if ($journalModal.classList.contains('modal--open')) renderJournal();
}

async function activateLicense() {
  const token = String($licenseKeyInput?.value || '').trim();
  if (!token) {
    renderLicenseStatus(licenseStatusCache, 'Вставьте лицензионный ключ.');
    return;
  }
  if ($btnLicenseActivate) $btnLicenseActivate.disabled = true;
  try {
    const res = await fetch('/api/license/activate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok || !payload?.licensed) {
      renderLicenseStatus(payload, `Активация не удалась: ${payload?.detail || payload?.error || 'activation_failed'}`);
      return;
    }
    licenseStatusCache = payload;
    renderLicenseStatus(payload, 'Лицензия активирована.');
    await startLicensedApp();
  } catch {
    renderLicenseStatus(licenseStatusCache, 'Не удалось связаться с сервером лицензии.');
  } finally {
    if ($btnLicenseActivate) $btnLicenseActivate.disabled = false;
  }
}

function initLicenseGate() {
  $btnLicenseActivate?.addEventListener('click', activateLicense);
  $btnLicenseRetry?.addEventListener('click', () => boot());
}

window.__licenseBootPatched = true;

boot = async function bootWithLicenseGate() {
  try {
    const status = await fetchLicenseStatus();
    if (!status?.licensed) {
      setLicenseGateVisible(true);
      return;
    }
    await startLicensedApp();
  } catch {
    setLicenseGateVisible(true);
    renderLicenseStatus(licenseStatusCache, 'Не удалось проверить состояние лицензии.');
  }
};

const journalStationLabelEndMarker = function journalStationLabelDynamic(value) {
  if (value === 'all') return 'Все станции';
  const station = getStationDefinitions().find((item) => String(item.id) === String(value));
  return station?.name || 'Все станции';
};

initLicenseGate();
boot();
