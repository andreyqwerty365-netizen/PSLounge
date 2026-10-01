import { apiRequest, businessCommand, businessErrorMessage } from "./business-api.js";
import { logoutAccount } from "./business-auth.js";
import { applyServerState, flushBackupNow } from "./persistence.js";
import { requestSettingsAccess } from "./settings-access.js";
import { todayKey } from "./sessions.js";
import { state as appState } from "./state.js";
import { storage } from "./storage.js";
import { renderStations, syncControl } from "./ui-rendering.js";
import { toast } from "./ui-utils.js";

let tab = "shift";
let initialized = false;
let refreshing;
let busy = false;
let busyControls = new Map();
let previousFocus;
const labels = { cash: "Наличные", card: "Карта", transfer: "Перевод", game: "Игровое время", product: "Товар", pass: "Абонемент", refund: "Возврат", cash_in: "Внесение", cash_out: "Изъятие" };
const auditLabels = { owner_created: "Создан владелец", user_created: "Создан сотрудник", user_updated: "Обновлён сотрудник", login: "Вход сотрудника", shift_opened: "Открыта смена", shift_closed: "Закрыта смена", state_saved: "Сохранены сессии", legacy_migrated: "Перенесена история", cash_in: "Внесение наличных", cash_out: "Изъятие наличных", refund: "Возврат оплаты", product_saved: "Обновлён товар", product_sold: "Продажа товара", customer_created: "Создан клиент", pass_sold: "Продан абонемент", pass_redeemed: "Использован абонемент", database_restored: "Восстановлена резервная копия" };
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const rub = (cents) => new Intl.NumberFormat("ru-RU", { style: "currency", currency: "RUB", maximumFractionDigits: 2 }).format(Number(cents || 0) / 100);
const date = (time) => time ? new Date(time).toLocaleString("ru-RU", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "—";
const empty = (text) => `<div class="businessEmpty">${esc(text)}</div>`;
const field = (label, name, attributes = "", value = "") => `<label class="field"><span class="field__label">${label}</span><input class="field__input" name="${name}" value="${esc(value)}" ${attributes} /></label>`;
const select = (label, name, options) => `<label class="field"><span class="field__label">${label}</span><select class="field__input" name="${name}" required>${options}</select></label>`;
const option = (id, label) => `<option value="${esc(id)}">${esc(label)}</option>`;
const methods = () => select("Способ оплаты", "method", Object.entries(labels).filter(([key]) => ["cash", "card", "transfer"].includes(key)).map(([key, name]) => option(key, name)).join(""));
const submit = (label) => `<p class="businessError" role="alert"></p><button class="btn btn--primary" type="submit">${label}</button>`;
const form = (operation, content) => `<form class="businessForm" data-operation="${operation}">${content}</form>`;
const metric = (label, value, hint = "") => `<div class="businessMetric"><span>${esc(label)}</span><strong>${esc(value)}</strong>${hint ? `<small>${esc(hint)}</small>` : ""}</div>`;
const demo = () => document.body.dataset.demo === "true";
const ledgerDownload = () => demo() ? '<button class="btn btn--soft btn--mini" data-action="demo-export" type="button">История оплат · CSV</button>' : '<a class="btn btn--soft btn--mini" href="/api/business-ledger.csv" download>Скачать всю историю · CSV</a>';
const owner = () => appState.user?.role === "owner";
const business = () => appState.business || { products: [], customers: [], payments: [], users: [], shifts: [], audit: [], totals: [] };

export function canTakePayment(showCash = true) {
  let message = "";
  if (!appState.user) message = "Войдите в учётную запись сотрудника.";
  else if (appState.businessStale) message = "Обновите данные кассы перед следующей оплатой.";
  else if (appState.saveConflict || appState.saveFailed) message = "Сначала восстановите сохранение данных. Проверьте индикатор сохранения.";
  else if (!appState.activeShift) message = "Сначала откройте смену в разделе «Касса».";
  else if (!owner() && appState.activeShift.opened_by !== appState.user.id) message = "Открыта смена другого сотрудника.";
  if (message) {
    toast(message);
    if (showCash && appState.user && !appState.activeShift) void openBusiness("shift");
    return false;
  }
  return true;
}

function renderAccount() {
  const active = appState.activeShift;
  const badge = document.getElementById("accountBadge");
  if (badge) badge.textContent = appState.user ? `${appState.user.name} · ${owner() ? "Владелец" : "Оператор"}` : "Вход не выполнен";
  const status = document.getElementById("shiftBadge");
  if (status) {
    status.textContent = active ? `Смена открыта · ${active.operator}` : "Смена закрыта";
    status.dataset.state = active ? "open" : "closed";
  }
  document.getElementById("btnSettings")?.toggleAttribute("hidden", !owner());
}

export async function refreshBusiness() {
  if (!appState.user) return;
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const result = await apiRequest("/api/business");
    appState.business = result;
    appState.businessStale = false;
    if (result.user) appState.user = result.user;
    appState.activeShift = result.activeShift;
    renderAccount();
    return result;
  })();
  try { return await refreshing; } finally { refreshing = null; }
}

