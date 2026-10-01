const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const { spawn, execFileSync } = require('child_process');

function hasInstalledBrowsers(modulePath) {
  const localAppData = process.env.LOCALAPPDATA || '';
  if (!localAppData) return false;
  const browsersJsonPath = path.join(modulePath, '..', 'playwright-core', 'browsers.json');
  const browsersRoot = path.join(localAppData, 'ms-playwright');
  if (!fs.existsSync(browsersJsonPath) || !fs.existsSync(browsersRoot)) return false;

  try {
    const manifest = JSON.parse(fs.readFileSync(browsersJsonPath, 'utf8'));
    const browsers = Array.isArray(manifest.browsers) ? manifest.browsers : [];
    const chromium = browsers.find((item) => item && item.name === 'chromium');
    const shell = browsers.find((item) => item && item.name === 'chromium-headless-shell');
    if (!chromium || !shell) return false;
    return (
      fs.existsSync(path.join(browsersRoot, `chromium-${chromium.revision}`)) &&
      fs.existsSync(path.join(browsersRoot, `chromium_headless_shell-${shell.revision}`))
    );
  } catch (_) {
    return false;
  }
}

function resolvePlaywrightModule() {
  try {
    return require('playwright');
  } catch (directError) {
    const localAppData = process.env.LOCALAPPDATA || '';
    const cachedRoot = localAppData ? path.join(localAppData, 'npm-cache', '_npx') : '';
    const candidates = [];

    if (cachedRoot && fs.existsSync(cachedRoot)) {
      for (const entry of fs.readdirSync(cachedRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const modulePath = path.join(cachedRoot, entry.name, 'node_modules', 'playwright');
        const packageJson = path.join(modulePath, 'package.json');
        if (!fs.existsSync(packageJson)) continue;
        try {
          const stat = fs.statSync(packageJson);
          candidates.push({
            modulePath,
            mtimeMs: stat.mtimeMs,
            compatible: hasInstalledBrowsers(modulePath),
          });
        } catch (_) {
          candidates.push({ modulePath, mtimeMs: 0, compatible: false });
        }
      }
    }

    candidates.sort((a, b) => {
      if (a.compatible !== b.compatible) return a.compatible ? -1 : 1;
      return b.mtimeMs - a.mtimeMs;
    });

    for (const candidate of candidates) {
      try {
        return require(candidate.modulePath);
      } catch (_) {
        // Try next cached candidate.
      }
    }

    console.error('[fail] Playwright for Node.js is not installed or not reachable from cache.');
    if (cachedRoot) console.error(`[hint] Expected cached package under: ${cachedRoot}`);
    console.error(`[detail] ${directError.message}`);
    process.exit(1);
  }
}

const { chromium } = resolvePlaywrightModule();

const ROOT = process.cwd();
const TRACE_FILE = path.join(ROOT, '.tmp_playwright_smoke_trace.log');
const PYTHON_EXE = process.env.PS_LOUNGE_PYTHON || path.join(ROOT, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const SETTINGS_PIN = process.env.PS_LOUNGE_PIN || '4826';

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function trace(step) {
  try {
    fs.appendFileSync(TRACE_FILE, `${new Date().toISOString()} ${step}\n`, 'utf8');
  } catch (_) {
    // best effort only
  }
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));
  return { response, payload };
}

async function fetchBackupState(baseUrl) {
  const result = await fetchJson(`${baseUrl}/api/backup`);
  assert(result.response.ok, `Backup read failed with ${result.response.status}.`);
  return result.payload;
}

async function waitForBackupCondition(baseUrl, predicate, description, timeoutMs = 5000) {
  const startedAt = Date.now();
  let lastState = null;
  while (Date.now() - startedAt < timeoutMs) {
    lastState = await fetchBackupState(baseUrl);
    if (predicate(lastState)) {
      return lastState;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Backup state did not reach expected condition: ${description}`);
}

async function fetchExport(baseUrl, url) {
  const response = await fetch(`${baseUrl}${url}`);
  const buffer = await response.arrayBuffer();
  return {
    status: response.status,
    contentType: response.headers.get('content-type') || '',
    size: buffer.byteLength,
  };
}

async function seedState(baseUrl, state) {
  const result = await fetchJson(`${baseUrl}/api/backup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(state),
  });
  assert(result.response.ok, `State seed failed with ${result.response.status}.`);
  assert(result.payload.ok === true, 'State seed did not return ok=true.');
}

async function setInputValueAndDispatch(page, selector, value) {
  await page.evaluate(
    ({ selector: innerSelector, value: innerValue }) => {
      const input = document.querySelector(innerSelector);
      if (!input) throw new Error(`Input not found: ${innerSelector}`);
      input.value = innerValue;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    },
    { selector, value }
  );
}

