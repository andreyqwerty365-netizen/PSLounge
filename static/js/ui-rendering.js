import { saveStations } from "./persistence.js";
import { renderReports, renderSessions } from "./reports.js";
import { getRecoverySnapshot } from "./session-recovery.js";
import {
  computeState,
  getActiveSessionRecord,
  labelTariff,
  money,
  paymentLabel,
  setSessionPaymentMethod,
  tariffPriceLabel,
} from "./sessions.js";
import {
  getSelectedStationType,
  getTariffs,
  saveSettings,
} from "./settings-model.js";
import { state as appState } from "./state.js";
import {
  assetsForStation,
  getStationDefinitions,
  getStationType,
  normalizeStationName,
} from "./stations.js";
import { escapeHtml, hhmm, toast } from "./ui-utils.js";

export function updateSubtitle() {
  if (!appState.$subtitle) return;
  const grace = Math.max(0, Math.round(appState.settings.graceMinutes || 0));
  const overdue = Math.max(
    0,
    Math.round(appState.settings.overdueMinutes || 0),
  );
  const count = getStationDefinitions().length;
  appState.$subtitle.textContent = `${count} станций • доигровка ${grace} мин • просрочка ${overdue} мин • локально в браузере`;
}

export function renderTariffs() {
  appState.$tariffs.innerHTML = "";
  const stationType = getSelectedStationType();
  const list = getTariffs(stationType);
  for (const t of list) {
    const b = document.createElement("button");
    b.className = `tag${t.id === appState.selectedTariffIds[stationType] ? " tag--active" : ""}`;
    b.type = "button";
    b.textContent = `${t.label} • ${money(t.price)}`;
    b.addEventListener("click", () => {
      appState.selectedTariffIds[stationType] = t.id;
      renderTariffs();
      syncControl();
    });
    appState.$tariffs.appendChild(b);
  }
}

export function renderPaymentMethods() {
  if (!appState.$paymentMethodButtons) return;
  appState.$paymentMethodButtons.innerHTML = "";
  for (const item of appState.PAYMENT_METHODS) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `paychip${appState.selectedPaymentMethod === item.id ? " paychip--active" : ""}`;
    b.textContent = item.label;
    b.addEventListener("click", () => {
      appState.selectedPaymentMethod = item.id;
      renderPaymentMethods();
      if (appState.selectedStationId != null) {
        const station = appState.stations.find(
          (x) => x.id === appState.selectedStationId,
        );
        if (station && station.status !== "idle") {
          setSessionPaymentMethod(station, appState.selectedPaymentMethod);
          if (appState.$sessionsModal.classList.contains("modal--open"))
            renderSessions();
        }
      }
      syncControl();
    });
    appState.$paymentMethodButtons.appendChild(b);
  }
}