function renderShift() {
  const active = appState.activeShift;
  const setup = appState.justConfigured ? `<div class="businessSetup"><div><strong>Учётная запись готова</strong><p class="businessHint">Проверьте станции и действующие цены, затем откройте первую смену.</p></div><button class="btn btn--soft btn--mini" data-action="settings" type="button">Настроить станции</button></div>` : "";
  if (!active) return `${setup}<div class="businessColumns"><section class="businessCard"><h3>Начать смену</h3><p class="businessHint">Укажите наличные в кассе перед началом работы. Продажи будут закреплены за этой сменой и сотрудником.</p>${form("shifts/open", field("Наличные на начало, ₽", "opening", 'type="number" min="0" step="0.01" required', "0") + submit("Открыть смену"))}</section><section class="businessCard"><h3>История сохраняется</h3><p class="businessHint">Закрытие смены фиксирует выручку и результат пересчёта кассы. Сессии и оплаты остаются в истории.</p>${shiftHistory()}</section></div>`;
  const other = !owner() && active.opened_by !== appState.user.id;
  return `${setup}<div class="businessMetrics">${metric("Выручка смены", rub(active.revenue_cents), "Продажи за вычетом возвратов")}${metric("Наличные в кассе", rub(active.expected_cents), "Начальный остаток + операции")}${metric("Карта и перевод", rub(active.totals.card + active.totals.transfer), active.operator)}</div>${other ? empty("Смена открыта другим сотрудником. Кассовые операции доступны ему или владельцу.") : `<div class="businessColumns"><section class="businessCard"><h3>Закрытие смены</h3><p class="businessHint">Пересчитайте наличные. При расхождении укажите причину. Активные игровые сессии продолжат работу.</p>${form("shifts/close", field("Наличные по факту, ₽", "actual", 'type="number" min="0" step="0.01" required', (active.expected_cents / 100).toFixed(2)) + field("Комментарий / причина расхождения", "note", 'maxlength="500"') + submit("Зафиксировать и закрыть"))}</section><section class="businessCard"><h3>Движение наличных</h3><p class="businessHint">Инкассация и пополнение отражаются отдельно от продаж.</p>${form("cash", select("Операция", "kind", option("cash_in", "Внести наличные") + option("cash_out", "Изъять наличные")) + field("Сумма, ₽", "amount", 'type="number" min="0.01" step="0.01" required') + field("Причина", "reason", 'required maxlength="500"') + submit("Провести операцию"))}</section></div>`}<section class="businessCard businessSectionGap"><h3>Последние смены</h3>${shiftHistory()}</section>`;
}

function shiftHistory() {
  const rows = business().shifts;
  return rows.length ? `<div class="businessList">${rows.map((shift) => `<div class="businessRow"><div><strong>${esc(shift.operator)} · ${date(shift.opened_at)}</strong><small>${shift.closed_at ? `Закрыта ${date(shift.closed_at)} · расхождение ${rub(shift.difference_cents)}` : "Открыта"}${shift.note ? ` · ${esc(shift.note)}` : ""}</small></div><strong>${rub(shift.revenue_cents)}</strong></div>`).join("")}</div>` : empty("Первые смены появятся здесь после начала работы.");
}

