"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const { spawn } = require("node:child_process");
const { chromium } = require("playwright");
const root = path.resolve(__dirname, "..");

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function main() {
  const port = await freePort();
  const venvPython = path.join(
    root,
    ".venv",
    process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
  );
  const python =
    process.env.PS_LOUNGE_PYTHON ||
    (fs.existsSync(venvPython) ? venvPython : "python");
  const server = spawn(
    python,
    [
      "-m",
      "flask",
      "--app",
      "main",
      "run",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--no-reload",
    ],
    { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  server.stdout.on("data", (data) => {
    output += data;
  });
  server.stderr.on("data", (data) => {
    output += data;
  });
  const exited = new Promise((resolve) => server.once("close", resolve));
  let spawnError;
  server.on("error", (error) => {
    spawnError = error;
  });
  let browser;
  try {
    const url = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let attempt = 0; attempt < 80; attempt++) {
      if (spawnError) throw spawnError;
      if (server.exitCode !== null) throw Error(output);
      try {
        ready = (await (await fetch(url + "/health")).text()) === "OK:PSLOUNGE";
      } catch {}
      if (ready) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(ready, `Server did not become ready: ${output}`);
    const executablePath =
      process.env.PS_LOUNGE_CHROMIUM ||
      (process.platform === "linux" && fs.existsSync("/usr/bin/chromium")
        ? "/usr/bin/chromium"
        : undefined);
    browser = await chromium.launch({ executablePath, headless: true });
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => {
      errors.push(error.stack);
      console.error("[pageerror]", error.stack);
    });
    await page.goto(url);
    await page.locator("#licenseGate").waitFor({ state: "visible" });
    assert.deepEqual(
      errors,
      [],
      "Unlicensed startup must load all modules successfully",
    );
    console.log("[ok] real HTTP startup and unlicensed gate");

    // UI integration uses HTTP test doubles, not a signed license or production data.
    let backup = { lastModified: 0, source: "default" };
    await page.route("**/api/license/status", (route) =>
      route.fulfill({
        json: { ok: true, licensed: true, machineFingerprintLabel: "UI test" },
      }),
    );
    const testUser = { id: 'ui-owner', name: 'UI owner', login: 'owner', role: 'owner', active: 1 };
    await page.route('**/api/accounts/status', route => route.fulfill({ json: { ok: true, configured: true, user: testUser, csrf: 'ui-csrf' } }));
    await page.route('**/api/business', route => route.fulfill({ json: { ok: true, user: testUser,
      activeShift: { id: 'ui-shift', opened_by: testUser.id, operator: testUser.name, opened_at: Date.now(),
        opening_cents: 0, totals: { cash: 0, card: 0, transfer: 0 }, expected_cents: 0, revenue_cents: 0 },
      shifts: [], products: [], customers: [], payments: [], users: [testUser], audit: [], totals: [] } }));
    let revision = 0;
    await page.route("**/api/backup", async (route) => {
      if (route.request().method() === "POST") {
        backup = { ...route.request().postDataJSON(), source: "primary", revision: revision + 1 };
        await route.fulfill({ json: { ok: true, revision: ++revision } });
      } else await route.fulfill({ json: backup });
    });
    await page.locator("#btnLicenseRetry").click();
    await page.locator('[data-station-id="1"]').waitFor({ timeout: 5000 });
    assert.equal(await page.locator("#stations [data-station-id]").count(), 6);
    await page.locator('[data-station-id="1"]').click();
    await page.locator("#btnStart").click();
    await page.waitForFunction(
      () =>
        JSON.parse(localStorage.getItem("pslounge_stations_v7"))[0].status ===
        "running",
    );
    await page.locator("#btnPaidAdd30").click();
    await page.waitForFunction(
      () =>
        Object.values(
          JSON.parse(localStorage.getItem("pslounge_sessions_v7")),
        ).flat()[0].sales.length === 2,
    );
    const active = await page.evaluate(
      () =>
        Object.values(
          JSON.parse(localStorage.getItem("pslounge_sessions_v7")),
        ).flat()[0],
    );
    assert.equal(
      active.totalAmount,
      active.sales.reduce((sum, sale) => sum + sale.amount, 0),
    );
    await page.locator("#btnReports").click();
    await page.locator("#reportsModal.modal--open").waitFor();
    assert.ok(
      (await page.locator("#reportRevenue").innerText()).includes(
        String(active.totalAmount),
      ),
    );
    await page.locator("#btnCloseReports").click();
    page.on("dialog", (dialog) => dialog.accept());
    await page.locator("#btnStop").click();
    await page.waitForFunction(
      () =>
        JSON.parse(localStorage.getItem("pslounge_stations_v7"))[0].status ===
        "idle",
    );
    await page.locator("#btnRestoreLast").click();
    await page.waitForFunction(
      () =>
        JSON.parse(localStorage.getItem("pslounge_stations_v7"))[0].status ===
        "running",
    );
    await page.locator("#btnSettings").click();
    await page.locator("#pinModal.modal--open").waitFor();
    await page.locator("#pinInput").fill("4826");
    await page.locator("#btnPinSubmit").click();
    await page.locator("#settingsModal.modal--open").waitFor();
    await page.locator("#btnAddStation").click();
    await page.locator("#btnSaveSettings").click();
    await page.waitForFunction(
      () =>
        JSON.parse(localStorage.getItem("pslounge_stations_v7")).length === 7,
    );
    await page.locator("#btnCloseSettings").click();
    await page.reload();
    await page.locator('[data-station-id="1"]').waitFor({ timeout: 5000 });
    assert.equal(
      await page.evaluate(
        () =>
          JSON.parse(localStorage.getItem("pslounge_stations_v7"))[0].status,
      ),
      "running",
    );
    assert.equal(await page.locator("#stations [data-station-id]").count(), 7);
    assert.deepEqual(errors, [], "No JavaScript exceptions during UI workflow");
    console.log(
      "[ok] UI test doubles: start, paid extension, reports, stop, restore, PIN, add station, reload",
    );
  } finally {
    if (browser) await browser.close();
    if (server.exitCode === null) server.kill();
    await exited;
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