function issueTempLicense(fingerprint, tmpDir) {
  const outputPath = path.join(tmpDir, 'smoke.pslkey');
  const ledgerPath = path.join(tmpDir, 'smoke-ledger.csv');
  const stdout = execFileSync(
    PYTHON_EXE,
    [
      path.join(ROOT, 'tools', 'generate_license.py'),
      '--customer', 'Playwright Smoke Customer',
      '--fingerprint', fingerprint,
      '--output', outputPath,
      '--ledger-file', ledgerPath,
    ],
    {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  const token = String(stdout)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !line.includes('='));
  assert(token, 'Failed to generate temporary smoke license token.');
  return token;
}

function buildDeterministicState() {
  const now = Date.now();
  return {
    schemaVersion: 3,
    version: 1,
    lastModified: now,
    stations: [
      { id: 1, name: 'PS1', stationType: 'ps', status: 'idle', startTime: null, endTime: null, tariffId: null, history: [], activeSessionId: null, lastClosedSnapshot: null },
      { id: 2, name: 'PS2', stationType: 'ps', status: 'idle', startTime: null, endTime: null, tariffId: null, history: [], activeSessionId: null, lastClosedSnapshot: null },
      { id: 5, name: 'Arcade Racer', stationType: 'simulator', status: 'idle', startTime: null, endTime: null, tariffId: null, history: [], activeSessionId: null, lastClosedSnapshot: null },
    ],
    sessions: {},
    settings: {
      graceMinutes: 10,
      overdueMinutes: 30,
      customRates: { ps: 300, simulator: 400, switch: 300 },
      stationDefinitions: [
        { id: 1, name: 'PS1', type: 'ps' },
        { id: 2, name: 'PS2', type: 'ps' },
        { id: 5, name: 'Arcade Racer', type: 'simulator' },
      ],
      tariffGroups: {
        ps: [
          { id: 'ps_t1', label: '1 ���', minutes: 60, price: 300 },
          { id: 'ps_t2', label: '2 ����', minutes: 120, price: 600 },
        ],
        simulator: [
          { id: 'sim_t1', label: '30 �����', minutes: 30, price: 250 },
          { id: 'sim_t2', label: '1 ���', minutes: 60, price: 400 },
        ],
        switch: [
          { id: 'sw_t1', label: '30 �����', minutes: 30, price: 200 },
          { id: 'sw_t2', label: '1 ���', minutes: 60, price: 300 },
        ],
      },
      notificationSound: false,
    },
    achievements: {
      version: 1,
      backfillVersion: 3,
      unlocked: {},
      progress: {},
      dynamicTargets: {},
      unseenIds: [],
      breakEvents: [],
      cleanTrackingStartedAt: now,
    },
  };
}

function buildCleanupScenarioState() {
  const now = Date.now();
  const activeStart = now - 20 * 60 * 1000;
  const activeEnd = now + 40 * 60 * 1000;
  const closedStart = now - 120 * 60 * 1000;
  const closedEnd = now - 60 * 60 * 1000;
  const dayKey = new Date(now).toISOString().slice(0, 10);
  const activeRecord = {
    id: 'active-1',
    stationId: 1,
    stationName: 'PS1',
    stationType: 'ps',
    startTime: activeStart,
    endTime: null,
    tariffId: 'ps_t1',
    tariffLabel: '1 ���',
    mode: 'started',
    totalAmount: 300,
    paymentMethod: 'cash',
    sales: [
      { id: 'sale-active-1', time: activeStart, type: 'start_tariff', label: '�����', minutes: 60, amount: 300, paymentMethod: 'cash' },
    ],
  };
  const closedRecord = {
    id: 'closed-2',
    stationId: 2,
    stationName: 'PS2',
    stationType: 'ps',
    startTime: closedStart,
    endTime: closedEnd,
    tariffId: 'ps_t1',
    tariffLabel: '1 ���',
    mode: 'manual',
    totalAmount: 300,
    paymentMethod: 'card',
    sales: [
      { id: 'sale-closed-1', time: closedStart, type: 'start_tariff', label: '�����', minutes: 60, amount: 300, paymentMethod: 'card' },
    ],
  };
  const recoverySnapshot = {
    version: 1,
    storedAt: now - 5 * 60 * 1000,
    expiresAt: now + 25 * 60 * 1000,
    sessionDayKey: dayKey,
    stationState: {
      status: 'running',
      startTime: closedStart,
      endTime: closedEnd,
      tariffId: 'ps_t1',
      activeSessionId: 'closed-2',
    },
    sessionRecord: { ...closedRecord },
  };
  return {
    schemaVersion: 3,
    version: 1,
    lastModified: now,
    stations: [
      {
        id: 1,
        name: 'PS1',
        stationType: 'ps',
        status: 'running',
        startTime: activeStart,
        endTime: activeEnd,
        tariffId: 'ps_t1',
        history: [],
        activeSessionId: 'active-1',
        lastClosedSnapshot: null,
      },
      {
        id: 2,
        name: 'PS2',
        stationType: 'ps',
        status: 'idle',
        startTime: null,
        endTime: null,
        tariffId: null,
        history: [
          {
            status: 'idle',
            startTime: null,
            endTime: null,
            tariffId: null,
            extraMinutes: 0,
            activeSessionId: 'closed-2',
            sessionDayKey: dayKey,
            sessionRecord: { ...closedRecord },
            lastClosedSnapshot: { ...recoverySnapshot },
          },
        ],
        activeSessionId: null,
        lastClosedSnapshot: { ...recoverySnapshot },
      },
      { id: 5, name: 'Arcade Racer', stationType: 'simulator', status: 'idle', startTime: null, endTime: null, tariffId: null, history: [], activeSessionId: null, lastClosedSnapshot: null },
    ],
    sessions: {
      [dayKey]: [
        activeRecord,
        closedRecord,
      ],
    },
    settings: {
      graceMinutes: 10,
      overdueMinutes: 30,
      customRates: { ps: 300, simulator: 400, switch: 300 },
      stationDefinitions: [
        { id: 1, name: 'PS1', type: 'ps' },
        { id: 2, name: 'PS2', type: 'ps' },
        { id: 5, name: 'Arcade Racer', type: 'simulator' },
      ],
      tariffGroups: {
        ps: [
          { id: 'ps_t1', label: '1 ���', minutes: 60, price: 300 },
          { id: 'ps_t2', label: '2 ����', minutes: 120, price: 600 },
        ],
        simulator: [
          { id: 'sim_t1', label: '30 �����', minutes: 30, price: 250 },
          { id: 'sim_t2', label: '1 ���', minutes: 60, price: 400 },
        ],
        switch: [
          { id: 'sw_t1', label: '30 �����', minutes: 30, price: 200 },
          { id: 'sw_t2', label: '1 ���', minutes: 60, price: 300 },
        ],
      },
      notificationSound: false,
    },
    achievements: {
      version: 1,
      backfillVersion: 3,
      unlocked: {},
      progress: {},
      dynamicTargets: {},
      unseenIds: [],
      breakEvents: [],
      cleanTrackingStartedAt: now,
    },
  };
}

function buildBackupMergeMetadataState() {
  const now = Date.now() + 10 * 60 * 1000;
  const start = now - 90 * 60 * 1000;
  const end = now - 30 * 60 * 1000;
  const dayKey = new Date(now).toISOString().slice(0, 10);
  return {
    schemaVersion: 3,
    version: 1,
    lastModified: now,
    stations: [
      { id: 1, name: 'Legacy Hall', stationType: 'ps', status: 'idle', startTime: null, endTime: null, tariffId: null, history: [], activeSessionId: null, lastClosedSnapshot: null },
      { id: 2, name: 'PS2', stationType: 'ps', status: 'idle', startTime: null, endTime: null, tariffId: null, history: [], activeSessionId: null, lastClosedSnapshot: null },
      { id: 5, name: 'Arcade Racer', stationType: 'simulator', status: 'idle', startTime: null, endTime: null, tariffId: null, history: [], activeSessionId: null, lastClosedSnapshot: null },
    ],
    sessions: {
      [dayKey]: [{
        id: 'backup-merge-1',
        stationId: 1,
        stationName: 'Legacy Hall',
        stationType: 'ps',
        startTime: start,
        endTime: end,
        tariffId: 'ps_t1',
        tariffLabel: '1 ���',
        mode: 'manual',
        totalAmount: 300,
        paymentMethod: 'cash',
        sales: [
          { id: 'sale-backup-1', time: start, type: 'start_tariff', label: '�����', minutes: 60, amount: 300, paymentMethod: 'cash' },
        ],
      }],
    },
    settings: {
      graceMinutes: 10,
      overdueMinutes: 30,
      customRates: { ps: 300, simulator: 400, switch: 300 },
      stationDefinitions: [
        { id: 1, name: 'VIP Hall', type: 'simulator' },
        { id: 2, name: 'PS2', type: 'ps' },
        { id: 5, name: 'Arcade Racer', type: 'simulator' },
      ],
      tariffGroups: {
        ps: [
          { id: 'ps_t1', label: '1 ���', minutes: 60, price: 300 },
          { id: 'ps_t2', label: '2 ����', minutes: 120, price: 600 },
        ],
        simulator: [
          { id: 'sim_t1', label: '30 �����', minutes: 30, price: 250 },
          { id: 'sim_t2', label: '1 ���', minutes: 60, price: 400 },
        ],
        switch: [
          { id: 'sw_t1', label: '30 �����', minutes: 30, price: 200 },
          { id: 'sw_t2', label: '1 ���', minutes: 60, price: 300 },
        ],
      },
      notificationSound: false,
    },
    achievements: {
      version: 1,
      backfillVersion: 3,
      unlocked: {},
      progress: {},
      dynamicTargets: {},
      unseenIds: [],
      breakEvents: [],
      cleanTrackingStartedAt: now,
    },
  };
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : null;
      server.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
    server.on('error', reject);
  });
}