function renderProducts() {
  const products = business().products;
  const available = products.filter((product) => product.active && (!product.track_stock || product.stock > 0));
  const sale = available.length ? form("products/sell", select("Товар", "productId", available.map((product) => option(product.id, `${product.name} · ${rub(product.price_cents)} · ${product.track_stock ? `${product.stock} шт.` : "услуга"}`)).join("")) + field("Количество", "quantity", 'type="number" min="1" step="1" required', "1") + methods() + submit("Продать товар")) : empty("Добавьте товары с остатком, чтобы начать продажи.");
  const management = owner() ? `<section class="businessCard"><h3>Каталог и остатки</h3><p class="businessHint">Напитки, снеки, аксессуары и дополнительные услуги с учётом количества.</p>${form("products/save", '<input name="id" type="hidden" />' + field("Название", "name", 'required maxlength="160"') + `<div class="businessTwoFields">${field("Цена, ₽", "price", 'type="number" min="0" step="0.01" required')}${field("Остаток, шт.", "stock", 'type="number" min="0" step="1" required', "0")}</div>` + '<label class="businessCheck"><input name="trackStock" type="checkbox" checked /> Учитывать остаток (снимите для услуги)</label>' + field("Причина изменения остатка", "reason", 'maxlength="500"', "Поступление товара") + '<label class="businessCheck"><input name="active" type="checkbox" checked /> Доступен для продажи</label>' + submit("Сохранить товар"))}</section>` : "";
  return `<div class="businessColumns"><section class="businessCard"><h3>Быстрая продажа</h3><p class="businessHint">Оплата сразу попадает в текущую смену, остаток уменьшается автоматически.</p>${sale}</section>${management}<section class="businessCard businessFull"><h3>Товары · ${products.length}</h3>${products.length ? `<div class="businessList">${products.map((product) => `<div class="businessRow"><div><strong>${esc(product.name)}${product.active ? "" : " · скрыт"}</strong><small>${rub(product.price_cents)} · ${product.track_stock ? `остаток ${product.stock} шт.` : "услуга · без ограничения остатка"}</small></div>${owner() ? `<button class="btn btn--ghost btn--mini" data-action="edit-product" data-id="${esc(product.id)}" type="button">Изменить</button>` : ""}</div>`).join("")}</div>` : empty("Каталог пока пуст.")}</section></div>`;
}

function renderPasses() {
  const customers = business().customers;
  const customerOptions = customers.map((customer) => option(customer.id, `${customer.name} · ${customer.minutes} мин`)).join("");
  return `<div class="businessColumns"><section class="businessCard"><h3>Новый клиент</h3><p class="businessHint">Карточка клиента хранит баланс минут и историю операций.</p>${form("customers/create", field("Имя клиента", "name", 'required maxlength="80"') + field("Телефон / контакт", "contact", 'maxlength="100" autocomplete="tel"') + submit("Создать клиента"))}</section><section class="businessCard"><h3>Продать абонемент</h3><p class="businessHint">Продайте пакет минут и принимайте оплату выбранным способом.</p>${customers.length ? form("passes/sell", select("Клиент", "customerId", customerOptions) + `<div class="businessTwoFields">${field("Минуты", "minutes", 'type="number" min="1" step="1" required', "600")}${field("Стоимость, ₽", "amount", 'type="number" min="0.01" step="0.01" required')}</div>` + methods() + submit("Продать абонемент")) : empty("Сначала создайте карточку клиента.")}</section><section class="businessCard"><h3>Использовать минуты</h3><p class="businessHint">Минуты списываются с баланса и добавляются к выбранной станции. Повторная оплата не создаётся.</p>${customers.length ? form("passes/redeem", select("Клиент", "customerId", customerOptions) + select("Станция", "stationId", appState.stations.map((station) => option(station.id, `${station.name} · ${station.status === "idle" ? "свободна" : "продлить"}`)).join("")) + field("Минуты", "minutes", 'type="number" min="1" step="1" required', "60") + submit("Списать минуты и запустить")) : empty("Клиенты с абонементом появятся здесь.")}</section><section class="businessCard"><h3>Клиенты · ${customers.length}</h3>${customers.length ? `<div class="businessList">${customers.map((customer) => `<div class="businessRow"><div><strong>${esc(customer.name)}</strong><small>${esc(customer.contact || "Контакт не указан")}</small></div><strong>${customer.minutes} мин</strong></div>`).join("")}</div>` : empty("База клиентов пока пуста.")}</section></div>`;
}

