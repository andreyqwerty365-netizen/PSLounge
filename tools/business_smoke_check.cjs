"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
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
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pslounge-business-smoke-"));
  const venvPython = path.join(root, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  const python = process.env.PS_LOUNGE_PYTHON || (fs.existsSync(venvPython) ? venvPython : "python");
  const server = spawn(python, ["tools/business_test_server.py", "--port", String(port)], {
    cwd: root,
    env: { ...process.env, PS_LOUNGE_DATA_DIR: directory },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  for (const stream of [server.stdout, server.stderr]) stream.on("data", (data) => { output = (output + data).slice(-64000); });
  const exited = new Promise((resolve) => server.once("close", resolve));
  let spawnError;
  server.on("error", (error) => { spawnError = error; });
  let browser;
  try {
    const url = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (spawnError) throw spawnError;
      if (server.exitCode !== null) throw Error(output);
      try { ready = (await (await fetch(url + "/health")).text()) === "OK:PSLOUNGE"; } catch {}
      if (ready) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(ready, `Business test server did not become ready: ${output}`);
    const executablePath = process.env.PS_LOUNGE_CHROMIUM || (process.platform === "linux" && fs.existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined);
    browser = await chromium.launch({ executablePath, headless: true });
    const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
    const errors = [];
    page.on("pageerror", (error) => { errors.push(error.stack); console.error("[pageerror]", error.stack); });
    page.on("dialog", (dialog) => dialog.accept());
    const apiFailures = [];
    page.on("response", (response) => { if (response.url().includes("/api/") && response.status() >= 500) apiFailures.push(`${response.status()} ${response.url()}`); });
    async function api(route) {
      const response = await page.request.get(url + route);
      assert.equal(response.status(), 200, `${route}: ${await response.text()}`);
      return response.json();
    }
    async function business() { return api("/api/business"); }
    async function waitForState(predicate, description) {
      const deadline = Date.now() + 10000;
      let value;
      do {
        value = await business();
        if (predicate(value)) return value;
        await new Promise((resolve) => setTimeout(resolve, 100));
      } while (Date.now() < deadline);
      throw Error(`${description}; last state: ${JSON.stringify({
        activeShift: value.activeShift?.id || null,
        products: value.products.map(({ id, stock }) => ({ id, stock })),
        customers: value.customers.map(({ id, minutes }) => ({ id, minutes })),
        paymentCount: value.payments.length,
      })}`);
    }
    async function waitForIdle() {
      await page.waitForFunction(() => document.getElementById("businessDialog")?.getAttribute("aria-busy") !== "true");
    }
    async function tab(name) {
      await waitForIdle();
      if (!(await page.locator("#businessDialog").isVisible())) await page.locator("#btnBusiness").click();
      await page.locator(`#businessTabs [data-tab="${name}"]`).click();
    }
    async function submit(operation, fields, confirm = false) {
      await waitForIdle();
      const form = page.locator(`form[data-operation="${operation}"]`);
      for (const [name, value] of Object.entries(fields)) {
        const field = form.locator(`[name="${name}"]`);
        const tag = await field.evaluate((element) => element.tagName);
        if (typeof value === "boolean") await field.setChecked(value);
        else if (tag === "SELECT") await field.selectOption(String(value));
        else await field.fill(String(value));
      }
      const responsePromise = page.waitForResponse((response) =>
        new URL(response.url()).pathname === `/api/business/${operation}` && response.request().method() === "POST",
      );
      await form.locator('button[type="submit"]').click();
      if (confirm) {
        await page.locator("#businessConfirm").waitFor({ state: "visible" });
        await page.locator("#businessConfirmAccept").click();
      }
      const response = await responsePromise;
      assert.equal(response.status(), 200, `${operation}: ${await response.text()}`);
      // The committed HTTP response can arrive before refreshBusiness() and render().
      // Do not fill the next form until the UI has completed the whole operation.
      await waitForIdle();
    }

    await page.goto(url);
    await page.locator("#accountGate").waitFor({ state: "visible" });
    await page.locator('#accountForm [name="name"]').fill("Тестовый владелец");
    await page.locator('#accountForm [name="login"]').fill("smoke-owner");
    await page.locator('#accountForm [name="password"]').fill("isolated-test-password");
    await page.locator("#accountSubmit").click();
    await page.locator('#stations [data-station-id="1"]').waitFor({ state: "visible" });
    await tab("shift");
    await submit("shifts/open", { opening: "100.01" });
    await waitForState((value) => value.activeShift?.opening_cents === 10001, "Shift opens with exact starting cash");
    await page.locator("#businessClose").click();
    await page.locator('#stations [data-station-id="1"]').click();
    await page.locator("#btnStart").click();
    let value = await waitForState((state) => state.payments.some((payment) => payment.kind === "game" && payment.amount_cents > 0), "Gaming start writes a real payment");
    const gamingPayment = value.payments.find((payment) => payment.kind === "game" && payment.amount_cents > 0);
    let snapshot = await api("/api/backup");
    assert.equal(snapshot.stations[0].status, "running");
    assert.equal(Object.values(snapshot.sessions).flat()[0].sales.length, 1);
    const today = await page.evaluate(() => new Date().toLocaleDateString("en-CA"));
    const exportResponse = await page.request.get(url + `/api/export/today.xlsx?date=${today}`);
    assert.equal(exportResponse.status(), 200);
    assert.ok(exportResponse.headers()["content-type"].includes("spreadsheetml"));
    assert.equal((await exportResponse.body()).subarray(0, 2).toString(), "PK");
    console.log("[ok] isolated owner setup, real shift, gaming receipt and XLSX export");

    await tab("products");
    await submit("products/save", { name: "Напиток тестовый", price: "12.35", stock: 3, reason: "Поставка" });
    value = await waitForState((state) => state.products.some((product) => product.name === "Напиток тестовый"), "Product is created");
    const product = value.products.find((item) => item.name === "Напиток тестовый");
    await submit("products/sell", { productId: product.id, quantity: 2, method: "cash" });
    value = await waitForState((state) => state.products.find((item) => item.id === product.id)?.stock === 1, "Product sale reduces stock");
    const productPayment = value.payments.find((payment) => payment.kind === "product" && payment.product_id === product.id);
    assert.equal(productPayment.amount_cents, 2470);
    assert.equal(value.activeShift.expected_cents, 10001 + gamingPayment.amount_cents + 2470);

    await tab("passes");
    await submit("customers/create", { name: "Тестовый гость", contact: "test@example.invalid" });
    value = await waitForState((state) => state.customers.some((customer) => customer.name === "Тестовый гость"), "Customer is created");
    const customer = value.customers.find((item) => item.name === "Тестовый гость");
    await submit("passes/sell", { customerId: customer.id, minutes: 120, amount: "300.01", method: "card" });
    await waitForState((state) => state.customers.find((item) => item.id === customer.id)?.minutes === 120, "Pass sale credits minutes");
    await submit("passes/redeem", { customerId: customer.id, stationId: 2, minutes: 30 });
    value = await waitForState((state) => state.customers.find((item) => item.id === customer.id)?.minutes === 90, "Pass redemption debits minutes");
    snapshot = await api("/api/backup");
    assert.equal(snapshot.stations.find((station) => station.id === 2).status, "running");
    assert.equal(Object.values(snapshot.sessions).flat().filter((session) => session.stationId === 2)[0].sales[0].type, "pass_minutes");

    await tab("ledger");
    await page.locator(`[data-action="refund"][data-id="${productPayment.id}"]`).click();
    await submit("refund", { amount: "24.70", reason: "Полный возврат товара", restock: true }, true);
    value = await waitForState((state) => state.products.find((item) => item.id === product.id)?.stock === 3, "Full refund returns product to stock");
    assert.equal(value.payments.find((payment) => payment.id === productPayment.id).amount_cents, 2470);
    assert.equal(value.payments.filter((payment) => payment.parent_id === productPayment.id).length, 1);
    assert.equal(value.activeShift.expected_cents, 10001 + gamingPayment.amount_cents);
    console.log("[ok] real inventory sales, memberships, pass redemption and immutable refund");

    const paymentsBeforeClose = value.payments.map((payment) => payment.id).sort();
    const sessionsBeforeClose = Object.values(snapshot.sessions).flat().map((session) => session.id).sort();
    await tab("shift");
    const actual = ((value.activeShift.expected_cents - 100) / 100).toFixed(2);
    await submit("shifts/close", { actual, note: "Тестовое расхождение один рубль" }, true);
    value = await waitForState((state) => state.activeShift === null, "Shift closes after cash reconciliation");
    assert.equal(value.shifts[0].difference_cents, -100);
    assert.deepEqual(value.payments.map((payment) => payment.id).sort(), paymentsBeforeClose);
    await page.locator("#businessClose").click();
    await page.reload();
    await page.locator('#stations [data-station-id="1"]').waitFor({ state: "visible" });
    snapshot = await api("/api/backup");
    value = await business();
    assert.deepEqual(Object.values(snapshot.sessions).flat().map((session) => session.id).sort(), sessionsBeforeClose);
    assert.deepEqual(value.payments.map((payment) => payment.id).sort(), paymentsBeforeClose);
    assert.equal(value.shifts[0].difference_cents, -100);
    assert.equal(snapshot.stations.find((station) => station.id === 1).status, "running");
    assert.equal(snapshot.stations.find((station) => station.id === 2).status, "running");
    await tab("users");
    await submit("users/create", { name: "Тестовый оператор", login: "smoke-operator", password: "isolated-operator-password", role: "operator" });
    await waitForState((state) => state.users.some((user) => user.login === "smoke-operator"), "Owner creates operator through UI");
    await page.locator("#businessClose").click();
    await page.locator("#btnAccountLogout").click();
    await page.locator("#businessConfirmAccept").click();
    await page.locator("#accountGate").waitFor({ state: "visible" });
    await page.locator('#accountForm [name="login"]').fill("smoke-operator");
    await page.locator('#accountForm [name="password"]').fill("isolated-operator-password");
    await page.locator("#accountSubmit").click();
    await page.locator('#stations [data-station-id="1"]').waitFor({ state: "visible" });
    value = await business();
    assert.equal(value.user.role, "operator");
    assert.deepEqual(value.users, []);
    assert.deepEqual(value.audit, []);
    assert.equal(await page.locator("#btnSettings").getAttribute("hidden"), "");
    await tab("shift");
    assert.equal(await page.locator('#businessTabs [data-tab="users"]').count(), 0);
    assert.equal(await page.locator('#businessTabs [data-tab="backups"]').count(), 0);
    const deniedBackup = await page.request.get(url + "/api/business-backup.sqlite3");
    assert.equal(deniedBackup.status(), 403);
    assert.equal((await deniedBackup.json()).error, "owner_required");
    await submit("shifts/open", { opening: "0" });
    value = await waitForState((state) => state.activeShift?.opened_by === state.user.id, "Operator opens their own shift");
    assert.equal(value.activeShift.expected_cents, 0);
    assert.deepEqual(value.payments, [], "Operator sees only their own receipts");
    console.log("[ok] owner creates operator; logout/login enforces restricted UI and own shift");
    assert.deepEqual(errors, [], "Business workflow has no JavaScript exceptions");
    assert.deepEqual(apiFailures, [], "Business workflow has no backend 500 responses");
    console.log("[ok] reconciled close preserves receipts and sessions after reload");
  } catch (error) {
    const serverErrors = output.split("\n").filter((line) => /Traceback|Error|Exception|HTTP\/1\.1.* [45]\d\d/.test(line)).slice(-12);
    if (serverErrors.length) console.error("Business server errors:\n" + serverErrors.join("\n"));
    const activePage = browser?.contexts()[0]?.pages()[0];
    if (activePage && !activePage.isClosed()) {
      const uiErrors = await activePage.locator(".businessError").allTextContents().catch(() => []);
      if (uiErrors.some((text) => text.trim())) console.error("UI errors:", uiErrors.filter((text) => text.trim()));
    }
    throw error;
  } finally {
    if (browser) await browser.close();
    if (server.exitCode === null) server.kill();
    await exited;
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