async function waitForHealth(baseUrl, timeoutMs = 15000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      const text = await response.text();
      if (response.ok && text.includes('OK:PSLOUNGE')) return;
    } catch (_) {
      // keep polling
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Smoke server did not become healthy within ${timeoutMs}ms.`);
}

async function startSmokeServer() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'psl-smoke-server-'));
  const appDir = path.join(tmpDir, 'appdata');
  fs.mkdirSync(appDir, { recursive: true });
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;

  trace(`server:start:${baseUrl}`);
  const child = spawn(
    PYTHON_EXE,
    [path.join(ROOT, 'main.py')],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        PS_LOUNGE_HOST: '127.0.0.1',
        PS_LOUNGE_PORT: String(port),
        PS_LOUNGE_DEBUG: '0',
        PS_LOUNGE_NO_BROWSER: '1',
        PS_LOUNGE_DISABLE_SINGLE_INSTANCE: '1',
        PS_LOUNGE_APP_DIR: appDir,
      },
      stdio: 'ignore',
      windowsHide: true,
    }
  );

  try {
    await waitForHealth(baseUrl);
  } catch (error) {
    child.kill();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    throw error;
  }

  return {
    baseUrl,
    appDir,
    tmpDir,
    async cleanup() {
      trace('server:cleanup');
      if (!child.killed) {
        child.kill();
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

async function prepareSmokeEnvironment(baseUrl, tmpDir) {
  trace('env:license-status');
  const status = await fetchJson(`${baseUrl}/api/license/status`);
  assert(status.response.ok, `License status request failed with ${status.response.status}.`);
  const fingerprint = String(status.payload.machineFingerprint || '').trim();
  assert(fingerprint, 'License status did not return machineFingerprint.');

  trace('env:activate-license');
  const token = issueTempLicense(fingerprint, tmpDir);
  const activation = await fetchJson(`${baseUrl}/api/license/activate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  assert(activation.response.ok, `Temporary smoke license activation failed with ${activation.response.status}.`);
  assert(activation.payload.licensed === true, 'Temporary smoke license did not activate.');

  trace('env:seed-state');
  await seedState(baseUrl, buildDeterministicState());
}

function getOnlySessionDay(state) {
  const keys = Object.keys(state.sessions || {});
  assert(keys.length <= 1, `Expected at most one session day in smoke state, got ${keys.length}.`);
  return keys[0] || '';
}

function getOnlySessionRecord(state) {
  const dayKey = getOnlySessionDay(state);
  const list = dayKey ? (state.sessions?.[dayKey] || []) : [];
  assert(list.length === 1, `Expected exactly one session record, got ${list.length}.`);
  return { dayKey, record: list[0] };
}

function acceptNextDialog(page) {
  return page.waitForEvent('dialog', { timeout: 5000 }).then((dialog) => dialog.accept());
}

function dismissNextDialog(page) {
  return page.waitForEvent('dialog', { timeout: 5000 }).then((dialog) => dialog.dismiss());
}

async function maybeAcceptDialog(page, timeoutMs = 1200) {
  try {
    const dialog = await page.waitForEvent('dialog', { timeout: timeoutMs });
    await dialog.accept();
  } catch (_) {
    // no dialog shown
  }
}