function renderDashboard() {
  const totals = business().totals.filter((entry) => !entry.imported && !["cash_in", "cash_out"].includes(entry.kind));
  const total = totals.reduce((sum, entry) => sum + entry.cents, 0);
  const product = totals.filter((entry) => entry.kind === "product").reduce((sum, entry) => sum + entry.cents, 0);
  const passes = totals.filter((entry) => entry.kind === "pass").reduce((sum, entry) => sum + entry.cents, 0);
  const imported = business().totals.filter((entry) => entry.imported).reduce((sum, entry) => sum + entry.cents, 0);
  const utilization = appState.stations.filter((station) => station.status !== "idle").length;
  return `<div class="businessMetrics">${metric("Записанная выручка", rub(total), "Все смены · продажи минус возвраты")}${metric("Товары и абонементы", rub(product + passes), `Товары ${rub(product)} · абонементы ${rub(passes)}`)}${metric("Занято станций", `${utilization} / ${appState.stations.length}`, "Текущее состояние клуба")}</div><p class="businessHint">Перенесённая история: ${rub(imported)}. Она показана отдельно и не включена в новые смены. Выручка не учитывает расходы и не является прибылью.</p><div class="businessColumns"><section class="businessCard"><h3>Смены и расхождения</h3>${shiftHistory()}</section><section class="businessCard"><h3>Последние оплаты</h3>${paymentHistory(false)}</section></div>`;
}

function paymentHistory(refunds = true) {
  const rows = business().payments;
  return rows.length ? `<div class="businessList">${rows.map((payment) => `<div class="businessRow"><div><strong>${esc(labels[payment.kind] || payment.kind)} · ${rub(payment.amount_cents)}</strong><small>${date(payment.created_at)} · ${esc(labels[payment.method] || payment.method)} · ${esc(payment.operator || "Перенесённая история")}</small><small>${esc(payment.details?.name || payment.details?.reason || payment.details?.sale?.label || "")}</small></div>${refunds && owner() && payment.refundable_cents > 0 && ["game", "product", "pass"].includes(payment.kind) ? `<button class="btn btn--ghost btn--mini" data-action="refund" data-id="${esc(payment.id)}" type="button">Возврат</button>` : ""}</div>`).join("")}</div>` : empty("Оплаты появятся после первой продажи.");
}

function renderLedger() {
  return `<div class="businessColumns"><section class="businessCard"><h3>Оплаты и возвраты</h3><p class="businessHint">Последние 100 операций. Каждая оплата остаётся в истории; возврат записывается отдельной операцией в текущей смене.</p>${owner() ? ledgerDownload() : ""}${paymentHistory()}</section>${owner() ? `<section class="businessCard"><h3>Возврат оплаты</h3><p class="businessHint">Выберите оплату слева. Причина обязательна. Возврат абонемента допускается полностью при достаточном остатке минут.</p>${form("refund", '<input name="paymentId" type="hidden" required /><div class="businessHint" id="refundPaymentLabel">Оплата не выбрана</div>' + field("Сумма возврата, ₽", "amount", 'type="number" min="0.01" step="0.01" required') + field("Причина", "reason", 'required maxlength="500"') + '<label class="businessCheck"><input name="restock" type="checkbox" /> Вернуть товар на склад при полном возврате</label>' + submit("Оформить возврат"))}</section>` : `<section class="businessCard"><h3>Возвраты проводит владелец</h3><p class="businessHint">Сотрудник видит свои оплаты. Для возврата обратитесь к владельцу, который подтвердит сумму и причину.</p></section>`}</div>`;
}

