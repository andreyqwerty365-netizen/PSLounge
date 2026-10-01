import { state as appState } from "./state.js";
import { toast } from "./ui-utils.js";

export function getNotificationAudioCtx() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  if (!appState.notificationAudioCtx) appState.notificationAudioCtx = new Ctx();
  return appState.notificationAudioCtx;
}

export function unlockNotificationAudio() {
  const ctx = getNotificationAudioCtx();
  if (!ctx) return;
  try {
    if (ctx.state === "suspended") ctx.resume();
  } catch {}
}

export function bindNotificationAudioUnlock() {
  if (appState.notificationAudioUnlockBound) return;
  appState.notificationAudioUnlockBound = true;
  const unlock = () => unlockNotificationAudio();
  window.addEventListener("pointerdown", unlock, { passive: true });
  window.addEventListener("keydown", unlock);
}

export async function playNotificationTone(force = false) {
  if (!force && !appState.settings?.notificationSound) return false;
  const ctx = getNotificationAudioCtx();
  if (!ctx) return false;
  try {
    if (ctx.state === "suspended") await ctx.resume();
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
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
    gain.gain.exponentialRampToValueAtTime(0.08, now + 0.3);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.54);

    osc.start(now);
    osc.stop(now + 0.58);
    return true;
  } catch {
    return false;
  }
}

export function enqueueStationNotification(message) {
  toast(message, 2600);
  playNotificationTone();
}

export function handleStationTransition(station, prevStatus, nextStatus) {
  if (!station || prevStatus === nextStatus) return;
  if (prevStatus === "running" && nextStatus === "grace") {
    enqueueStationNotification(
      `${station.name}: основное время закончилось, началась доигровка`,
    );
    return;
  }
  if (
    (prevStatus === "running" || prevStatus === "grace") &&
    nextStatus === "overdue"
  ) {
    enqueueStationNotification(
      `${station.name}: доигровка закончилась, станция просрочена`,
    );
  }
}
