import { state as appState } from "./state.js";

const messages = {
  tariff_price_changed: 'Цена или длительность тарифа изменилась. Загрузите актуальное состояние.',
  product_type_immutable: 'Тип позиции нельзя менять после создания. Создайте отдельную услугу или товар.',
  station_type_immutable: 'Тип станции задаёт владелец в настройках.',
  pass_command_required: 'Минуты абонемента выдаются через раздел «Клиенты и абонементы».',
  session_immutable: 'Историческую сессию нельзя переносить или изменять её начало.',
  invalid_backup_schema: 'Структура файла отличается от резервной копии PS Lounge.',
  backup_version_mismatch: 'Версия копии несовместима с этой программой.',

  login_required: "Войдите в учётную запись сотрудника.",
  invalid_credentials: "Неверный логин или пароль.",
  login_locked: "Слишком много попыток входа. Повторите через 5 минут.",
  csrf_required: "Сеанс изменился. Обновите страницу и войдите снова.",
  owner_required: "Это действие доступно владельцу.",
  shift_required: "Сначала откройте смену в разделе «Касса».",
  another_operator_shift: "Открыта смена другого сотрудника. Завершите её перед новым входом в смену.",
  shift_already_open: "Смена уже открыта. Обновите данные.",
  difference_reason_required: "Укажите причину расхождения кассы.",
  insufficient_cash: "Недостаточно наличных в кассе.",
  payment_not_found: "Выберите оплату для возврата.",
  insufficient_stock: "Недостаточно товара на складе.",
  insufficient_minutes: "На абонементе недостаточно минут.",
  price_changed: "Цена товара изменилась. Обновите данные перед продажей.",
  revision_conflict: "Данные изменились в другом окне. Сохраните локальную копию и загрузите актуальное состояние.",
  payment_immutable: "Оплаченные операции нельзя изменять. Оформите возврат в кассе.",
  refund_exceeds_payment: "Сумма возврата превышает остаток оплаты.",
  pass_refund_requires_unused_balance: "Абонемент можно вернуть полностью при достаточном остатке минут.",
  restock_requires_full_refund: "Возврат товара на склад доступен при полном возврате оплаты.",
  last_owner: "Нельзя отключить последнего владельца.",
  password_too_short: "Пароль должен содержать от 8 до 128 символов.",
  text_required: "Заполните обязательное поле.",
  invalid_quantity: "Укажите целое положительное количество.",
  already_configured: "Владелец уже создан. Войдите с существующим логином.",
  demo_export_unavailable: "В демонстрации экспорт рабочих файлов недоступен.",
  last_owner_required: "Нельзя отключить последнего владельца.",
  login_exists: "Этот логин уже занят.",
  invalid_login: "Логин: 3–40 букв, цифр, точек, дефисов или знаков подчёркивания.",
  invalid_password: "Пароль должен содержать от 8 до 128 символов.",
  invalid_amount: "Укажите корректную сумму с точностью до копейки.",
  invalid_integer: "Укажите целое число в допустимом диапазоне.",
  invalid_backup: "Файл резервной копии повреждён или несовместим.",
  network_error: "Нет связи с программой. Проверьте подключение и повторите действие.",
  save_required: "Сначала сохраните изменения. Проверьте индикатор сохранения.",
  account_already_configured: "Учётная запись владельца уже создана. Войдите с её логином.",
};

export function businessErrorMessage(error) {
  return messages[error?.code || error?.message] || "Не удалось выполнить действие. Обновите данные и попробуйте снова.";
}

export async function apiRequest(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body && typeof options.body !== "string" && !(options.body instanceof Blob)) {
    headers.set("Content-Type", "application/json");
    options = { ...options, body: JSON.stringify(options.body) };
  }
  if (options.method && options.method !== "GET") headers.set("X-PSLounge-CSRF", appState.csrf || "");
  let response;
  try {
    response = await fetch(path, { cache: "no-store", credentials: "same-origin", ...options, headers });
  } catch {
    const error = new Error("network_error");
    error.code = "network_error";
    throw error;
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) {
    const error = new Error(payload.error || "request_failed");
    Object.assign(error, { code: payload.error || "request_failed", status: response.status, payload });
    throw error;
  }
  return payload;
}

const pendingCommands = new Map();

export async function businessCommand(operation, data) {
  const fingerprint = JSON.stringify({ operation, data });
  const key = pendingCommands.get(fingerprint) || globalThis.crypto?.randomUUID?.() || `operation-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  pendingCommands.set(fingerprint, key);
  const options = { method: "POST", headers: { "X-Idempotency-Key": key }, body: data };
  try {
    let result;
    try { result = await apiRequest(`/api/business/${operation}`, options); }
    catch (error) {
      // A lost response may follow a committed sale. Retrying the same key is safe.
      if (error.code !== "network_error" && !(error.status >= 500)) throw error;
      result = await apiRequest(`/api/business/${operation}`, options);
    }
    pendingCommands.delete(fingerprint);
    return result;
  } catch (error) {
    // Keep uncertain commands for a manual retry; validation failures were rejected.
    if (error.status && error.status < 500) pendingCommands.delete(fingerprint);
    throw error;
  }
}