(async () => {
  try {
    fs.writeFileSync(TRACE_FILE, '', 'utf8');
  } catch (_) {
    // ignore
  }

  trace('smoke:start');
  let server = null;
  let browser = null;
  let context = null;
  const consoleErrors = [];
  const downloads = [];

  try {
    server = await startSmokeServer();
    await prepareSmokeEnvironment(server.baseUrl, server.tmpDir);

    trace('browser:launch');
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({
      viewport: { width: 1600, height: 1000 },
      acceptDownloads: true,
    });
    const page = await context.newPage();

    page.on('console', (msg) => {
      if (msg.type() !== 'error') return;
      const text = msg.text();
      if (text.includes('favicon.ico')) return;
      consoleErrors.push(text);
    });
    page.on('pageerror', (error) => {
      consoleErrors.push(`[pageerror] ${error && (error.stack || error.message || String(error))}`);
    });
    page.on('download', (download) => downloads.push(download.suggestedFilename()));

    trace('page:goto');
    await page.goto(`${server.baseUrl}/`, { waitUntil: 'networkidle' });

    const title = await page.locator('.brand__title').textContent();
    assert(title && title.includes('PS Lounge'), 'Main title was not found.');
    trace('ui:loaded');

    const startupDiagnostics = await page.evaluate(() => ({
      cardCount: document.querySelectorAll('.card[data-station-id]').length,
      appShellHidden: document.getElementById('appShell')?.classList.contains('app--shell-hidden') ?? null,
      licenseGateHidden: document.getElementById('licenseGate')?.hidden ?? null,
      controlTitle: document.getElementById('ctlTitle')?.textContent || null,
    }));
    trace(`ui:startup:${JSON.stringify(startupDiagnostics)}`);

    const firstStation = page.locator('.card[data-station-id]').first();
    await firstStation.click();
    const controlTitleBeforeReload = await page.locator('#ctlTitle').textContent();
    assert(controlTitleBeforeReload && !controlTitleBeforeReload.includes('�������� �������'), 'Station selection did not update control panel.');
    await page.reload({ waitUntil: 'networkidle' });
    const controlTitleAfterReload = await page.locator('#ctlTitle').textContent();
    assert(controlTitleAfterReload === controlTitleBeforeReload, 'Selected station was not restored after reload.');
    trace('ui:selection-restored');

    assert(await page.locator('#btnStart').isEnabled(), 'Start button should be enabled for idle station.');
    assert(await page.locator('#btnExtend').isDisabled(), 'Extend button should be disabled for idle station.');
    assert(await page.locator('#btnStop').isDisabled(), 'Stop button should be disabled for idle station.');

    const paymentButtons = page.locator('#paymentMethodButtons .paychip');
    assert(await paymentButtons.count() >= 3, 'Payment method chips did not render.');
    await paymentButtons.nth(0).click();
    await page.locator('#tariffs .tag').first().click();
    const untilBeforeStart = (await page.locator('#ctlMetaUntil').textContent()) || '';
    await page.click('#btnStart');
    await page.waitForFunction(() => {
      const start = document.querySelector('#btnStart');
      const stop = document.querySelector('#btnStop');
      return !!start && !!stop && start.disabled && !stop.disabled;
    });
    const untilAfterStart = (await page.locator('#ctlMetaUntil').textContent()) || '';
    assert(untilAfterStart && untilAfterStart !== '�' && untilAfterStart !== untilBeforeStart, 'Start should set a session end time.');
    const stateAfterStart = await waitForBackupCondition(
      server.baseUrl,
      (state) => {
        try {
          const started = getOnlySessionRecord(state);
          return Number(started.record.totalAmount) === 300 && Array.isArray(started.record.sales) && started.record.sales.length === 1;
        } catch (_) {
          return false;
        }
      },
      'started session persisted with totalAmount=300 and 1 sale'
    );
    const started = getOnlySessionRecord(stateAfterStart);
    assert(started.record.stationId === 1, 'Started session should belong to the selected station.');
    assert(started.record.endTime === null, 'Started session should be open in backup state.');
    assert(Number(started.record.totalAmount) === 300, `Started session should persist tariff amount 300, got ${started.record.totalAmount}.`);
    assert(Array.isArray(started.record.sales) && started.record.sales.length === 1, `Started session should persist a single sale row, got ${Array.isArray(started.record.sales) ? started.record.sales.length : 'non-array'}.`);
    assert(started.record.sales[0].paymentMethod === 'cash', `Started session should use cash payment, got ${started.record.sales[0].paymentMethod}.`);
    trace('lifecycle:started');

    await paymentButtons.nth(1).click();
    await page.click('#btnExtend');
    await page.waitForFunction((prevText) => {
      const el = document.querySelector('#ctlMetaUntil');
      return !!el && !!el.textContent && el.textContent !== prevText;
    }, untilAfterStart);
    const untilAfterExtend = (await page.locator('#ctlMetaUntil').textContent()) || '';
    assert(untilAfterExtend !== untilAfterStart, 'Extend should change session end time.');
    const stateAfterExtend = await waitForBackupCondition(
      server.baseUrl,
      (state) => {
        try {
          const extended = getOnlySessionRecord(state);
          return Number(extended.record.totalAmount) === 600 && Array.isArray(extended.record.sales) && extended.record.sales.length === 2;
        } catch (_) {
          return false;
        }
      },
      'extended session persisted with totalAmount=600 and 2 sales'
    );
    const extended = getOnlySessionRecord(stateAfterExtend);
    assert(Number(extended.record.totalAmount) === 600, `Extended session should persist cumulative amount 600, got ${extended.record.totalAmount}.`);
    assert(Array.isArray(extended.record.sales) && extended.record.sales.length === 2, `Extended session should persist two sale rows, got ${Array.isArray(extended.record.sales) ? extended.record.sales.length : 'non-array'}.`);
    assert(extended.record.sales[0].paymentMethod === 'cash', `First sale should remain cash, got ${extended.record.sales[0].paymentMethod}.`);
    assert(extended.record.sales[1].paymentMethod === 'card', `Second sale should persist card payment, got ${extended.record.sales[1].paymentMethod}.`);
    const controlMetaAfterExtend = (await page.locator('#ctlMetaSub').textContent()) || '';
    assert(controlMetaAfterExtend.includes('600'), 'Control panel should show cumulative amount 600 after extend.');
    assert(extended.record.sales.some((sale) => sale.paymentMethod === 'cash') && extended.record.sales.some((sale) => sale.paymentMethod === 'card'), 'Extended session should remain mixed-payment after mixed extend.');
    trace('lifecycle:extended');

    await page.click('#btnUndo');
    await page.waitForFunction((prevText) => {
      const el = document.querySelector('#ctlMetaSub');
      return !!el && !!el.textContent && el.textContent !== prevText;
    }, controlMetaAfterExtend);
    const stateAfterUndoExtend = await waitForBackupCondition(
      server.baseUrl,
      (state) => {
        try {
          const rolledBack = getOnlySessionRecord(state);
          return Number(rolledBack.record.totalAmount) === 300 && Array.isArray(rolledBack.record.sales) && rolledBack.record.sales.length === 1;
        } catch (_) {
          return false;
        }
      },
      'undo extend should restore totalAmount=300 and 1 sale'
    );
    const rolledBack = getOnlySessionRecord(stateAfterUndoExtend);
    assert(Number(rolledBack.record.totalAmount) === 300, `Undo extend should restore cumulative amount 300, got ${rolledBack.record.totalAmount}.`);
    assert(Array.isArray(rolledBack.record.sales) && rolledBack.record.sales.length === 1, `Undo extend should restore a single sale row, got ${Array.isArray(rolledBack.record.sales) ? rolledBack.record.sales.length : 'non-array'}.`);
    assert(rolledBack.record.sales[0].paymentMethod === 'cash', `Undo extend should restore the original cash sale, got ${rolledBack.record.sales[0].paymentMethod}.`);
    const controlMetaAfterUndo = (await page.locator('#ctlMetaSub').textContent()) || '';
    assert(controlMetaAfterUndo.includes('300'), 'Control panel should roll back to cumulative amount 300 after undo.');
    assert(rolledBack.record.sales.every((sale) => sale.paymentMethod === 'cash'), 'Undo extend should remove the mixed-payment state.');
    trace('lifecycle:undo-extend');

    await paymentButtons.nth(1).click();
    await page.click('#btnExtend');
    await page.waitForFunction((prevText) => {
      const el = document.querySelector('#ctlMetaSub');
      return !!el && !!el.textContent && el.textContent !== prevText;
    }, controlMetaAfterUndo);
    const stateAfterReExtend = await waitForBackupCondition(
      server.baseUrl,
      (state) => {
        try {
          const reextended = getOnlySessionRecord(state);
          return Number(reextended.record.totalAmount) === 600 && Array.isArray(reextended.record.sales) && reextended.record.sales.length === 2;
        } catch (_) {
          return false;
        }
      },
      're-extend after undo should restore totalAmount=600 and 2 sales'
    );
    const reextended = getOnlySessionRecord(stateAfterReExtend);
    assert(Number(reextended.record.totalAmount) === 600, `Re-extend should restore cumulative amount 600, got ${reextended.record.totalAmount}.`);
    assert(Array.isArray(reextended.record.sales) && reextended.record.sales.length === 2, `Re-extend should restore two sale rows, got ${Array.isArray(reextended.record.sales) ? reextended.record.sales.length : 'non-array'}.`);
    trace('lifecycle:reextended');

    const stopDialog = acceptNextDialog(page);
    await page.click('#btnStop');
    await stopDialog;
    await page.waitForFunction(() => {
      const restore = document.querySelector('#btnRestoreLast');
      const start = document.querySelector('#btnStart');
      const stop = document.querySelector('#btnStop');
      return !!restore && !!start && !!stop && !restore.disabled && !start.disabled && stop.disabled;
    });
    const stateAfterFirstStop = await waitForBackupCondition(
      server.baseUrl,
      (state) => {
        try {
          const stopped = getOnlySessionRecord(state);
          return Number.isFinite(Number(stopped.record.endTime)) && stopped.record.mode === 'manual';
        } catch (_) {
          return false;
        }
      },
      'manual stop persisted with endTime and mode=manual'
    );
    const stoppedOnce = getOnlySessionRecord(stateAfterFirstStop);
    assert(Number.isFinite(Number(stoppedOnce.record.endTime)), 'Stopped session should have endTime in backup state.');
    assert(stoppedOnce.record.mode === 'manual', 'Manual stop should persist mode=manual.');
    trace('lifecycle:stopped-once');

    const restartBlockedDialog = dismissNextDialog(page);
    await page.click('#btnStart');
    await restartBlockedDialog;
    await page.waitForFunction(() => {
      const restore = document.querySelector('#btnRestoreLast');
      const start = document.querySelector('#btnStart');
      const stop = document.querySelector('#btnStop');
      return !!restore && !!start && !!stop && !restore.disabled && !start.disabled && stop.disabled;
    });
    const stateAfterBlockedRestart = await fetchBackupState(server.baseUrl);
    const blockedRestartRecord = getOnlySessionRecord(stateAfterBlockedRestart);
    assert(Number.isFinite(Number(blockedRestartRecord.record.endTime)), 'Declined restart should keep the stopped session closed.');
    trace('lifecycle:restart-blocked-by-recovery');

    await page.click('#btnUndo');
    await page.waitForFunction(() => {
      const restore = document.querySelector('#btnRestoreLast');
      const start = document.querySelector('#btnStart');
      const stop = document.querySelector('#btnStop');
      return !!restore && !!start && !!stop && restore.disabled && start.disabled && !stop.disabled;
    });
    const stateAfterUndoStop = await waitForBackupCondition(
      server.baseUrl,
      (state) => {
        try {
          const reopened = getOnlySessionRecord(state);
          const station1 = Array.isArray(state.stations) ? state.stations.find((station) => station.id === 1) : null;
          return (
            reopened.record.endTime === null &&
            reopened.record.mode === 'started' &&
            station1 &&
            station1.status !== 'idle' &&
            station1.activeSessionId === reopened.record.id &&
            station1.lastClosedSnapshot == null
          );
        } catch (_) {
          return false;
        }
      },
      'undo stop should reopen the active session and clear recovery snapshot'
    );
    const reopenedAfterUndoStop = getOnlySessionRecord(stateAfterUndoStop);
    assert(reopenedAfterUndoStop.record.endTime === null, 'Undo stop should reopen the stopped session.');
    assert(reopenedAfterUndoStop.record.mode === 'started', 'Undo stop should restore mode=started.');
    trace('lifecycle:undo-stop');

    const stopDialogRedo = maybeAcceptDialog(page);
    await page.click('#btnStop');
    await stopDialogRedo;
    await page.waitForFunction(() => {
      const restore = document.querySelector('#btnRestoreLast');
      const start = document.querySelector('#btnStart');
      const stop = document.querySelector('#btnStop');
      return !!restore && !!start && !!stop && !restore.disabled && !start.disabled && stop.disabled;
    });
    const stateAfterRedoStop = await waitForBackupCondition(
      server.baseUrl,
      (state) => {
        try {
          const restopped = getOnlySessionRecord(state);
          return Number.isFinite(Number(restopped.record.endTime)) && restopped.record.mode === 'manual';
        } catch (_) {
          return false;
        }
      },
      'stop after undo stop should close the session again'
    );
    const restoppedAfterUndo = getOnlySessionRecord(stateAfterRedoStop);
    assert(Number.isFinite(Number(restoppedAfterUndo.record.endTime)), 'Redo stop should close the reopened session.');
    trace('lifecycle:redo-stop');

    await page.click('#btnSessions');
    await page.waitForSelector('#sessionsModal.modal--open');
    const sessionsSubAfterStop = (await page.locator('#sessionsSub').textContent()) || '';
    const closedCountAfterStop = ((await page.locator('#summarySessions').textContent()) || '').trim();
    const paidSummaryAfterStop = (await page.locator('#summaryPaid').textContent()) || '';
    const firstSessionMetaAfterStop = (await page.locator('#sessionsList .sessionRow').first().textContent()) || '';
    assert(sessionsSubAfterStop.includes('1'), 'Sessions modal should show one session after stop.');
    assert(closedCountAfterStop === '1', 'Stopped session should be counted as closed.');
    assert(/�����.*300/.test(paidSummaryAfterStop), `Sessions summary should include 300 cash, got: ${paidSummaryAfterStop}`);
    assert(/����.*300/.test(paidSummaryAfterStop), `Sessions summary should include 300 card, got: ${paidSummaryAfterStop}`);
    assert(firstSessionMetaAfterStop.includes('���������'), 'Session row should show mixed payment label after mixed sales.');
    await page.click('#btnCloseSessions');
    await page.waitForTimeout(150);
    trace('lifecycle:session-visible');

    const restoreDialog = acceptNextDialog(page);
    await page.click('#btnRestoreLast');
    await restoreDialog;
    await page.waitForFunction(() => {
      const restore = document.querySelector('#btnRestoreLast');
      const stop = document.querySelector('#btnStop');
      return !!restore && !!stop && restore.disabled && !stop.disabled;
    });
    const stateAfterRestore = await waitForBackupCondition(
      server.baseUrl,
      (state) => {
        try {
          const restored = getOnlySessionRecord(state);
          return restored.record.endTime === null && restored.record.mode === 'started';
        } catch (_) {
          return false;
        }
      },
      'restored session persisted as reopened'
    );
    const restored = getOnlySessionRecord(stateAfterRestore);
    assert(restored.record.endTime === null, 'Restored session should be reopened in backup state.');
    assert(restored.record.mode === 'started', 'Restored session should switch back to mode=started.');
    trace('lifecycle:restored');

    await page.waitForTimeout(750);
    await page.waitForFunction(() => {
      const stop = document.querySelector('#btnStop');
      return !!stop && !stop.disabled;
    });
    const secondStopDialog = acceptNextDialog(page);
    await page.click('#btnStop');
    await secondStopDialog;
    await page.waitForFunction(() => {
      const restore = document.querySelector('#btnRestoreLast');
      const stop = document.querySelector('#btnStop');
      return !!restore && !!stop && !restore.disabled && stop.disabled;
    });
    const stateAfterSecondStop = await waitForBackupCondition(
      server.baseUrl,
      (state) => {
        try {
          const stopped = getOnlySessionRecord(state);
          return Number.isFinite(Number(stopped.record.endTime));
        } catch (_) {
          return false;
        }
      },
      'second stop persisted with closed session'
    );
    const stoppedTwice = getOnlySessionRecord(stateAfterSecondStop);
    assert(Number.isFinite(Number(stoppedTwice.record.endTime)), 'Second stop should close restored session again.');
    const todayExport = await fetchExport(server.baseUrl, `/api/export/today.xlsx?date=${encodeURIComponent(stoppedTwice.dayKey)}`);
    assert(todayExport.status === 200, `Today export should succeed after stop, got ${todayExport.status}.`);
    assert(todayExport.contentType.includes('spreadsheetml'), 'Today export should return XLSX content type.');
    assert(todayExport.size > 0, 'Today export should return a non-empty file.');
    const reportExport = await fetchExport(server.baseUrl, `/api/export/report.xlsx?from=${encodeURIComponent(stoppedTwice.dayKey)}&to=${encodeURIComponent(stoppedTwice.dayKey)}`);
    assert(reportExport.status === 200, `Report export should succeed after stop, got ${reportExport.status}.`);
    assert(reportExport.contentType.includes('spreadsheetml'), 'Report export should return XLSX content type.');
    assert(reportExport.size > 0, 'Report export should return a non-empty file.');
    trace('lifecycle:stopped-twice');

    await page.click('#btnReports');
    await page.waitForSelector('#reportsModal.modal--open');
    await page.waitForFunction(() => document.querySelectorAll('#reportsList .reportRow').length >= 1);
    const reportPaymentTotalsText = (await page.locator('#reportPaymentTotals').textContent()) || '';
    const firstSessionReportText = (await page.locator('#reportsList .reportRow').first().textContent()) || '';
    assert(/�����.*300/.test(reportPaymentTotalsText), `Reports totals should include 300 cash, got: ${reportPaymentTotalsText}`);
    assert(/����.*300/.test(reportPaymentTotalsText), `Reports totals should include 300 card, got: ${reportPaymentTotalsText}`);
    assert(firstSessionReportText.includes('���������'), 'Session report row should show mixed payment label.');

    await setInputValueAndDispatch(page, '#reportPayment', 'mixed');
    await page.waitForFunction(() => document.querySelector('#reportPayment')?.value === 'mixed');
    await page.waitForFunction(() => document.querySelectorAll('#reportsList .reportRow').length === 1);
    const mixedReportText = (await page.locator('#reportsList .reportRow').first().textContent()) || '';
    assert(mixedReportText.includes('���������'), 'Mixed payment filter should keep the mixed session row.');

    await setInputValueAndDispatch(page, '#reportView', 'sales');
    await setInputValueAndDispatch(page, '#reportPayment', 'all');
    await page.waitForFunction(() => document.querySelector('#reportView')?.value === 'sales');
    await page.waitForFunction(() => document.querySelectorAll('#reportsList .reportRow').length === 2);
    const salesRowsText = await page.locator('#reportsList .reportRow').allTextContents();
    assert(salesRowsText.some((text) => text.includes('��������')), 'Sales report should include a cash sale row.');
    assert(salesRowsText.some((text) => text.includes('�����')), 'Sales report should include a card sale row.');

    await setInputValueAndDispatch(page, '#reportPayment', 'cash');
    await page.waitForFunction(() => document.querySelectorAll('#reportsList .reportRow').length === 1);
    const cashSaleText = (await page.locator('#reportsList .reportRow').first().textContent()) || '';
    assert(cashSaleText.includes('��������'), 'Cash payment filter should keep only the cash sale row.');

    await setInputValueAndDispatch(page, '#reportPayment', 'card');
    await page.waitForFunction(() => document.querySelectorAll('#reportsList .reportRow').length === 1);
    const cardSaleText = (await page.locator('#reportsList .reportRow').first().textContent()) || '';
    assert(cardSaleText.includes('�����'), 'Card payment filter should keep only the card sale row.');

    await setInputValueAndDispatch(page, '#reportView', 'sessions');
    await setInputValueAndDispatch(page, '#reportPayment', 'all');
    await page.waitForFunction(() => document.querySelector('#reportView')?.value === 'sessions');
    await page.waitForFunction(() => document.querySelectorAll('#reportsList .reportRow').length === 1);
    await page.click('#btnCloseReports');
    await page.waitForTimeout(150);
    trace('ui:reports-mixed-payment');

    await seedState(server.baseUrl, buildCleanupScenarioState());
    await page.reload({ waitUntil: 'networkidle' });
    await page.click('#btnSessions');
    await page.waitForSelector('#sessionsModal.modal--open');
    await page.waitForFunction(() => {
      const sub = document.querySelector('#sessionsSub');
      return !!sub && /2/.test(sub.textContent || '');
    });
    const clearTodayDialog = acceptNextDialog(page);
    await page.click('#btnClearToday');
    await clearTodayDialog;
    await page.waitForFunction(() => {
      const sub = document.querySelector('#sessionsSub');
      const closed = document.querySelector('#summarySessions');
      return !!sub && !!closed && /1/.test(sub.textContent || '') && (closed.textContent || '').trim() === '0';
    });
    const stateAfterClearToday = await waitForBackupCondition(
      server.baseUrl,
      (state) => {
        const dayKey = getOnlySessionDay(state);
        const list = dayKey ? (state.sessions?.[dayKey] || []) : [];
        const station2 = Array.isArray(state.stations) ? state.stations.find((station) => station.id === 2) : null;
        return (
          list.length === 1 &&
          list[0]?.id === 'active-1' &&
          station2 &&
          station2.lastClosedSnapshot == null &&
          Array.isArray(station2.history) &&
          station2.history.length === 0
        );
      },
      'clear today should keep only active session and prune recovery for closed station'
    );
    const dayAfterClearToday = getOnlySessionDay(stateAfterClearToday);
    const listAfterClearToday = dayAfterClearToday ? (stateAfterClearToday.sessions?.[dayAfterClearToday] || []) : [];
    assert(listAfterClearToday.length === 1 && listAfterClearToday[0].id === 'active-1', 'Clear today should preserve only the active session.');

    await page.click('#btnCloseSessions');
    await page.waitForTimeout(150);
    await page.locator('.card[data-station-id="2"]').click();
    await page.waitForFunction(() => {
      const restore = document.querySelector('#btnRestoreLast');
      return !!restore && restore.disabled;
    });
    await page.click('#btnSessions');
    await page.waitForSelector('#sessionsModal.modal--open');
    const closeShiftActiveDialog = acceptNextDialog(page);
    await page.click('#btnCloseShift');
    await closeShiftActiveDialog;
    const stateAfterCloseShiftActive = await waitForBackupCondition(
      server.baseUrl,
      (state) => {
        const dayKey = getOnlySessionDay(state);
        const list = dayKey ? (state.sessions?.[dayKey] || []) : [];
        const station1 = Array.isArray(state.stations) ? state.stations.find((station) => station.id === 1) : null;
        return (
          list.length === 1 &&
          list[0]?.id === 'active-1' &&
          station1 &&
          station1.status === 'running' &&
          station1.activeSessionId === 'active-1'
        );
      },
      'close shift with active session should keep the running station and active session'
    );
    const dayAfterCloseShiftActive = getOnlySessionDay(stateAfterCloseShiftActive);
    const listAfterCloseShiftActive = dayAfterCloseShiftActive ? (stateAfterCloseShiftActive.sessions?.[dayAfterCloseShiftActive] || []) : [];
    assert(listAfterCloseShiftActive.length === 1 && listAfterCloseShiftActive[0].id === 'active-1', 'Close shift should not remove the active session.');
    await page.click('#btnCloseSessions');
    await page.waitForTimeout(150);
    trace('lifecycle:clear-today-active-safe');

    await seedState(server.baseUrl, buildBackupMergeMetadataState());
    await page.reload({ waitUntil: 'networkidle' });
    await page.click('#btnSessions');
    await page.waitForSelector('#sessionsModal.modal--open');
    await page.waitForFunction(() => document.querySelectorAll('#sessionsList .sessionRow').length >= 1);
    const mergedSessionText = (await page.locator('#sessionsList .sessionRow').first().textContent()) || '';
    assert(mergedSessionText.includes('VIP Hall'), 'Backup merge should refresh session station name from settings definitions.');
    const mergedExportState = await fetchBackupState(server.baseUrl);
    const mergedExportDay = getOnlySessionDay(mergedExportState);
    const mergedTodayExport = await fetchExport(server.baseUrl, `/api/export/today.xlsx?date=${encodeURIComponent(mergedExportDay)}`);
    assert(mergedTodayExport.status === 200, `Today export should succeed after backup metadata merge, got ${mergedTodayExport.status}.`);
    assert(mergedTodayExport.contentType.includes('spreadsheetml'), 'Merged-state today export should return XLSX content type.');
    await page.click('#btnCloseSessions');
    await page.waitForTimeout(150);
    trace('backup:session-metadata-synced');

    await seedState(server.baseUrl, buildDeterministicState());
    await page.reload({ waitUntil: 'networkidle' });
    await page.locator('.card[data-station-id]').first().click();
    await page.locator('#tariffs .tag').first().click();
    await page.click('#btnStart');
    await page.waitForFunction(() => {
      const start = document.querySelector('#btnStart');
      const stop = document.querySelector('#btnStop');
      return !!start && !!stop && start.disabled && !stop.disabled;
    });
    const stopDialogForShift = acceptNextDialog(page);
    await page.click('#btnStop');
    await stopDialogForShift;

    await page.click('#btnSessions');
    await page.waitForSelector('#sessionsModal.modal--open');
    const closeShiftDialog = acceptNextDialog(page);
    await page.click('#btnCloseShift');
    await closeShiftDialog;
    await page.waitForFunction(() => {
      const sub = document.querySelector('#sessionsSub');
      const list = document.querySelector('#sessionsList');
      return !!sub && !!list && /0/.test(sub.textContent || '') && /�����/.test(list.textContent || '');
    });
    const revenueAfterShiftClose = (await page.locator('#summaryRevenue').textContent()) || '';
    assert(revenueAfterShiftClose.includes('0'), 'Close shift should clear today revenue summary.');
    const stateAfterShiftClose = await waitForBackupCondition(
      server.baseUrl,
      (state) => {
        const remainingDay = getOnlySessionDay(state);
        const remainingCount = remainingDay ? (state.sessions?.[remainingDay] || []).length : 0;
        return remainingCount === 0 && Array.isArray(state.stations) && state.stations.every((station) => station.status === 'idle');
      },
      'close shift persisted with empty day sessions and idle stations'
    );
    const remainingDay = getOnlySessionDay(stateAfterShiftClose);
    if (remainingDay) {
      assert((stateAfterShiftClose.sessions?.[remainingDay] || []).length === 0, 'Close shift should clear today session list in backup state.');
    }
    assert(Array.isArray(stateAfterShiftClose.stations), 'Backup state should still contain stations after close shift.');
    assert(stateAfterShiftClose.stations.every((station) => station.status === 'idle'), 'All stations should remain idle after close shift cleanup.');
    await page.click('#btnCloseSessions');
    await page.waitForTimeout(150);
    trace('lifecycle:shift-closed');

    await page.click('#btnJournal');
    await page.waitForSelector('#journalModal.modal--open');
    await page.click('[data-journal-select-toggle="station"]');
    await page.waitForSelector('[data-journal-select="station"].is-open');
    const stationOptions = await page.locator('[data-journal-select-menu="station"] .cselect__option').count();
    assert(stationOptions >= 2, 'Journal station filter did not open.');
    await page.click('#btnCloseJournal');
    await page.waitForTimeout(150);
    trace('ui:journal');

    await page.click('#btnAchievements');
    await page.waitForSelector('#achievementsModal.modal--open');
    const achievementCards = await page.locator('#achievementsList .achievementCard').count();
    assert(achievementCards >= 8, 'Achievements modal did not render cards.');
    await page.click('#btnCloseAchievements');
    await page.waitForTimeout(150);
    trace('ui:achievements');

    await page.click('#btnReports');
    await page.waitForSelector('#reportsModal.modal--open');
    const beforeFrom = await page.locator('#reportDateFrom').inputValue();
    await page.click('[data-report-preset="month"]');
    await page.waitForTimeout(200);
    const afterFrom = await page.locator('#reportDateFrom').inputValue();
    assert(beforeFrom !== '' && afterFrom !== '', 'Report date fields are empty.');
    assert(beforeFrom !== afterFrom || beforeFrom.endsWith('-01'), 'Month preset did not update report range.');
    await page.click('#btnCloseReports');
    await page.waitForTimeout(150);
    trace('ui:reports');

    await page.click('#btnSettings');
    await page.waitForSelector('#pinModal.modal--open');
    await page.fill('#pinInput', SETTINGS_PIN);
    await page.click('#btnPinSubmit');
    await page.waitForSelector('#settingsModal.modal--open');
    const settingsVisible = await page.locator('#settingsModal').evaluate((node) => node.classList.contains('modal--open'));
    assert(settingsVisible, 'Settings modal did not open after PIN.');
    await page.click('#btnCloseSettings');
    await page.waitForTimeout(150);
    trace('ui:settings');

    assert(consoleErrors.length === 0, `Console errors detected: ${consoleErrors.join(' | ')}`);
    assert(downloads.length >= 1, 'Lifecycle smoke should trigger at least one export download during close shift.');
    trace('smoke:success');
    console.log('[ok] playwright smoke check passed: station-selection-restore, lifecycle-start-extend-stop-restore-close-shift, journal, achievements, reports, settings-pin-open');
  } finally {
    trace('smoke:cleanup');
    if (context) await context.close();
    if (browser) await browser.close();
    if (server) await server.cleanup();
  }
})().catch((error) => {
  const detail = error && (error.stack || error.message || String(error));
  console.error(`[fail] ${detail}`);
  process.exit(1);
});

