import { apiRequest, businessErrorMessage } from "./business-api.js";
import { state as appState } from "./state.js";
import { flushBackupNow } from "./persistence.js";
import { toast } from "./ui-utils.js";

let ready;
let resolveReady;
let bound = false;

function showGate(configured) {
  const gate = document.getElementById("accountGate");
  if (!gate) throw new Error("account_gate_missing");
  gate.hidden = false;
  appState.$appShell?.classList.add("app--shell-hidden");
  document.getElementById("accountHeading").textContent = configured ? "Вход сотрудника" : "Добро пожаловать в PS Lounge";
  document.getElementById("accountLead").textContent = configured
    ? "Войдите, чтобы открыть смену и продолжить работу."
    : "Создайте учётную запись владельца. Она управляет сотрудниками, кассой и настройками.";
  const form = document.getElementById("accountForm");
  form.dataset.setup = configured ? "false" : "true";
  const name = form.elements.namedItem("name");
  name.closest("label").hidden = configured;
  name.required = !configured;
  form.elements.namedItem("password").autocomplete = configured ? "current-password" : "new-password";
  document.getElementById("accountSubmit").textContent = configured ? "Войти" : "Создать владельца";
  document.getElementById("accountError").textContent = "";
  setTimeout(() => (configured ? form.elements.namedItem("login") : name).focus(), 0);
}

function accept(payload) {
  appState.user = payload.user;
  appState.csrf = payload.csrf;
  document.getElementById("accountGate").hidden = true;
  const badge = document.getElementById("accountBadge");
  if (badge) badge.textContent = `${payload.user.name} · ${payload.user.role === "owner" ? "Владелец" : "Оператор"}`;
}

function bind() {
  if (bound) return;
  bound = true;
  document.getElementById("accountForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = document.getElementById("accountSubmit");
    if (button.disabled) return;
    button.disabled = true;
    document.getElementById("accountError").textContent = "";
    try {
      const data = Object.fromEntries(new FormData(form));
      const setup = form.dataset.setup === "true";
      const result = await apiRequest(`/api/accounts/${setup ? "setup" : "login"}`, { method: "POST", body: data });
      accept(result);
      appState.justConfigured = setup;
      form.elements.namedItem("password").value = "";
      resolveReady?.(true);
    } catch (error) {
      document.getElementById("accountError").textContent = businessErrorMessage(error);
    } finally {
      button.disabled = false;
    }
  });
}

export async function ensureAuthentication() {
  bind();
  const status = await apiRequest("/api/accounts/status");
  appState.csrf = status.csrf;
  if (status.user) {
    accept(status);
    return true;
  }
  if (!ready) ready = new Promise((resolve) => { resolveReady = resolve; });
  showGate(status.configured);
  return ready;
}

export async function logoutAccount() {
  if (appState.dirtySinceFlush && !(await flushBackupNow())) {
    toast("Выход отменён: сначала сохраните текущие изменения.");
    return;
  }
  await apiRequest("/api/accounts/logout", { method: "POST", body: {} });
  // Local station state is cached, never a substitute for a logged-in server account.
  appState.user = null;
  appState.settingsModalUnlocked = false;
  window.location.reload();
}
