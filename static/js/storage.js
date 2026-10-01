// Browser cache is optional: failure must never interrupt a paid operation.
export const storage = {
  getItem(key) { try { return globalThis.localStorage.getItem(key); } catch { return null; } },
  setItem(key, value) {
    try { globalThis.localStorage.setItem(key, value); return true; }
    catch { if (typeof window !== 'undefined') window.dispatchEvent(new Event('pslounge-cache-error')); return false; }
  },
  removeItem(key) { try { globalThis.localStorage.removeItem(key); } catch {} },
};
