/* Browser-only sandbox. No production API is unlocked or altered. */
(() => {
  const nativeFetch = window.fetch.bind(window);
  let originalStorage;
  try { originalStorage = window.localStorage; } catch {}
  const memory = new Map();
  const safeStorage = { getItem: key => { try { return originalStorage?.getItem(key) ?? memory.get(key) ?? null; } catch { return memory.get(key) ?? null; } },
    setItem: (key, value) => { memory.set(key, String(value)); try { originalStorage?.setItem(key, value); } catch {} },
    removeItem: key => { memory.delete(key); try { originalStorage?.removeItem(key); } catch {} } };
  const prefix = 'pslounge_demo:';
  const cache = { getItem: key => safeStorage.getItem(prefix + key),
    setItem: (key, value) => safeStorage.setItem(prefix + key, value),
    removeItem: key => safeStorage.removeItem(prefix + key) };
  try { Object.defineProperty(window, 'localStorage', { value: cache }); } catch {}
  const user = { id: 'demo-owner', login: 'demo', name: 'Демо-владелец', role: 'owner', active: 1 };
  let data;
  try { data = JSON.parse(cache.getItem('business')); } catch {}
  data ||= { state: { revision: 0, lastModified: 0, stations: null, sessions: null },
    products: [{ id: 'drink', name: 'Лимонад', price_cents: 12000, stock: 24, track_stock: 1, active: 1 },
      { id: 'snack', name: 'Снэк', price_cents: 9000, stock: 15, track_stock: 1, active: 1 }],
    customers: [{ id: 'guest', name: 'Демо-гость', contact: '', minutes: 120 }],
    payments: [], shifts: [], audit: [], users: [user], commands: {} };
  let signedIn = true;
  const id = () => globalThis.crypto?.randomUUID?.() || `demo-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const cents = value => Math.round(Number(value || 0) * 100);
  const save = () => cache.setItem('business', JSON.stringify(data));
  const reply = (value, status = 200) => new Response(JSON.stringify(value), { status,
    headers: { 'Content-Type': 'application/json' } });
  const fail = error => { throw new Error(error); };
  const active = () => data.shifts.find(shift => !shift.closed_at);
  const shiftSummary = shift => {
    if (!shift) return null;
    const totals = { cash: 0, card: 0, transfer: 0 }; let revenue = 0;
    data.payments.filter(p => p.shift_id === shift.id).forEach(p => {
      totals[p.method] += p.amount_cents;
      if (!['cash_in', 'cash_out'].includes(p.kind)) revenue += p.amount_cents;
    });
    const expected = shift.opening_cents + totals.cash;
    return { ...shift, totals, revenue_cents: revenue, expected_cents: expected,
      difference_cents: shift.actual_cents == null ? null : shift.actual_cents - expected };
  };
  const payment = (kind, amount, method, details = {}, extra = {}) => {
    const shift = active(); if (!shift) fail('shift_required');
    const value = { id: id(), shift_id: shift.id, actor_id: user.id, operator: user.name,
      created_at: Date.now(), kind, amount_cents: amount, method, refundable_cents: Math.max(0, amount), details, ...extra };
    data.payments.unshift(value); return value.id;
  };
  const command = (op, body) => {
    if (op === 'shifts/open') {
      if (active()) fail('shift_already_open');
      data.shifts.unshift({ id: id(), opened_at: Date.now(), opened_by: user.id,
        opening_cents: cents(body.opening), operator: user.name, closed_at: null, actual_cents: null });
    } else if (op === 'shifts/close') {
      const shift = active(); if (!shift) fail('shift_required');
      const expected = shiftSummary(shift).expected_cents;
      if (cents(body.actual) !== expected && !body.note) fail('difference_reason_required');
      Object.assign(shift, { closed_at: Date.now(), actual_cents: cents(body.actual), note: body.note });
    } else if (op === 'cash') {
      if (body.kind === 'cash_out' && cents(body.amount) > shiftSummary(active())?.expected_cents) fail('insufficient_cash');
      payment(body.kind, cents(body.amount) * (body.kind === 'cash_out' ? -1 : 1), 'cash', { reason: body.reason });
    } else if (op === 'products/save') {
      const existing = data.products.find(p => p.id === body.id);
      const value = { id: body.id || id(), name: body.name, price_cents: cents(body.price), stock: body.trackStock === false ? 0 : body.stock, track_stock: body.trackStock === false ? 0 : 1, active: body.active ?? true };
      if (existing) Object.assign(existing, value); else data.products.push(value);
    } else if (op === 'products/sell') {
      const product = data.products.find(p => p.id === body.productId);
      if (!product || (product.track_stock && product.stock < body.quantity)) fail('insufficient_stock');
      const pid = payment('product', product.price_cents * body.quantity, body.method, { name: product.name },
        { product_id: product.id, quantity: body.quantity });
      if (product.track_stock) product.stock -= body.quantity; return { ok: true, paymentId: pid };
    } else if (op === 'customers/create') {
      const customer = { id: id(), name: body.name, contact: body.contact || '', minutes: 0 };
      data.customers.push(customer); return { ok: true, customerId: customer.id };
    } else if (op === 'passes/sell') {
      const customer = data.customers.find(c => c.id === body.customerId); if (!customer) fail('customer_not_found');
      payment('pass', cents(body.amount), body.method, { name: customer.name, minutes: body.minutes }, { customer_id: customer.id });
      customer.minutes += body.minutes;
    } else if (op === 'passes/redeem') {
      const customer = data.customers.find(c => c.id === body.customerId);
      if (!customer || customer.minutes < body.minutes) fail('insufficient_minutes');
      if (!active()) fail('shift_required');
      if (body.baseRevision !== data.state.revision) fail('revision_conflict');
      const station = data.state.stations?.find(s => s.id === body.stationId); if (!station) fail('station_not_found');
      let record = Object.values(data.state.sessions || {}).flat().find(r => r.id === station.activeSessionId && !r.endTime);
      const time = Date.now();
      if (!record) {
        record = { id: id(), stationId: station.id, stationName: station.name, stationType: station.stationType,
          startTime: time, endTime: null, tariffId: 'pass', tariffLabel: 'Абонемент', totalAmount: 0, sales: [], paymentMethod: 'cash' };
        const day = body.day || new Date().toISOString().slice(0, 10);
        (data.state.sessions[day] ||= []).push(record);
        Object.assign(station, { startTime: time, activeSessionId: record.id, tariffId: 'pass', lastClosedSnapshot: null });
      }
      record.sales.push({ id: id(), time, type: 'pass_minutes', label: 'Абонемент', minutes: body.minutes,
        amount: 0, paymentMethod: 'cash', customerId: customer.id });
      Object.assign(station, { status: 'running', endTime: Math.max(station.endTime || time, time) + body.minutes * 60000 });
      customer.minutes -= body.minutes; data.state.revision++; data.state.lastModified = time;
      return { ok: true, state: data.state, revision: data.state.revision };
    } else if (op === 'refund') {
      const original = data.payments.find(p => p.id === body.paymentId);
      const amount = cents(body.amount);
      if (!original || amount > original.refundable_cents || amount <= 0) fail('refund_exceeds_payment');
      if (original.kind === 'pass') {
        const customer = data.customers.find(c => c.id === original.customer_id);
        if (amount !== original.amount_cents || customer.minutes < original.details.minutes) fail('pass_refund_requires_unused_full_pass');
        customer.minutes -= original.details.minutes;
      }
      payment('refund', -amount, original.method, { reason: body.reason }, { parent_id: original.id });
      original.refundable_cents -= amount;
      if (body.restock && original.product_id && data.products.find(p => p.id === original.product_id).track_stock) data.products.find(p => p.id === original.product_id).stock += original.quantity;
    } else if (op === 'users/create') {
      data.users.push({ id: id(), name: body.name, login: body.login, role: body.role, active: 1 });
    } else if (op === 'users/save') {
      Object.assign(data.users.find(u => u.id === body.id), { name: body.name, role: body.role, active: body.active });
    } else fail('not_found');
    return { ok: true };
  };
  window.fetch = async (input, options = {}) => {
    const path = new URL(typeof input === 'string' ? input : input.url, location.origin === 'null' ? 'https://pslounge-demo.invalid/' : location.href).pathname;
    if (!path.startsWith('/api/')) return nativeFetch(input, options);
    try {
      const body = options.body && typeof options.body === 'string' ? JSON.parse(options.body) : {};
      if (path === '/api/license/status') return reply({ ok: true, licensed: true, customer: 'Демонстрация', machineFingerprintLabel: 'DEMO' });
      if (path === '/api/accounts/status') return reply({ ok: true, configured: true, user: signedIn ? user : null, csrf: 'demo-csrf' });
      if (path === '/api/accounts/login') { signedIn = true; return reply({ ok: true, user, csrf: 'demo-csrf' }); }
      if (path === '/api/accounts/logout') { signedIn = false; return reply({ ok: true }); }
      if (path === '/api/business') return reply({ ok: true, user, activeShift: shiftSummary(active()),
        shifts: data.shifts.map(shiftSummary), products: data.products, customers: data.customers,
        payments: data.payments.slice(0, 100), audit: data.audit.slice(0, 100), users: data.users,
        totals: Object.values(data.payments.filter(p => !['cash_in', 'cash_out'].includes(p.kind)).reduce((groups, p) => {
          const key = p.kind + p.method; groups[key] ||= { kind: p.kind, method: p.method, cents: 0, imported: 0 };
          groups[key].cents += p.amount_cents; return groups;
        }, {})) });
      if (path === '/api/backup') {
        if (options.method === 'POST') {
          const key = new Headers(options.headers).get('X-Idempotency-Key');
          if (data.commands[key]) return reply(data.commands[key]);
          if (body.baseRevision !== data.state.revision) return reply({ error: 'revision_conflict' }, 409);
          const known = new Set(data.payments.map(p => p.source_key));
          const old = new Set(Object.values(data.state.sessions || {}).flat().flatMap(r => (r.sales || []).map(s => r.id + s.id)));
          for (const records of Object.values(body.sessions || {})) for (const rec of records) for (const sale of rec.sales || []) {
            const source = rec.id + sale.id;
            if (!known.has(source) && !old.has(source) && Number(sale.amount) > 0)
              payment('game', cents(sale.amount), sale.paymentMethod || 'cash', { sale, sessionId: rec.id }, { source_key: source });
          }
          data.state = { ...body, revision: data.state.revision + 1, source: 'demo' };
          const result = { ok: true, revision: data.state.revision }; data.commands[key] = result; save(); return reply(result);
        }
        return reply(data.state);
      }
      if (path.startsWith('/api/business/')) {
        const key = new Headers(options.headers).get('X-Idempotency-Key'); if (data.commands[key]) return reply(data.commands[key]);
        // A browser sandbox also rolls back failed commands.
        const before = structuredClone(data);
        let result;
        try { result = command(path.slice('/api/business/'.length), body); }
        catch (error) { data = before; throw error; }
        data.audit.unshift({ id: id(), created_at: Date.now(), operator: user.name,
          action: path.split('/').slice(3).join('/'), details: '{}' });
        data.commands[key] = result; save(); return reply(result);
      }
      return reply({ ok: false, error: 'demo_export_unavailable' }, 501);
    } catch (error) { return reply({ ok: false, error: error.message }, 400); }
  };
})();
