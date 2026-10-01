import { state as appState } from "./state.js";

export function sanitizeFilenamePart(value) {
  return String(value || "")
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "")
    .replace(/\s+/g, "-");
}

export function fmt(ms) {
  const safe = Math.max(0, ms);
  const totalSeconds = Math.floor(safe / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function formatDateRU(value) {
  if (!value) return "";
  let d;
  if (value instanceof Date) {
    d = value;
  } else if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [y, m, day] = value.split("-").map(Number);
    d = new Date(y, m - 1, day);
  } else {
    d = new Date(value);
  }
  if (Number.isNaN(d.getTime())) return String(value);
  const day = String(d.getDate()).padStart(2, "0");
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const year = d.getFullYear();
  return `${day}.${month}.${year}`;
}

export function hhmm(ts) {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

export function toast(text, duration = 1800) {
  if (!toast._queue) toast._queue = [];
  if (toast._showing) {
    toast._queue.push({ text, duration });
    return;
  }
  toast._showing = true;
  appState.$toast.textContent = text;
  appState.$toast.classList.add("toast--show");
  window.clearTimeout(toast._t);
  toast._t = window.setTimeout(() => {
    appState.$toast.classList.remove("toast--show");
    window.setTimeout(() => {
      const next = toast._queue.shift();
      toast._showing = false;
      if (next) toast(next.text, next.duration);
    }, 120);
  }, duration);
}

export function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
