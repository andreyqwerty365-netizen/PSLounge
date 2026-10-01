import { initializeState } from "./js/state.js";
import { boot, initLicenseGate } from "./js/license.js";

// The only browser startup entry point.
initializeState();
initLicenseGate();
boot();