function renderUsers() {
  const users = business().users;
  return `<div class="businessColumns"><section class="businessCard"><h3 id="userFormHeading">Новый сотрудник</h3><p class="businessHint">Оператор принимает оплаты и работает в своей смене. Владелец управляет кассой, настройками и сотрудниками.</p>${form("users/create", '<input name="id" type="hidden" />' + field("Имя", "name", 'required maxlength="80"') + field("Логин", "login", 'required minlength="3" maxlength="40" autocomplete="off"') + field("Пароль · от 8 символов", "password", 'type="password" required minlength="8" maxlength="128" autocomplete="new-password"') + select("Роль", "role", option("operator", "Оператор") + option("owner", "Владелец")) + '<label class="businessCheck"><input name="active" type="checkbox" checked /> Учётная запись активна</label>' + submit("Сохранить сотрудника"))}</section><section class="businessCard"><h3>Команда · ${users.length}</h3><div class="businessList">${users.map((user) => `<div class="businessRow"><div><strong>${esc(user.name)}</strong><small>${esc(user.login)} · ${user.role === "owner" ? "Владелец" : "Оператор"}${user.active ? "" : " · отключён"}</small></div><button class="btn btn--ghost btn--mini" data-action="edit-user" data-id="${esc(user.id)}" type="button">Изменить</button></div>`).join("")}</div><button class="btn btn--ghost btn--mini businessSectionGap" data-action="new-user" type="button">Добавить нового</button></section></div>`;
}

function renderBackups() {
  const automatic = business().backupStatus === "failed" ? "Последняя суточная копия не создана. Скачайте резервную копию вручную и проверьте свободное место." : business().backupStatus ? `Последняя суточная копия: ${business().backupStatus}. Программа сохраняет копию базы автоматически раз в сутки.` : "Программа сохраняет копию базы автоматически раз в сутки.";
  return `<div class="businessColumns"><section class="businessCard"><h3>Полная резервная копия</h3><p class="businessHint">Включает станции, сессии, сотрудников, смены, оплаты, остатки товаров и абонементы. Храните копии на другом носителе.</p><p class="${business().backupStatus === "failed" ? "businessError" : "businessHint"}">${esc(automatic)}</p><div class="businessDownloads"><button class="btn btn--primary" data-action="download-backup" type="button">Скачать копию базы</button>${ledgerDownload()}</div><p class="businessHint">Копия содержит учётные записи и контакты клиентов. Передавайте её только доверенным сотрудникам.</p></section><section class="businessCard"><h3>Восстановление</h3><p class="businessHint">Заменяет текущую базу выбранной копией. Перед заменой программа автоматически сохраняет текущую базу. После восстановления потребуется повторный вход.</p><form class="businessForm" id="businessRestoreForm"><label class="field"><span class="field__label">Файл копии .sqlite3</span><input class="field__input" name="backup" type="file" accept=".sqlite3,.db" required /></label><p class="businessError" role="alert"></p><button class="btn btn--ghost businessDanger" type="submit">Восстановить базу</button></form></section><section class="businessCard businessFull"><h3>Аудит действий</h3><p class="businessHint">Последние 100 событий. Финансовая история сохраняется полностью.</p>${business().audit.length ? `<div class="businessList">${business().audit.map((entry) => `<div class="businessRow"><div><strong>${esc(auditLabels[entry.action] || entry.action)}</strong><small>${date(entry.created_at)} · ${esc(entry.operator || "Система")}</small><details><summary class="businessHint">Детали</summary><div class="businessAuditDetails">${esc(entry.details)}</div></details></div></div>`).join("")}</div>` : empty("События пока отсутствуют.")}</section></div>`;
}

function render() {
  const tabs = [["shift", "Касса"], ["products", "Товары"], ["passes", "Клиенты и абонементы"], ["ledger", "Оплаты"]];
  if (owner()) tabs.push(["dashboard", "Обзор владельца"], ["users", "Сотрудники"], ["backups", "Копии и аудит"]);
  if (!tabs.some(([key]) => key === tab)) tab = "shift";
  document.getElementById("businessTabs").innerHTML = tabs.map(([key, name]) => `<button class="businessTab" data-tab="${key}" aria-current="${tab === key ? "page" : "false"}" type="button">${name}</button>`).join("");
  document.getElementById("businessSubtitle").textContent = appState.activeShift ? `Смена ${appState.activeShift.operator} · открыта ${date(appState.activeShift.opened_at)}` : "Откройте смену, чтобы принимать оплаты";
  const panels = { shift: renderShift, products: renderProducts, passes: renderPasses, dashboard: renderDashboard, ledger: renderLedger, users: renderUsers, backups: renderBackups };
  document.getElementById("businessContent").innerHTML = panels[tab]();
  document.getElementById("businessError").textContent = "";
}

export async function openBusiness(next = "shift") {
  if (busy) return;
  initBusinessUI();
  tab = next;
  const dialog = document.getElementById("businessDialog");
  previousFocus = document.activeElement;
  try {
    await refreshBusiness();
    render();
    if (!dialog.open) dialog.showModal();
  } catch (error) { toast(businessErrorMessage(error)); }
}

