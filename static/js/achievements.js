import { addActionLog } from "./journal.js";
import { touchModified } from "./persistence.js";
import { state as appState } from "./state.js";
import { getStationDefinitions, getStationType } from "./stations.js";
import { escapeHtml, formatDateRU, toast } from "./ui-utils.js";

export function getAchievementDefinition(id) {
  return (
    appState.ACHIEVEMENT_DEFINITIONS.find((item) => item.id === id) || null
  );
}

export function defaultAchievementsState() {
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

export function normalizeAchievementsState(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const base = defaultAchievementsState();
  const known = new Set(
    appState.ACHIEVEMENT_DEFINITIONS.map((item) => item.id),
  );
  const unlocked = {};
  if (src.unlocked && typeof src.unlocked === "object") {
    for (const [id, value] of Object.entries(src.unlocked)) {
      if (!known.has(id) || !value || typeof value !== "object") continue;
      const unlockedAt = Number(value.unlockedAt);
      const seenAt = value.seenAt == null ? null : Number(value.seenAt);
      if (!Number.isFinite(unlockedAt) || unlockedAt <= 0) continue;
      unlocked[id] = {
        unlockedAt: Math.round(unlockedAt),
        seenAt:
          Number.isFinite(seenAt) && seenAt > 0 ? Math.round(seenAt) : null,
      };
    }
  }
  const progress = {};
  if (src.progress && typeof src.progress === "object") {
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
    ? [
        ...new Set(
          src.breakEvents
            .map((value) => Math.round(Number(value)))
            .filter((value) => Number.isFinite(value) && value > 0),
        ),
      ]
    : [];
  breakEvents.sort((a, b) => a - b);
  const cleanTrackingStartedAtRaw = Math.round(
    Number(src.cleanTrackingStartedAt),
  );
  const cleanTrackingStartedAt =
    Number.isFinite(cleanTrackingStartedAtRaw) && cleanTrackingStartedAtRaw > 0
      ? cleanTrackingStartedAtRaw
      : base.cleanTrackingStartedAt;
  return {
    version: Number.isFinite(Number(src.version))
      ? Math.max(1, Math.round(Number(src.version)))
      : base.version,
    backfillVersion: Number.isFinite(Number(src.backfillVersion))
      ? Math.max(0, Math.round(Number(src.backfillVersion)))
      : base.backfillVersion,
    unlocked,
    progress,
    unseenIds,
    breakEvents,
    cleanTrackingStartedAt,
  };
}

export function loadAchievements() {
  try {
    const raw = localStorage.getItem(appState.ACHIEVEMENTS_KEY);
    if (!raw) return defaultAchievementsState();
    return normalizeAchievementsState(JSON.parse(raw));
  } catch {
    return defaultAchievementsState();
  }
}

export function saveAchievements(immediate = false) {
  appState.achievements = normalizeAchievementsState(appState.achievements);
  localStorage.setItem(
    appState.ACHIEVEMENTS_KEY,
    JSON.stringify(appState.achievements),
  );
  touchModified(immediate);
}

export function recordAchievementBreakEvent(ts = Date.now()) {
  appState.achievements = normalizeAchievementsState(appState.achievements);
  const normalizedTs = Math.round(Number(ts));
  if (!Number.isFinite(normalizedTs) || normalizedTs <= 0) return;
  const events = Array.isArray(appState.achievements.breakEvents)
    ? appState.achievements.breakEvents
    : [];
  if (events[events.length - 1] === normalizedTs) return;
  appState.achievements.breakEvents = [...events, normalizedTs];
  saveAchievements(true);
}

export function countUnseenAchievements() {
  return Array.isArray(appState.achievements?.unseenIds)
    ? appState.achievements.unseenIds.length
    : 0;
}

export function computeConcurrentStationPeak() {
  const points = [];
  const now = Date.now();
  for (const list of Object.values(appState.sessions || {})) {
    if (!Array.isArray(list)) continue;
    for (const rec of list) {
      const start = Number(rec?.startTime);
      if (!Number.isFinite(start) || start <= 0) continue;
      const end = Number.isFinite(Number(rec?.endTime))
        ? Number(rec.endTime)
        : now;
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

export function computeCleanCloseStreak() {
  const events = [];
  const trackingStartedAt = Math.max(
    0,
    Math.round(Number(appState.achievements?.cleanTrackingStartedAt) || 0),
  );
  for (const list of Object.values(appState.sessions || {})) {
    if (!Array.isArray(list)) continue;
    for (const rec of list) {
      const endTime = Math.round(Number(rec?.endTime));
      if (
        !Number.isFinite(endTime) ||
        endTime <= 0 ||
        endTime < trackingStartedAt
      )
        continue;
      events.push({ ts: endTime, type: "close" });
    }
  }
  for (const ts of appState.achievements?.breakEvents || []) {
    const breakTs = Math.round(Number(ts));
    if (
      !Number.isFinite(breakTs) ||
      breakTs <= 0 ||
      breakTs < trackingStartedAt
    )
      continue;
    events.push({ ts: breakTs, type: "break" });
  }
  events.sort((a, b) => a.ts - b.ts || (a.type === "break" ? -1 : 1));
  let streak = 0;
  let best = 0;
  for (const event of events) {
    if (event.type === "break") {
      streak = 0;
      continue;
    }
    streak += 1;
    if (streak > best) best = streak;
  }
  return best;
}

export function collectAchievementMetrics() {
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

  for (const [dayKey, list] of Object.entries(appState.sessions || {})) {
    if (!Array.isArray(list)) continue;
    for (const rec of list) {
      if (!rec || typeof rec !== "object") continue;
      const sessionAmount = Math.max(
        0,
        Math.round(Number(rec.totalAmount) || 0),
      );
      totalRevenue += sessionAmount;
      if (sessionAmount > highestSessionAmount)
        highestSessionAmount = sessionAmount;
      const sales = Array.isArray(rec.sales) ? rec.sales : [];
      if (sales.length) {
        totalSales += sales.length;
        for (const sale of sales) {
          const paymentMethod = String(
            sale?.paymentMethod || rec.paymentMethod || "cash",
          );
          if (
            appState.PAYMENT_METHODS.some((item) => item.id === paymentMethod)
          )
            paymentSet.add(paymentMethod);
          if (paymentCounts[paymentMethod] != null)
            paymentCounts[paymentMethod] += 1;
          if (
            ["extend_tariff", "extend_custom", "extend_paid_minutes"].includes(
              String(sale?.type || ""),
            )
          )
            paidExtensions += 1;
        }
      } else {
        const fallbackMethod = String(rec.paymentMethod || "cash");
        if (appState.PAYMENT_METHODS.some((item) => item.id === fallbackMethod))
          paymentSet.add(fallbackMethod);
        if (paymentCounts[fallbackMethod] != null && sessionAmount > 0)
          paymentCounts[fallbackMethod] += 1;
        if (Number(rec?.totalAmount) > 0) totalSales += 1;
      }
      if (!Number.isFinite(Number(rec.endTime))) continue;
      closedSessions += 1;
      perDayClosed.set(dayKey, (perDayClosed.get(dayKey) || 0) + 1);
      const stype = getStationType(rec);
      if (perTypeClosed[stype] != null) perTypeClosed[stype] += 1;
      const duration = Math.max(
        0,
        Math.round(
          (Number(rec.endTime) - Number(rec.startTime || rec.endTime)) / 60000,
        ),
      );
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

export function metricForAchievement(id, metrics) {
  const def = getAchievementDefinition(id);
  if (!def) return 0;
  if (id === "full_house")
    return Math.min(metrics.concurrentPeak, metrics.stationCount);
  const metricValue = metrics?.[def.metric];
  return Number.isFinite(Number(metricValue)) ? Number(metricValue) : 0;
}

export function renderAchievementsButton() {
  if (!appState.$btnAchievements || !appState.$achievementsBadge) return;
  const unseen = countUnseenAchievements();
  appState.$achievementsBadge.textContent = unseen > 9 ? "9+" : String(unseen);
  appState.$achievementsBadge.hidden = unseen <= 0;
  appState.$btnAchievements.classList.toggle("chip--active", unseen > 0);
}

export function getAchievementViewModels() {
  const progressMap = appState.achievements?.progress || {};
  const unlockedMap = appState.achievements?.unlocked || {};
  return appState.ACHIEVEMENT_DEFINITIONS.map((item) => {
    const unlockedEntry = unlockedMap[item.id] || null;
    const dynamicMax =
      item.id === "full_house"
        ? Math.max(1, getStationDefinitions().length)
        : item.progressMax;
    const progressMax = Math.max(1, Number(dynamicMax) || 1);
    const progressRaw = Math.max(0, Number(progressMap[item.id] || 0));
    const progressValue = Math.min(progressMax, progressRaw);
    return {
      ...item,
      progressMax,
      progressValue,
      progressPercent: Math.min(
        100,
        Math.round((progressValue / progressMax) * 100),
      ),
      isUnlocked: !!unlockedEntry,
      unlockedAt: unlockedEntry?.unlockedAt || null,
      seenAt: unlockedEntry?.seenAt || null,
    };
  });
}

export function achievementRarity(item) {
  if (item?.rarity === "mythic") return "Мифическое";
  if (item?.rarity === "legend") return "Легенда";
  if (item?.rarity === "elite") return "Элита";
  if (item?.rarity === "rare") return "Редкое";
  return "Базовое";
}

export function achievementRaritySlug(item) {
  if (item?.rarity === "mythic") return "mythic";
  if (item?.rarity === "legend") return "legend";
  if (item?.rarity === "elite") return "elite";
  if (item?.rarity === "rare") return "rare";
  return "base";
}

export function achievementMatchesFilter(item, filter) {
  if (filter === "unlocked") return item.isUnlocked;
  if (filter === "progress") return !item.isUnlocked && item.progressValue > 0;
  if (filter === "top")
    return ["legend", "mythic"].includes(achievementRaritySlug(item));
  return true;
}

export function achievementFilterOptions(items) {
  return [
    { id: "all", label: "Все", count: items.length },
    {
      id: "unlocked",
      label: "Получено",
      count: items.filter((item) => item.isUnlocked).length,
    },
    {
      id: "progress",
      label: "На пути",
      count: items.filter((item) => !item.isUnlocked && item.progressValue > 0)
        .length,
    },
    {
      id: "top",
      label: "Топ",
      count: items.filter((item) =>
        ["legend", "mythic"].includes(achievementRaritySlug(item)),
      ).length,
    },
  ];
}

export function achievementIconKey(item) {
  const metric = String(item?.metric || "");
  if (metric === "closedSessions") return "rhythm";
  if (metric === "concurrentPeak") return "hall";
  if (metric === "maxDurationMinutes" || metric === "totalPlayMinutes")
    return "clock";
  if (metric === "paidExtensions") return "plus";
  if (metric === "totalRevenue" || metric === "totalSales") return "coins";
  if (metric === "paymentCount") return "wallet";
  if (metric === "cashCount") return "cash";
  if (metric === "cardCount") return "card";
  if (metric === "transferCount") return "transfer";
  if (metric === "simulatorClosed") return "simulator";
  if (metric === "switchClosed") return "switch";
  if (metric === "psClosed") return "gamepad";
  if (metric === "cleanCloseStreak") return "check";
  if (metric === "activeDays" || metric === "bestDayClosed") return "calendar";
  if (metric === "highestSessionAmount") return "gem";
  return "star";
}

export function renderAchievementGlyph(iconKey) {
  switch (iconKey) {
    case "rhythm":
      return '<svg viewBox="0 0 24 24" class="achievementGlyph" aria-hidden="true"><path d="M3 15c2.2 0 2.2-6 4.4-6s2.2 10 4.4 10 2.2-14 4.4-14 2.2 8 4.4 8" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    case "hall":
      return '<svg viewBox="0 0 24 24" class="achievementGlyph" aria-hidden="true"><circle cx="6" cy="6" r="2.2" fill="currentColor"/><circle cx="12" cy="6" r="2.2" fill="currentColor"/><circle cx="18" cy="6" r="2.2" fill="currentColor"/><circle cx="6" cy="12" r="2.2" fill="currentColor"/><circle cx="12" cy="12" r="2.2" fill="currentColor"/><circle cx="18" cy="12" r="2.2" fill="currentColor"/><circle cx="6" cy="18" r="2.2" fill="currentColor"/><circle cx="12" cy="18" r="2.2" fill="currentColor"/><circle cx="18" cy="18" r="2.2" fill="currentColor"/></svg>';
    case "clock":
      return '<svg viewBox="0 0 24 24" class="achievementGlyph" aria-hidden="true"><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 7.2V12l3.6 2.2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    case "plus":
      return '<svg viewBox="0 0 24 24" class="achievementGlyph" aria-hidden="true"><path d="M12 4.5v15M4.5 12h15" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/><circle cx="12" cy="12" r="8.8" fill="none" stroke="currentColor" stroke-opacity=".32" stroke-width="1.2"/></svg>';
    case "coins":
      return '<svg viewBox="0 0 24 24" class="achievementGlyph" aria-hidden="true"><ellipse cx="8" cy="8" rx="3.6" ry="1.8" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M4.4 8v4.4c0 1 1.6 1.8 3.6 1.8s3.6-.8 3.6-1.8V8M12.6 11.2c0-1 1.6-1.8 3.6-1.8s3.6.8 3.6 1.8v4.6c0 1-1.6 1.8-3.6 1.8s-3.6-.8-3.6-1.8v-4.6Z" fill="none" stroke="currentColor" stroke-width="1.6"/><ellipse cx="16.2" cy="11.2" rx="3.6" ry="1.8" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>';
    case "wallet":
      return '<svg viewBox="0 0 24 24" class="achievementGlyph" aria-hidden="true"><path d="M4.5 8.2c0-1.4 1.1-2.5 2.5-2.5h10.6a1.9 1.9 0 0 1 1.9 1.9v1.1h-9.2A2.8 2.8 0 0 0 7.5 11.5v1A2.8 2.8 0 0 0 10.3 15h9.2v1.4a1.9 1.9 0 0 1-1.9 1.9H7A2.5 2.5 0 0 1 4.5 15.8V8.2Z" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M19.5 9.7h-9.2c-1 0-1.8.8-1.8 1.8v1c0 1 .8 1.8 1.8 1.8h9.2Z" fill="none" stroke="currentColor" stroke-width="1.7"/><circle cx="13.1" cy="12" r="1.1" fill="currentColor"/></svg>';
    case "cash":
      return '<svg viewBox="0 0 24 24" class="achievementGlyph" aria-hidden="true"><rect x="4" y="6.5" width="16" height="11" rx="2.2" fill="none" stroke="currentColor" stroke-width="1.7"/><circle cx="12" cy="12" r="2.5" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M7 9.3h.01M17 14.7h.01" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>';
    case "card":
      return '<svg viewBox="0 0 24 24" class="achievementGlyph" aria-hidden="true"><rect x="3.8" y="6" width="16.4" height="12" rx="2.4" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M3.8 10.1h16.4" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M7.4 14.1h4.2" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>';
    case "transfer":
      return '<svg viewBox="0 0 24 24" class="achievementGlyph" aria-hidden="true"><path d="M6 8h10.5M13.4 4.8 17 8.2l-3.6 3.4M18 16H7.5M10.6 12.6 7 16l3.6 3.4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    case "simulator":
      return '<svg viewBox="0 0 24 24" class="achievementGlyph" aria-hidden="true"><circle cx="12" cy="12" r="6.8" fill="none" stroke="currentColor" stroke-width="1.7"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><path d="M12 5.2v4.6M18.8 12h-4.6M12 18.8v-4.6M5.2 12h4.6" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>';
    case "switch":
      return '<svg viewBox="0 0 24 24" class="achievementGlyph" aria-hidden="true"><rect x="4.2" y="5.2" width="6.4" height="13.6" rx="3.2" fill="none" stroke="currentColor" stroke-width="1.7"/><rect x="13.4" y="5.2" width="6.4" height="13.6" rx="3.2" fill="none" stroke="currentColor" stroke-width="1.7"/><circle cx="7.4" cy="9.2" r="1.1" fill="currentColor"/><circle cx="16.6" cy="14.8" r="1.1" fill="currentColor"/></svg>';
    case "gamepad":
      return '<svg viewBox="0 0 24 24" class="achievementGlyph" aria-hidden="true"><path d="M7 10.4h10c1.9 0 3.4 1.5 3.4 3.4 0 3.2-2 5.2-3.7 5.2-1.1 0-1.8-.6-2.6-1.2-.7-.5-1.4-1-2.1-1s-1.4.5-2.1 1c-.8.6-1.5 1.2-2.6 1.2C5.6 19 3.6 17 3.6 13.8c0-1.9 1.5-3.4 3.4-3.4Z" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M8 13.3v2.2M6.9 14.4h2.2M15.8 13.8h.01M17.4 15.4h.01" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
    case "check":
      return '<svg viewBox="0 0 24 24" class="achievementGlyph" aria-hidden="true"><path d="M5.5 12.8 9.6 17l8.9-10.2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="12" cy="12" r="8.6" fill="none" stroke="currentColor" stroke-opacity=".32" stroke-width="1.2"/></svg>';
    case "calendar":
      return '<svg viewBox="0 0 24 24" class="achievementGlyph" aria-hidden="true"><rect x="4.2" y="6" width="15.6" height="13.2" rx="2.2" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M8 4.5v3M16 4.5v3M4.2 9.4h15.6" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><path d="m9.2 13.2 1.7 1.8 3.9-4.2" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    case "gem":
      return '<svg viewBox="0 0 24 24" class="achievementGlyph" aria-hidden="true"><path d="M7 8.4 9.7 5h4.6L17 8.4 12 19 7 8.4Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M7 8.4h10M9.7 5 12 8.4 14.3 5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>';
    default:
      return '<svg viewBox="0 0 24 24" class="achievementGlyph" aria-hidden="true"><path d="m12 4.8 2.2 4.6 5 .7-3.6 3.6.9 5-4.5-2.4-4.5 2.4.9-5-3.6-3.6 5-.7Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>';
  }
}

export function renderAchievementEmblem(item, variant = "card") {
  const token = escapeHtml(String(item?.icon || "★"));
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

export function renderAchievements() {
  if (!appState.$achievementsList) return;
  const items = getAchievementViewModels().sort((a, b) => {
    if (a.isUnlocked !== b.isUnlocked) return a.isUnlocked ? -1 : 1;
    if (a.isUnlocked && b.isUnlocked)
      return (b.unlockedAt || 0) - (a.unlockedAt || 0);
    return b.progressPercent - a.progressPercent;
  });
  const unlockedCount = items.filter((item) => item.isUnlocked).length;
  const latest =
    items
      .filter((item) => item.isUnlocked)
      .sort((a, b) => (b.unlockedAt || 0) - (a.unlockedAt || 0))[0] || null;
  const nextGoal =
    items
      .filter((item) => !item.isUnlocked)
      .sort((a, b) => {
        if (b.progressPercent !== a.progressPercent)
          return b.progressPercent - a.progressPercent;
        return (
          a.progressMax - a.progressValue - (b.progressMax - b.progressValue)
        );
      })[0] || null;
  const spotlight = nextGoal || latest || items[0] || null;

  if (appState.$achievementSummaryUnlocked)
    appState.$achievementSummaryUnlocked.textContent = `${unlockedCount}/${items.length}`;
  if (appState.$achievementSummaryInProgress) {
    appState.$achievementSummaryInProgress.textContent = nextGoal
      ? `${nextGoal.title} • ${nextGoal.progressValue}/${nextGoal.progressMax}`
      : "Коллекция завершена";
  }
  if (appState.$achievementSummaryLatest)
    appState.$achievementSummaryLatest.textContent = latest
      ? `${latest.title} • ${formatDateRU(latest.unlockedAt)}`
      : "—";
  if (appState.$achievementHeroCount)
    appState.$achievementHeroCount.textContent = `${unlockedCount}/${items.length}`;
  if (appState.$achievementHeroNext) {
    appState.$achievementHeroNext.textContent = nextGoal
      ? `${nextGoal.title} • ${nextGoal.progressValue}/${nextGoal.progressMax}`
      : "Все вехи собраны";
  }
  if (appState.$achievementHeroLead) {
    appState.$achievementHeroLead.textContent = nextGoal
      ? `Ближе всего сейчас цель «${nextGoal.title}»: уже ${nextGoal.progressValue} из ${nextGoal.progressMax}. Витрина отмечает не быстрые победы, а длинный ритм смен, выручки и полной загрузки зала.`
      : "Коллекция закрыта полностью. Все ключевые вехи по сессиям, загрузке зала и выручке уже собраны.";
  }
  if (appState.$achievementSpotlight) {
    if (spotlight) {
      const rarity = achievementRarity(spotlight);
      const stateLabel = spotlight.isUnlocked
        ? "Получено"
        : spotlight.progressValue > 0
          ? "На пути"
          : "Запечатано";
      const stateMeta =
        spotlight.isUnlocked && spotlight.unlockedAt
          ? `Витрина пополнилась ${formatDateRU(spotlight.unlockedAt)}`
          : `Текущий прогресс: ${spotlight.progressValue}/${spotlight.progressMax}`;
      const accentLabel = spotlight.isUnlocked
        ? "Последнее достижение"
        : "Фокус коллекции";
      appState.$achievementSpotlight.innerHTML = `
        <article class="achievementSpotlight__card achievementSpotlight__card--${achievementRaritySlug(spotlight)}${spotlight.isUnlocked ? " achievementSpotlight__card--unlocked" : ""}">
          <div class="achievementSpotlight__artWrap">
            ${renderAchievementEmblem(spotlight, "spotlight")}
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
      appState.$achievementSpotlight.innerHTML = "";
    }
  }

  const filterOptions = achievementFilterOptions(items);
  if (
    !filterOptions.some(
      (item) => item.id === appState.achievementFilter && item.count > 0,
    ) &&
    appState.achievementFilter !== "all"
  ) {
    appState.achievementFilter = "all";
  }
  if (appState.$achievementFilters) {
    appState.$achievementFilters.innerHTML = filterOptions
      .map(
        (item) => `
      <button class="achievementFilter${item.id === appState.achievementFilter ? " achievementFilter--active" : ""}" type="button" data-achievement-filter="${escapeHtml(item.id)}">
        <span class="achievementFilter__label">${escapeHtml(item.label)}</span>
        <span class="achievementFilter__count">${escapeHtml(String(item.count))}</span>
      </button>
    `,
      )
      .join("");
  }

  const filteredItems = items.filter((item) =>
    achievementMatchesFilter(item, appState.achievementFilter),
  );
  appState.$achievementsList.innerHTML = "";
  if (!filteredItems.length) {
    appState.$achievementsList.innerHTML = `
      <article class="achievementEmptyState">
        <div class="achievementEmptyState__eyebrow">Пусто по фильтру</div>
        <div class="achievementEmptyState__title">Сейчас здесь нет подходящих достижений</div>
        <div class="achievementEmptyState__body">Смените фильтр выше, чтобы вернуться к полной коллекции и текущим вехам.</div>
      </article>
    `;
    return;
  }
  const featuredId =
    appState.achievementFilter === "progress"
      ? nextGoal?.id || null
      : appState.achievementFilter === "all"
        ? latest?.id || null
        : null;
  filteredItems.forEach((item, index) => {
    const card = document.createElement("article");
    const isFeatured =
      !!featuredId && item.id === featuredId && item.id !== spotlight?.id;
    const backdropToken = item.icon || item.category.slice(0, 3).toUpperCase();
    const featuredLabel =
      appState.achievementFilter === "progress"
        ? "Следующая цель"
        : "Последнее достижение";
    card.className = `achievementCard achievementCard--${achievementRaritySlug(item)}${item.isUnlocked ? " achievementCard--unlocked" : item.progressValue > 0 ? " achievementCard--progress" : ""}${!item.isUnlocked ? " achievementCard--locked" : ""}${isFeatured ? " achievementCard--featured" : ""}${index % 5 === 3 ? " achievementCard--tall" : ""}`;
    card.innerHTML = `
      <div class="achievementCard__marker achievementCard__marker--${item.isUnlocked ? "done" : item.progressValue > 0 ? "track" : "sealed"}"></div>
      <div class="achievementCard__backdrop">${escapeHtml(String(backdropToken))}</div>
      <div class="achievementCard__head">
        <div class="achievementCard__iconWrap">
          ${renderAchievementEmblem(item, isFeatured ? "featured" : "card")}
        </div>
        <div>
          ${isFeatured ? `<div class="achievementCard__eyebrow">${escapeHtml(featuredLabel)}</div>` : ""}
          <div class="achievementCard__title">${escapeHtml(item.title)}</div>
          <div class="achievementCard__meta">${item.isUnlocked && item.unlockedAt ? `Получено • ${escapeHtml(formatDateRU(item.unlockedAt))}` : item.progressValue > 0 ? `На пути • ${escapeHtml(String(item.progressValue))}/${escapeHtml(String(item.progressMax))}` : "Коллекция ещё закрыта"}</div>
        </div>
        <div class="achievementCard__statusStack">
          <div class="achievementCard__corner">${escapeHtml(achievementRarity(item))}</div>
          <div class="achievementCard__state">${item.isUnlocked ? "Получено" : item.progressValue > 0 ? "На пути" : "Запечатано"}</div>
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
    appState.$achievementsList.appendChild(card);
  });
}

export function openAchievements() {
  if (!appState.$achievementsModal) return;
  appState.$achievementsModal.classList.add("modal--open");
  appState.$achievementsModal.setAttribute("aria-hidden", "false");
  if (countUnseenAchievements() > 0) {
    const seenAt = Date.now();
    for (const id of appState.achievements.unseenIds || []) {
      if (appState.achievements.unlocked[id])
        appState.achievements.unlocked[id].seenAt = seenAt;
    }
    appState.achievements.unseenIds = [];
    saveAchievements(true);
  }
  renderAchievementsButton();
  renderAchievements();
  if (appState.$achievementsContent) {
    appState.$achievementsContent.scrollTop = 0;
    requestAnimationFrame(() => {
      if (appState.$achievementsContent)
        appState.$achievementsContent.scrollTop = 0;
      appState.$achievementHero?.scrollIntoView({
        block: "start",
        inline: "nearest",
      });
      setTimeout(() => {
        if (appState.$achievementsContent)
          appState.$achievementsContent.scrollTop = 0;
      }, 0);
    });
  }
}

export function closeAchievements() {
  appState.$achievementsModal?.classList.remove("modal--open");
  appState.$achievementsModal?.setAttribute("aria-hidden", "true");
}

export function syncAchievementsState(options = {}) {
  if (!appState.achievements)
    appState.achievements = defaultAchievementsState();
  if (syncAchievementsState._running) return;
  syncAchievementsState._running = true;
  try {
    const state = normalizeAchievementsState(appState.achievements);
    const metrics = collectAchievementMetrics();
    const progress = {};
    const unseen = new Set(state.unseenIds || []);
    const now = Date.now();
    const isBackfill =
      state.backfillVersion < appState.ACHIEVEMENTS_BACKFILL_VERSION;
    const newlyUnlocked = [];

    for (const item of appState.ACHIEVEMENT_DEFINITIONS) {
      const progressMax =
        item.id === "full_house"
          ? Math.max(1, metrics.stationCount)
          : item.progressMax;
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
    if (isBackfill)
      state.backfillVersion = appState.ACHIEVEMENTS_BACKFILL_VERSION;
    appState.achievements = state;
    localStorage.setItem(
      appState.ACHIEVEMENTS_KEY,
      JSON.stringify(appState.achievements),
    );

    if (newlyUnlocked.length && !(isBackfill || options.silent)) {
      const latestDef = getAchievementDefinition(
        newlyUnlocked[newlyUnlocked.length - 1],
      );
      if (latestDef) toast(`Достижение открыто: ${latestDef.title}`, 2400);
      newlyUnlocked.forEach((id) => {
        const def = getAchievementDefinition(id);
        if (!def) return;
        addActionLog("Достижение открыто", null, def.title, "info", {
          suppressAchievementSync: true,
        });
      });
      touchModified(true);
    } else if (isBackfill && newlyUnlocked.length) {
      newlyUnlocked.forEach((id) => {
        const def = getAchievementDefinition(id);
        if (!def) return;
        addActionLog("Достижение открыто", null, def.title, "info", {
          suppressAchievementSync: true,
        });
      });
      touchModified(true);
    }

    renderAchievementsButton();
    if (appState.$achievementsModal?.classList.contains("modal--open"))
      renderAchievements();
  } finally {
    syncAchievementsState._running = false;
  }
}
