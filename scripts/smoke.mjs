#!/usr/bin/env node
// Smoke test against a deployed TOS (Azure or docker compose). No dependencies.
// Seeds the demo tenant on first run (idempotent), then runs one vessel call: discharge -> gate-out -> invoice.
// Env: BASE_URL (API), KC_URL (Keycloak), DEMO_PASSWORD
const BASE = process.env.BASE_URL?.replace(/\/$/, '');
const KC = process.env.KC_URL?.replace(/\/$/, '');
const PW = process.env.DEMO_PASSWORD;
if (!BASE || !KC || !PW) {
  console.error('BASE_URL, KC_URL and DEMO_PASSWORD are required');
  process.exit(2);
}
const FAC = 'MPT1';
let failures = 0;

async function token(realm, user) {
  const r = await fetch(`${KC}/realms/${realm}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'password', client_id: 'tos-cli', username: user, password: PW }),
  });
  if (!r.ok) throw new Error(`token ${realm}/${user}: ${r.status} ${await r.text()}`);
  return (await r.json()).access_token;
}

async function call(tok, method, path, body, { facility = FAC, ok = [200, 201] } = {}) {
  const headers = { Authorization: `Bearer ${tok}` };
  if (facility) headers['X-Facility'] = facility;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const r = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  const json = text ? JSON.parse(text) : null;
  if (!ok.includes(r.status)) throw new Error(`${method} ${path}: ${r.status} ${text}`);
  return { status: r.status, body: json };
}

async function step(name, fn) {
  const t0 = Date.now();
  try {
    const out = await fn();
    console.log(`ok   ${name} (${Date.now() - t0} ms)`);
    return out;
  } catch (e) {
    failures++;
    console.log(`FAIL ${name}: ${e.message}`);
    throw e;
  }
}

function iso6346(prefix, serial) {
  const first10 = `${prefix}${String(serial).padStart(6, '0')}`;
  const vals = {};
  let v = 10;
  for (const ch of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') { if (v % 11 === 0) v++; vals[ch] = v++; }
  let sum = 0;
  for (let i = 0; i < 10; i++) sum += (/[0-9]/.test(first10[i]) ? Number(first10[i]) : vals[first10[i]]) * 2 ** i;
  return first10 + ((sum % 11) % 10);
}

async function main() {
  await step('health', async () => {
    const r = await fetch(`${BASE}/health`);
    const j = await r.json();
    if (j.status !== 'ok') throw new Error(JSON.stringify(j));
  });
  await step('rejects anonymous calls', async () => {
    const r = await fetch(`${BASE}/v1/tenant`);
    if (r.status !== 401) throw new Error(`expected 401, got ${r.status}`);
  });

  const platform = await step('platform operator signs in', () => token('platform', 'operator'));
  await step('demo tenant provisioned', () =>
    call(platform, 'POST', '/v1/platform/tenants', { code: 'demo', name: 'Demo Port Co', oidcIssuer: `${KC}/realms/demo` }, { facility: null, ok: [201, 409] }));

  const admin = await step('demo admin signs in', () => token('demo', 'admin'));
  await step('master data in place', async () => {
    const o = { facility: null, ok: [201, 409] };
    await call(admin, 'POST', '/v1/complexes', { code: 'KHL', name: 'Demo Port Complex' }, o);
    await call(admin, 'POST', '/v1/facilities', { complexCode: 'KHL', code: FAC, name: 'Multipurpose Terminal 1', unlocode: 'AEKHL', currency: 'AED', timezone: 'Asia/Dubai' }, o);
    await call(admin, 'POST', '/v1/yards', { facilityCode: FAC, code: 'Y1', name: 'Main yard' }, o);
    await call(admin, 'POST', '/v1/yard-blocks', { facilityCode: FAC, yardCode: 'Y1', code: 'A1', blockType: 'CONTAINER_STACK', bays: 40, rows: 6, tiers: 4 }, o);
    await call(admin, 'POST', '/v1/yard-blocks', { facilityCode: FAC, yardCode: 'Y1', code: 'L1', blockType: 'LAYDOWN', capacity: 500 }, o);
    await call(admin, 'POST', '/v1/yard-blocks', { facilityCode: FAC, yardCode: 'Y1', code: 'R1', blockType: 'RORO_LANE', capacity: 1000 }, o);
    await call(admin, 'POST', '/v1/partners', { code: 'MSC', name: 'Mediterranean Shipping Co', roles: ['LINE_OPERATOR', 'CUSTOMER'] }, o);
    await call(admin, 'POST', '/v1/vessels', { imo: '9321483', name: 'MSC AURORA' }, o);
    const tariffs = (await call(admin, 'GET', '/v1/tariffs')).body;
    if (!tariffs.length) {
      await call(admin, 'POST', '/v1/tariffs', { chargeCode: 'DISCH', description: 'Container discharge', cargoKind: 'CONTAINER', triggerEvent: 'unit.discharged', basis: 'PER_TEU', rate: 50, currency: 'AED', validFrom: '2026-01-01' });
      await call(admin, 'POST', '/v1/tariffs', { chargeCode: 'LIFT', description: 'Lift on to truck', cargoKind: 'CONTAINER', triggerEvent: 'unit.gated-out', basis: 'PER_UNIT', rate: 20, currency: 'AED', validFrom: '2026-01-01' });
      await call(admin, 'POST', '/v1/tariffs', { chargeCode: 'STOR', description: 'Import storage', cargoKind: 'CONTAINER', triggerEvent: 'storage', basis: 'PER_DAY', rate: 10, currency: 'AED', freeDays: 3, validFrom: '2026-01-01' });
    }
  });

  const run = Date.now().toString(36).toUpperCase();
  const box = iso6346('MSCU', Number(Date.now() % 1_000_000));
  const visit = await step(`vessel call SMK-${run}`, async () => {
    const v = await call(admin, 'POST', '/v1/visits', { visitRef: `SMK-${run}`, imo: '9321483', lineOperator: 'MSC', voyageIn: `S${run}` });
    await call(admin, 'POST', `/v1/visits/${v.body.id}/load-lists`, { items: [{ unitRef: box, isoType: '22G1', grossWeightKg: 20000, pod: 'AEKHL' }] });
    await call(admin, 'POST', `/v1/visits/${v.body.id}/arrive`, { berth: 'B1' });
    return v.body;
  });
  await step(`discharge ${box}`, () => call(admin, 'POST', `/v1/visits/${visit.id}/discharges`, { unitRef: box, cheId: 'QC01' }));
  await step('COARRI generated', async () => {
    const r = await fetch(`${BASE}/v1/edi/outbound/coarri/${visit.id}`, { headers: { Authorization: `Bearer ${admin}`, 'X-Facility': FAC } });
    const t = await r.text();
    if (!r.ok || !t.includes(box)) throw new Error(`${r.status} ${t.slice(0, 200)}`);
  });
  await step('gate-out', async () => {
    const r = await call(admin, 'POST', '/v1/gate/transactions', { direction: 'OUT', unitRef: box, truckPlate: 'SMOKE-1' });
    if (r.body.status !== 'COMPLETED') throw new Error(JSON.stringify(r.body));
  });
  await step('invoice issued', async () => {
    const r = await call(admin, 'POST', '/v1/invoices', { customer: 'MSC' });
    const total = r.body.invoices.reduce((s, i) => s + Number(i.total), 0);
    if (!(total > 0)) throw new Error(JSON.stringify(r.body));
    console.log(`     ${r.body.invoices.map((i) => `${i.invoiceNo} ${i.currency} ${i.total}`).join(', ')}`);
  });
  await step('tenant isolation: platform token cannot read tenant data', () => call(platform, 'GET', '/v1/facilities', undefined, { facility: null, ok: [403] }));
}

main()
  .then(() => { console.log(failures ? `${failures} failed` : 'smoke test passed'); process.exit(failures ? 1 : 0); })
  .catch(() => { console.log('smoke test failed'); process.exit(1); });