function closeBusiness() {
  if (busy) return;
  document.getElementById("businessDialog")?.close();
  previousFocus?.focus?.();
}

export function confirmBusiness(message, heading = "Подтверждение") {
  const dialog = document.getElementById("businessConfirm");
  document.getElementById("businessConfirmHeading").textContent = heading;
  document.getElementById("businessConfirmText").textContent = message;
  const previous = document.activeElement;
  return new Promise((resolve) => {
    let accepted = false;
    const accept = document.getElementById("businessConfirmAccept");
    const cancel = document.getElementById("businessConfirmCancel");
    const acceptHandler = () => { accepted = true; dialog.close(); };
    const cancelHandler = () => dialog.close();
    const cleanup = () => {
      accept.removeEventListener("click", acceptHandler);
      cancel.removeEventListener("click", cancelHandler);
      previous?.focus?.();
      resolve(accepted);
    };
    accept.addEventListener("click", acceptHandler);
    cancel.addEventListener("click", cancelHandler);
    dialog.addEventListener("close", cleanup, { once: true });
    dialog.showModal();
    cancel.focus();
  });
}

function setBusinessBusy(value) {
  busy = value;
  const dialog = document.getElementById("businessDialog");
  dialog.setAttribute("aria-busy", String(value));
  if (value) {
    busyControls = new Map();
    for (const control of dialog.querySelectorAll("button,input,select,textarea")) {
      busyControls.set(control, control.disabled);
      control.disabled = true;
    }
  } else {
    for (const [control, disabled] of busyControls) if (control.isConnected) control.disabled = disabled;
    busyControls.clear();
  }
}

async function handleSubmit(event) {
  const target = event.target;
  if (!(target instanceof HTMLFormElement)) return;
  event.preventDefault();
  const button = target.querySelector('[type="submit"]');
  if (!button || button.disabled || busy) return;
  const submittedData = new FormData(target);
  const errorLabel = target.querySelector(".businessError");
  errorLabel.textContent = "";
  setBusinessBusy(true);
  try {
    if (target.id === "businessRestoreForm") {
      if (demo()) throw new Error("demo_export_unavailable");
      if (!(await flushBackupNow())) throw new Error("save_required");
      const file = target.elements.namedItem("backup").files[0];
      if (!file || file.size > 32 * 1024 * 1024) throw new Error("invalid_backup");
      if (!(await confirmBusiness("Текущая база будет заменена выбранной копией. Программа сохранит текущую базу перед восстановлением. Продолжить?", "Восстановить базу?"))) return;
      await apiRequest("/api/business-restore", { method: "POST", headers: { "Content-Type": "application/vnd.sqlite3" }, body: file });
      appState.user = null;
      window.location.reload();
      return;
    }
    const operation = target.dataset.operation;
    if (!operation) return;
    const data = Object.fromEntries(submittedData);
    const financial = !["products/save", "customers/create", "users/create", "users/save"].includes(operation);
    if (financial && !(await flushBackupNow())) throw new Error("save_required");
    if (financial && operation !== "shifts/open" && !canTakePayment(false)) return;
    if (["quantity", "stock", "minutes"].some((key) => key in data)) {
      for (const key of ["quantity", "stock", "minutes"]) if (key in data) data[key] = Number(data[key]);
    }
    if (operation === "products/save" || operation.startsWith("users/")) data.active = target.elements.namedItem("active").checked;
    if (operation === "products/save") data.trackStock = target.elements.namedItem("trackStock").checked;
    if (operation === "refund") data.restock = target.elements.namedItem("restock").checked;
    if (operation === "products/sell") data.expectedPriceCents = business().products.find((product) => product.id === data.productId)?.price_cents;
    if (operation === "passes/redeem") {
      const station = appState.stations.find((item) => String(item.id) === String(data.stationId));
      data.stationId = station?.id;
      data.baseRevision = appState.serverRevision;
      data.day = todayKey();
    }
    if (!data.id) delete data.id;
    if (operation === "users/save" && !data.password) delete data.password;
    if (["shifts/close", "refund"].includes(operation) && !(await confirmBusiness(operation === "refund" ? `Оформить возврат ${data.amount} ₽? Он будет записан отдельной операцией в текущей смене.` : "Закрыть смену и зафиксировать результат пересчёта кассы?", operation === "refund" ? "Возврат оплаты" : "Закрытие смены"))) return;
    const result = await businessCommand(operation, data);
    if (operation === "shifts/open") appState.justConfigured = false;
    if (result.state) {
      applyServerState(result.state);
      renderStations(true);
      syncControl();
    }
    try {
      await refreshBusiness();
      render();
    } catch (refreshError) {
      // The command was committed. A status failure must not invite a duplicate sale.
      appState.businessStale = true;
      if (operation === "shifts/close") appState.activeShift = null;
      render();
      document.getElementById("businessError").textContent = "Операция сохранена. Не удалось обновить данные; нажмите «Обновить» перед следующей оплатой.";
    }
    toast(operation === "shifts/close" ? "Смена закрыта. История сохранена." : operation === "shifts/open" ? "Смена открыта" : operation === "passes/redeem" ? "Минуты списаны. Станция запущена." : "Операция сохранена");
  } catch (error) {
    errorLabel.textContent = businessErrorMessage(error);
    if (!errorLabel.isConnected) document.getElementById("businessError").textContent = businessErrorMessage(error);
  } finally { setBusinessBusy(false); }
}