export function renderStations(full = true) {
  const now = Date.now();
  let active = 0;
  if (full) appState.$grid.innerHTML = "";

  for (const s of appState.stations) {
    if (s.status !== "idle") active++;

    const state = computeState(s, now);
    const timerLabel = state.timerLabel || "Осталось";
    const remainingText = state.remainingText;
    const untilText = state.untilText;

    const tariffText = s.tariffId
      ? labelTariff(s.tariffId, getStationType(s))
      : "—";

    const statusLabel =
      s.status === "running"
        ? "ЗАНЯТА"
        : s.status === "grace"
          ? "ДОИГРОВКА"
          : s.status === "overdue"
            ? "ПРОСРОЧЕНО"
            : "СВОБОДНА";

    const pillClass =
      s.status === "running"
        ? "pill pill--run"
        : s.status === "grace"
          ? "pill pill--grace"
          : s.status === "overdue"
            ? "pill pill--overdue"
            : "pill";

    const assets = assetsForStation(s);
    const imgSrc = s.status === "idle" ? assets.idle : assets.active;

    if (!full) {
      const card = appState.$grid.querySelector(`[data-station-id="${s.id}"]`);
      if (!card) continue;
      const stationType = getStationType(s);
      card.dataset.stationType = stationType;
      card.setAttribute("data-station-type", stationType);

      card.classList.toggle("card--running", s.status === "running");
      card.classList.toggle("card--grace", s.status === "grace");
      card.classList.toggle("card--overdue", s.status === "overdue");
      card.classList.toggle(
        "card--selected",
        appState.selectedStationId === s.id,
      );

      const pill = card.querySelector(".pill");
      if (pill) {
        pill.className = pillClass;
      }
      const pillText = card.querySelector("[data-role='pill']");
      if (pillText) pillText.textContent = statusLabel;

      const timerLabelEl = card.querySelector(".timerBox__label");
      if (timerLabelEl) timerLabelEl.textContent = timerLabel;

      const timer = card.querySelector("[data-role='timer']");
      if (timer) {
        timer.textContent = remainingText;
        timer.classList.toggle("timer--warn", state.tone === "warn");
        timer.classList.toggle("timer--danger", state.tone === "danger");
      }

      const until = card.querySelector("[data-role='until']");
      if (until) until.textContent = untilText;

      const tariff = card.querySelector("[data-role='tariff']");
      if (tariff) tariff.textContent = tariffText;

      const finance = card.querySelector("[data-role='finance']");
      const rec = getActiveSessionRecord(s);
      if (finance)
        finance.textContent = rec
          ? `Оплачено: ${money(rec.totalAmount || 0)} • ${paymentLabel(rec.paymentMethod || "cash")}`
          : "Оплачено: —";

      const img = card.querySelector("img[data-role='pad']");
      if (img) img.src = imgSrc;

      continue;
    }

    const card = document.createElement("article");
    card.className = `card${s.status === "running" ? " card--running" : ""}${s.status === "grace" ? " card--grace" : ""}${s.status === "overdue" ? " card--overdue" : ""}${appState.selectedStationId === s.id ? " card--selected" : ""}`;
    card.dataset.stationId = String(s.id);
    card.setAttribute("data-station-id", String(s.id));
    card.dataset.stationType = getStationType(s);
    card.setAttribute("data-station-type", getStationType(s));

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
      nameEl.addEventListener("dblclick", (ev) => {
        ev.stopPropagation();
        const current = (s.name || "").trim();
        const next = prompt("Название станции:", current);
        if (next == null) return;
        const clean = next.trim();
        if (!clean) return;
        s.name = normalizeStationName(clean);
        appState.settings.stationDefinitions = getStationDefinitions().map(
          (item) => (item.id === s.id ? { ...item, name: s.name } : item),
        );
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
      timerEl.classList.toggle("timer--warn", state.tone === "warn");
      timerEl.classList.toggle("timer--danger", state.tone === "danger");
    }

    const financeEl = card.querySelector('[data-role="finance"]');
    const rec = getActiveSessionRecord(s);
    if (financeEl)
      financeEl.textContent = rec
        ? `Оплачено: ${money(rec.totalAmount || 0)} • ${paymentLabel(rec.paymentMethod || "cash")}`
        : "Оплачено: —";

    const img = card.querySelector('img[data-role="pad"]');
    const hint = card.querySelector('[data-role="img-hint"]');
    if (img && hint) {
      const hintText = hint.querySelector('[data-role="img-hint-text"]');
      if (hintText) hintText.textContent = assets.hint;
      let triedFallback = false;
      img.addEventListener("error", () => {
        const fallbackSrc =
          s.status === "idle" ? assets.fallbackIdle : assets.fallbackActive;
        if (!triedFallback && fallbackSrc) {
          triedFallback = true;
          img.src = fallbackSrc;
          return;
        }
        img.style.display = "none";
        hint.style.display = "block";
      });
    }

    card.addEventListener("click", () => {
      appState.selectedStationId = s.id;
      saveStations(); // keep selection stable across reload? (lightweight)
      renderTariffs();
      renderStations(true);
      syncControl();
    });

    appState.$grid.appendChild(card);
  }

  appState.$activeCount.textContent = String(active);
}

export function syncControl() {
  if (appState.selectedStationId == null) {
    if (appState.$control) {
      appState.$control.classList.add("control--awaiting-selection");
    }
    appState.$ctlTitle.textContent = "Выберите станцию";
    appState.$ctlPill.textContent = "—";
    if (appState.$ctlMetaMain)
      appState.$ctlMetaMain.textContent =
        "Клик по карточке сверху — выбрать станцию для управления.";
    if (appState.$ctlMetaSub)
      appState.$ctlMetaSub.textContent =
        "После выбора откроются тарифы, оплата и служебные действия.";
    appState.$btnStart.disabled = true;
    appState.$btnExtend.disabled = true;
    appState.$btnStop.disabled = true;
    if (appState.$btnPaidAdd30) appState.$btnPaidAdd30.disabled = true;
    if (appState.$btnPaidAdd60) appState.$btnPaidAdd60.disabled = true;
    appState.$btnUndo.disabled = true;
    if (appState.$btnRestoreLast) appState.$btnRestoreLast.disabled = true;
    appState.$undoNote.textContent = "—";
    const stationType = getSelectedStationType();
    const selectedTariffId = appState.selectedTariffIds[stationType];
    if (appState.$ctlMetaStatusLabel)
      appState.$ctlMetaStatusLabel.textContent = "Тариф";
    if (appState.$ctlMetaStatus)
      appState.$ctlMetaStatus.textContent = selectedTariffId
        ? tariffPriceLabel(selectedTariffId, stationType)
        : "—";
    if (appState.$ctlMetaUntilLabel)
      appState.$ctlMetaUntilLabel.textContent = "Оплата";
    if (appState.$ctlMetaUntil)
      appState.$ctlMetaUntil.textContent = paymentLabel(
        appState.selectedPaymentMethod,
      );
    if (appState.$selectedTariffPrice)
      appState.$selectedTariffPrice.textContent = appState.selectedTariffIds[
        stationType
      ]
        ? `Цена тарифа: ${tariffPriceLabel(appState.selectedTariffIds[stationType], stationType)}`
        : "Цена тарифа: —";
    renderPaymentMethods();
    return;
  }

  const s = appState.stations.find((x) => x.id === appState.selectedStationId);
  if (!s) {
    appState.selectedStationId = null;
    syncControl();
    return;
  }

  if (appState.$control) {
    appState.$control.classList.remove("control--awaiting-selection");
  }

  const statusText =
    s.status === "running"
      ? "ЗАНЯТА"
      : s.status === "grace"
        ? "ДОИГРОВКА"
        : s.status === "overdue"
          ? "ПРОСРОЧЕНО"
          : "СВОБОДНА";

  appState.$ctlTitle.textContent = `${s.name} — управление`;
  appState.$ctlPill.textContent = statusText;

  const state = computeState(s, Date.now());
  const tariffText = s.tariffId ? labelTariff(s.tariffId) : "—";
  const activeRecord = getActiveSessionRecord(s);
  const amountText = activeRecord ? money(activeRecord.totalAmount || 0) : "—";
  const methodText = activeRecord
    ? paymentLabel(activeRecord.paymentMethod)
    : paymentLabel(appState.selectedPaymentMethod);

  if (appState.$ctlMetaMain)
    appState.$ctlMetaMain.textContent = `Тариф: ${tariffText}`;
  if (appState.$ctlMetaSub)
    appState.$ctlMetaSub.textContent = `Сумма: ${amountText} • Оплата: ${methodText}`;
  if (appState.$ctlMetaStatusLabel)
    appState.$ctlMetaStatusLabel.textContent = state.timerLabel || "Осталось";
  if (appState.$ctlMetaStatus)
    appState.$ctlMetaStatus.textContent = state.remainingText;
  if (appState.$ctlMetaUntilLabel)
    appState.$ctlMetaUntilLabel.textContent = "Окончание";
  if (appState.$ctlMetaUntil)
    appState.$ctlMetaUntil.textContent = state.untilText;
  const stationType = getStationType(s);
  if (appState.$selectedTariffPrice) {
    appState.$selectedTariffPrice.textContent = appState.selectedTariffIds[
      stationType
    ]
      ? `Цена тарифа: ${tariffPriceLabel(appState.selectedTariffIds[stationType], stationType)}`
      : "Цена тарифа: —";
  }
  appState.selectedPaymentMethod =
    activeRecord?.paymentMethod || appState.selectedPaymentMethod;
  renderPaymentMethods();

  appState.$btnStart.disabled = s.status !== "idle";
  appState.$btnExtend.disabled = s.status === "idle";
  appState.$btnStop.disabled = s.status === "idle";
  if (appState.$btnPaidAdd30)
    appState.$btnPaidAdd30.disabled = s.status === "idle";
  if (appState.$btnPaidAdd60)
    appState.$btnPaidAdd60.disabled = s.status === "idle";

  const last = s.history?.[s.history.length - 1];
  const recovery = getRecoverySnapshot(s);
  if (appState.$btnRestoreLast)
    appState.$btnRestoreLast.disabled = !(s.status === "idle" && recovery);
  if (recovery && s.status === "idle") {
    appState.$undoNote.textContent = `Можно восстановить до ${hhmm(recovery.expiresAt)}`;
    appState.$btnUndo.disabled = !s.history?.length;
  } else if (last) {
    appState.$undoNote.textContent = `Последнее: ${last.label}`;
    appState.$btnUndo.disabled = false;
  } else {
    appState.$undoNote.textContent = "История пуста";
    appState.$btnUndo.disabled = true;
  }
  if (appState.$reportsModal?.classList.contains("modal--open"))
    renderReports();
}