async function handleAction(event) {
  if (busy) return;
  const action = event.target.closest("[data-action]");
  if (!action) return;
  const id = action.dataset.id;
  if (action.dataset.action === "demo-export") { toast("В демонстрации экспорт рабочих файлов недоступен."); }
  else if (action.dataset.action === "settings") { closeBusiness(); requestSettingsAccess(); }
  else if (action.dataset.action === "new-user") render();
  else if (action.dataset.action === "edit-product") {
    const product = business().products.find((item) => item.id === id);
    const target = document.querySelector('[data-operation="products/save"]');
    for (const [key, value] of Object.entries({ id, name: product.name, price: product.price_cents / 100, stock: product.stock, reason: "" })) target.elements.namedItem(key).value = value;
    target.elements.namedItem("active").checked = !!product.active;
    target.elements.namedItem("trackStock").checked = !!product.track_stock;
    target.elements.namedItem("trackStock").disabled = true;
    target.elements.namedItem("stock").closest("label").hidden = !product.track_stock;
    target.elements.namedItem("name").focus();
    target.scrollIntoView({ behavior: "smooth", block: "nearest" });
  } else if (action.dataset.action === "edit-user") {
    const user = business().users.find((item) => item.id === id);
    const target = document.querySelector('[data-operation^="users/"]');
    target.dataset.operation = "users/save";
    for (const [key, value] of Object.entries({ id, name: user.name, login: user.login, role: user.role, password: "" })) target.elements.namedItem(key).value = value;
    target.elements.namedItem("login").readOnly = true;
    target.elements.namedItem("password").required = false;
    target.elements.namedItem("active").checked = !!user.active;
    document.getElementById("userFormHeading").textContent = "Изменить сотрудника";
    target.elements.namedItem("name").focus();
  } else if (action.dataset.action === "refund") {
    const payment = business().payments.find((item) => item.id === id);
    const target = document.querySelector('[data-operation="refund"]');
    target.elements.namedItem("paymentId").value = id;
    target.elements.namedItem("amount").value = (payment.refundable_cents / 100).toFixed(2);
    target.elements.namedItem("amount").max = payment.refundable_cents / 100;
    target.elements.namedItem("restock").disabled = payment.kind !== "product";
    target.elements.namedItem("restock").checked = false;
    document.getElementById("refundPaymentLabel").textContent = `${labels[payment.kind]} · ${date(payment.created_at)} · остаток ${rub(payment.refundable_cents)}`;
    target.elements.namedItem("reason").focus();
    target.scrollIntoView({ behavior: "smooth", block: "nearest" });
  } else if (action.dataset.action === "download-backup") {
    action.disabled = true;
    try {
      if (demo()) throw new Error("demo_export_unavailable");
      if (!(await flushBackupNow())) throw new Error("save_required");
      const response = await fetch("/api/business-backup.sqlite3", { cache: "no-store", credentials: "same-origin" });
      if (!response.ok) throw new Error("network_error");
      const objectUrl = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = `PSLounge_Backup_${todayKey()}.sqlite3`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
      toast("Копия подготовлена к скачиванию");
    } catch (error) { document.getElementById("businessError").textContent = businessErrorMessage(error); }
    finally { action.disabled = false; }
  }
}


function downloadUnsaved() {
  const data = { exportedAt: new Date().toISOString(), baseRevision: appState.serverRevision,
    lastModified: appState.lastModified, stations: appState.stations, sessions: appState.sessions,
    settings: appState.settings, achievements: appState.achievements };
  const objectUrl = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = objectUrl; link.download = `PSLounge_Unsaved_${Date.now()}.json`; link.click();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}

function setPreference(key, checked) {
  try { storage.setItem(key, checked ? "1" : "0"); } catch {}
}

export function initBusinessUI() {
  if (initialized) return;
  initialized = true;
  window.addEventListener('pslounge-cache-error', () => {
    if (!appState.cacheWarningShown) {
      appState.cacheWarningShown = true;
      toast('Кэш браузера недоступен. Данные записываются в базу; дождитесь статуса сохранения.', 5000);
    }
  });
  document.getElementById("businessDialog")?.addEventListener("cancel", (event) => { if (busy) event.preventDefault(); });
  document.getElementById("btnBusiness")?.addEventListener("click", () => void openBusiness());
  document.getElementById("businessClose")?.addEventListener("click", closeBusiness);
  document.getElementById("businessRefresh")?.addEventListener("click", async (event) => {
    if (busy) return;
    setBusinessBusy(true);
    try { await refreshBusiness(); render(); } catch (error) { document.getElementById("businessError").textContent = businessErrorMessage(error); }
    finally { setBusinessBusy(false); }
  });
  document.getElementById("businessTabs")?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-tab]");
    if (button && !busy) { tab = button.dataset.tab; render(); }
  });
  document.getElementById("businessContent")?.addEventListener("submit", handleSubmit);
  document.getElementById("businessContent")?.addEventListener("click", handleAction);
  document.getElementById("businessContent")?.addEventListener("change", (event) => {
    if (event.target.name === "trackStock") event.target.form.elements.namedItem("stock").closest("label").hidden = !event.target.checked;
  });
  document.getElementById("btnDownloadUnsaved")?.addEventListener("click", downloadUnsaved);
  document.getElementById("btnRetrySave")?.addEventListener("click", async (event) => {
    const button = event.currentTarget; button.disabled = true;
    try { if (await flushBackupNow()) { await refreshBusiness(); toast("Изменения сохранены"); } } finally { button.disabled = false; }
  });
  document.getElementById("btnReloadState")?.addEventListener("click", async () => {
    if (!(await confirmBusiness("Несохранённые изменения будут скачаны отдельным JSON-файлом. Затем загрузится актуальное состояние из базы программы.", "Обновить состояние?"))) return;
    downloadUnsaved();
    try {
      const snapshot = await apiRequest("/api/backup");
      applyServerState(snapshot); renderStations(true); syncControl();
      await refreshBusiness(); toast("Актуальное состояние загружено");
    } catch (error) { toast(businessErrorMessage(error)); }
  });
  setInterval(() => {
    if (appState.user && !document.hidden) void refreshBusiness().catch(() => {});
  }, 30000);
  document.getElementById("btnAccountLogout")?.addEventListener("click", async () => {
    if (!(await confirmBusiness("Завершить работу под этой учётной записью? Открытая смена останется закреплена за сотрудником.", "Выход сотрудника"))) return;
    try { await logoutAccount(); } catch (error) { toast(businessErrorMessage(error)); }
  });
  for (const [id, key, className] of [["compactMode", "pslounge_compact", "businessCompact"], ["hideAchievements", "pslounge_hide_achievements", "businessHideAchievements"]]) {
    const control = document.getElementById(id);
    if (!control) continue;
    let enabled = false;
    try { enabled = storage.getItem(key) === "1"; } catch {}
    control.checked = enabled;
    document.body.classList.toggle(className, enabled);
    control.addEventListener("change", () => { document.body.classList.toggle(className, control.checked); setPreference(key, control.checked); });
  }
  renderAccount();
  if (appState.justConfigured) setTimeout(() => void openBusiness("shift"), 300);
}
